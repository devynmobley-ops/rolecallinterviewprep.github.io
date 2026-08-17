const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const { AdzunaSource } = require('./jobs/sources/AdzunaSource');
const { normalizeJob, toFirestoreJob } = require('./jobs/normalizer');
const { findDuplicate, mergeJobs, processJobs } = require('./jobs/deduplicator');

admin.initializeApp();

// Helper: check if user has active subscription (Stripe or promo code)
async function checkUserSubscription(uid) {
  // Check Stripe subscriptions
  const subSnap = await admin.firestore()
    .collection('customers').doc(uid)
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing'])
    .get();
  if (!subSnap.empty) return true;

  // Check promo code access
  const custDoc = await admin.firestore().collection('customers').doc(uid).get();
  if (custDoc.exists && custDoc.data().promoCode) {
    const promoExp = custDoc.data().promoExpiresAt;
    if (!promoExp || promoExp.toDate() > new Date()) return true;
  }

  return false;
}

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

// Create a Stripe Checkout Session
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const priceId = data.priceId;

  if (!priceId) {
    throw new functions.https.HttpsError('invalid-argument', 'priceId required');
  }

  // Get or create Stripe customer
  const customerSnap = await admin.firestore().collection('customers').doc(uid).get();

  let customerId;
  if (customerSnap.exists && customerSnap.data().stripeCustomerId) {
    customerId = customerSnap.data().stripeCustomerId;
  } else {
    const customer = await getStripe().customers.create({
      email: context.auth.token.email,
      metadata: { firebaseUID: uid }
    });
    customerId = customer.id;
    await admin.firestore().collection('customers').doc(uid).set(
      { stripeCustomerId: customerId }, { merge: true }
    );
  }

  // Create Checkout Session
  let session;
  try {
    session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://rollcallinterviewprep.com/?checkout=success',
      cancel_url: 'https://rollcallinterviewprep.com/?checkout=cancel',
      subscription_data: {
        trial_period_days: 7,
      },
    });
  } catch (err) {
    if (err.code === 'resource_missing') {
      // Old test customer ID doesn't exist in live mode — create new customer
      const customer = await getStripe().customers.create({
        email: context.auth.token.email,
        metadata: { firebaseUID: uid }
      });
      customerId = customer.id;
      await admin.firestore().collection('customers').doc(uid).set(
        { stripeCustomerId: customerId }, { merge: true }
      );
      session = await getStripe().checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: 'https://rollcallinterviewprep.com/?checkout=success',
        cancel_url: 'https://rollcallinterviewprep.com/?checkout=cancel',
        subscription_data: {
          trial_period_days: 7,
        },
      });
    } else {
      throw err;
    }
  }

  return { url: session.url };
});

// Receive Stripe webhook events and write subscription status to Firestore
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(
      req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const customerId = data.customer;
      const subscriptionId = data.subscription;

      const customer = await getStripe().customers.retrieve(customerId);
      const uid = customer.metadata.firebaseUID;

      const subscription = await getStripe().subscriptions.retrieve(subscriptionId);

      await admin.firestore()
        .collection('customers').doc(uid)
        .collection('subscriptions').doc(subscriptionId)
        .set({
          status: subscription.status,
          priceId: subscription.items.data[0].price.id,
          currentPeriodStart: admin.firestore.Timestamp.fromDate(
            new Date(subscription.current_period_start * 1000)
          ),
          currentPeriodEnd: admin.firestore.Timestamp.fromDate(
            new Date(subscription.current_period_end * 1000)
          ),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        });
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const customerId = data.customer;
      const customer = await getStripe().customers.retrieve(customerId);
      const uid = customer.metadata.firebaseUID;

      await admin.firestore()
        .collection('customers').doc(uid)
        .collection('subscriptions').doc(data.id)
        .set({
          status: data.status,
          priceId: data.items.data[0].price.id,
          currentPeriodStart: admin.firestore.Timestamp.fromDate(
            new Date(data.current_period_start * 1000)
          ),
          currentPeriodEnd: admin.firestore.Timestamp.fromDate(
            new Date(data.current_period_end * 1000)
          ),
          cancelAtPeriodEnd: data.cancel_at_period_end,
        }, { merge: true });
      break;
    }

    case 'invoice.payment_failed': {
      const customerId = data.customer;
      const customer = await getStripe().customers.retrieve(customerId);
      const uid = customer.metadata.firebaseUID;

      const subId = data.subscription;
      await admin.firestore()
        .collection('customers').doc(uid)
        .collection('subscriptions').doc(subId)
        .set({ status: 'past_due' }, { merge: true });
      break;
    }
  }

  res.json({ received: true });
});

// Create a Stripe Customer Portal session for managing subscriptions
exports.createPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const customerSnap = await admin.firestore().collection('customers').doc(uid).get();

  if (!customerSnap.exists || !customerSnap.data().stripeCustomerId) {
    throw new functions.https.HttpsError('not-found', 'No Stripe customer found');
  }

  const customerId = customerSnap.data().stripeCustomerId;

  const portalSession = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: 'https://rollcallinterviewprep.com/',
  });

  return { url: portalSession.url };
});

// Submit a mock score for percentile comparison
exports.submitMockScore = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { role, avgScore } = data;
  if (!role || typeof avgScore !== 'number') {
    throw new functions.https.HttpsError('invalid-argument', 'role and avgScore required');
  }

  const docRef = admin.firestore().collection('roleScores').doc(role);
  const doc = await docRef.get();

  let scores = [];
  if (doc.exists && doc.data().scores) {
    scores = doc.data().scores;
  }

  scores.push(avgScore);
  // Cap at 200 entries
  if (scores.length > 200) {
    scores = scores.slice(-200);
  }

  const totalAttempts = scores.length;
  const sum = scores.reduce((a, b) => a + b, 0);
  const roleAvg = sum / totalAttempts;

  await docRef.set({ scores, count: totalAttempts, avg: roleAvg }, { merge: true });

  // Compute percentile: what % of stored scores are below the user's score
  const belowCount = scores.filter(s => s < avgScore).length;
  const percentile = Math.round((belowCount / totalAttempts) * 100);

  return { percentile, totalAttempts, roleAvg: Math.round(roleAvg * 10) / 10 };
});

// Server-side subscription check (fallback)
exports.checkSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const subscriptionsSnap = await admin.firestore()
    .collection('customers').doc(uid)
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing'])
    .get();

  return { isSubscribed: !subscriptionsSnap.empty };
});

// Newsletter signup — saves to Firestore + adds to Brevo mailing list
exports.subscribeNewsletter = functions.https.onCall(async (data, context) => {
  const { email } = data;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new functions.https.HttpsError('invalid-argument', 'Valid email required');
  }

  // Save to Firestore
  await admin.firestore().collection('newsletter').add({
    email: email.toLowerCase().trim(),
    subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Add to Brevo list
  try {
    const resp = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        listIds: [2],
        updateEnabled: true,
      }),
    });
    if (!resp.ok && resp.status !== 400) {
      // 400 = contact already exists, which is fine
      console.error('Brevo error:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('Brevo request failed:', err.message);
  }

  return { success: true };
});

// Resume Tailoring — PDF + job description → Claude Haiku analysis
exports.tailorResume = functions.runWith({ secrets: ['ANTHROPIC_API_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Check subscription (Stripe or promo code)
  const uid = context.auth.uid;
  const hasSub = await checkUserSubscription(uid);
  if (!hasSub) {
    throw new functions.https.HttpsError('permission-denied', 'Pro subscription required');
  }

  const { resumeBase64, jobDescription } = data;
  if (!resumeBase64 || !jobDescription) {
    throw new functions.https.HttpsError('invalid-argument', 'resumeBase64 and jobDescription required');
  }

  // Parse PDF
  const pdfParse = require('pdf-parse');
  const pdfBuffer = Buffer.from(resumeBase64, 'base64');
  let resumeText;
  try {
    const pdfData = await pdfParse(pdfBuffer);
    resumeText = pdfData.text;
  } catch (err) {
    console.error('PDF parse error:', err.message);
    throw new functions.https.HttpsError('invalid-argument', 'Could not parse PDF. Please upload a valid resume.');
  }

  if (!resumeText || resumeText.trim().length < 50) {
    throw new functions.https.HttpsError('invalid-argument', 'Resume text is too short or empty. Please upload a text-based PDF.');
  }

  // Call Claude Haiku via direct API
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    throw new functions.https.HttpsError('internal', 'API configuration error');
  }

  let analysis;
  try {
    const prompt = `You are a professional resume writer. Given the user's existing resume and a job description, REWRITE the resume to be tailored for that specific job. Preserve all factual information — do not fabricate experience, degrees, or credentials. But reword, reorder, and restructure everything to align with the job description.

RESUME:
${resumeText.substring(0, 8000)}

JOB DESCRIPTION:
${jobDescription.substring(0, 4000)}

Respond in this exact JSON format (no markdown, just raw JSON):
{
  "matchScore": <number 0-100 representing how well the original resume matched>,
  "summary": "<2-3 sentence assessment of the original fit>",
  "changesSummary": [
    "<key change 1 — e.g. 'Rewrote professional summary to emphasize project management experience'>",
    "<key change 2>",
    "<key change 3>"
  ],
  "resume": {
    "header": {
      "name": "<full name from resume>",
      "title": "<professional title or headline, tailored to the job>",
      "contact": ["<email>", "<phone>", "<location>", "<linkedin if present>"]
    },
    "summary": "<3-4 sentence professional summary rewritten to emphasize the most relevant qualifications for this specific job>",
    "experience": [
      {
        "company": "<company name>",
        "title": "<job title>",
        "dates": "<date range>",
        "bullets": ["<rewritten bullet emphasizing relevant skills/keywords from the job description>", "..."]
      }
    ],
    "education": [
      {
        "school": "<school name>",
        "degree": "<degree and major>",
        "dates": "<date range or graduation year>"
      }
    ],
    "skills": ["<most relevant skill for the job first>", "..."],
    "certifications": ["<certification name>", "..."]
  }
}

Rules:
- Rewrite ALL bullet points to emphasize skills and keywords from the job description
- Reorder skills so the most job-relevant ones appear first
- Tailor the professional summary to the specific role
- If the resume has sections not listed above (projects, volunteer work, awards), include them under "experience" or as a new field
- Do NOT invent experience, degrees, certifications, or skills that aren't in the original resume
- Keep dates, company names, and school names exactly as they appear in the original
- If contact info is missing from the resume, leave that field empty rather than guessing`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Claude API error:', resp.status, errText);
      throw new Error('API returned ' + resp.status);
    }

    const result = await resp.json();
    const responseText = result.content[0].text.trim();
    // Try to parse JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse AI response as JSON');
    }
    analysis = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Claude API error:', err.message);
    throw new functions.https.HttpsError('internal', 'Analysis failed. Please try again.');
  }

  // Save to Firestore
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  await admin.firestore()
    .collection('customers').doc(uid)
    .collection('resumes').add({
      matchScore: analysis.matchScore,
      summary: analysis.summary,
      changesSummary: analysis.changesSummary || [],
      resume: analysis.resume || {},
      jobDescription: jobDescription.substring(0, 500),
      createdAt: timestamp,
    });

  return analysis;
});

// Get resume analysis history for the current user
exports.getResumeHistory = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const snapshot = await admin.firestore()
    .collection('customers').doc(uid)
    .collection('resumes')
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null,
  }));
});

// Deep Dive — AI-powered detailed question breakdown for Pro users
exports.deepDive = functions.runWith({ secrets: ['ANTHROPIC_API_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Check subscription (Stripe or promo code)
  const uid = context.auth.uid;
  const hasSub = await checkUserSubscription(uid);
  if (!hasSub) {
    throw new functions.https.HttpsError('permission-denied', 'Pro subscription required');
  }

  const { question, tip, role } = data;
  if (!question) {
    throw new functions.https.HttpsError('invalid-argument', 'question required');
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    throw new functions.https.HttpsError('internal', 'API configuration error');
  }
  const anthropic = new Anthropic({ apiKey });

  try {
    console.log('Calling Claude API with direct fetch...');
    const prompt = `You are an expert interview coach. Give a detailed breakdown of how to answer this interview question for a ${role || 'general'} role.

Question: "${question}"
${tip ? 'Basic tip: ' + tip : ''}

Provide a concise but detailed breakdown with these sections:

1. WHAT THEY'RE REALLY ASKING — The hidden intent behind the question
2. HOW TO STRUCTURE YOUR ANSWER — A clear framework to follow
3. EXAMPLE STARTER — A strong opening sentence they can adapt
4. COMMON MISTAKES — What to avoid
5. PRO MOVE — One thing that separates great answers from good ones

Keep it practical and specific. No fluff. Use bullet points for readability.`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Claude API error:', resp.status, errText);
      throw new Error('API returned ' + resp.status);
    }

    const result = await resp.json();
    return { content: result.content[0].text };
  } catch (err) {
    console.error('Deep Dive error:', err.message);
    throw new functions.https.HttpsError('internal', 'Analysis failed: ' + err.message);
  }
});

// Email notification when a problem report is submitted
exports.onReportCreated = functions.firestore.document('reports/{reportId}').onCreate(async (snap, context) => {
  const data = snap.data();
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) { console.log('No Brevo key, skipping email'); return; }

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': brevoKey,
      },
      body: JSON.stringify({
        sender: { email: 'noreply@rollcallinterviewprep.com', name: 'RoleCall' },
        to: [{ email: 'rollcallinterviewprep@outlook.com' }],
        subject: `[RoleCall] Problem Report: ${data.category}`,
        htmlContent: `<h2>New Problem Report</h2><p><strong>Category:</strong> ${data.category}</p><p><strong>Description:</strong> ${data.description}</p><p><strong>Email:</strong> ${data.email || 'Not provided'}</p><p><strong>User ID:</strong> ${data.userId || 'Anonymous'}</p><p><strong>URL:</strong> ${data.url || 'N/A'}</p><p><strong>User Agent:</strong> ${data.userAgent || 'N/A'}</p>`
      })
    });
    console.log('Report notification sent');
  } catch (err) {
    console.error('Report email error:', err.message);
  }
});

// ============================================================
// INSTITUTIONAL ANALYTICS PIPELINE
// ============================================================

// One-time super admin initialization
// The setup page itself is protected — only existing super admins can access it.
// This function creates the first super admin doc when called by an authenticated user.
exports.initSuperAdmin = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const email = context.auth.token.email;

  // Check if already exists
  const existing = await admin.firestore().collection('super_admins').doc(uid).get();
  if (existing.exists) {
    return { success: true, message: 'Already a super admin', isNew: false };
  }

  // Check if there are ANY existing super admins
  const existingAdmins = await admin.firestore().collection('super_admins').limit(1).get();

  if (existingAdmins.empty) {
    // First super admin — create automatically (bootstrap)
    await admin.firestore().collection('super_admins').doc(uid).set({
      email: email,
      role: 'owner',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, message: 'First super admin created', isNew: true };
  }

  // Super admins already exist but this user isn't one — deny
  throw new functions.https.HttpsError('permission-denied', 'Not authorized. Ask an existing super admin to add you.');
});

// Record a practice session — called by students after completing a mock interview
exports.recordSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { role, category, score, questionCount, feature } = data;
  if (!role || typeof score !== 'number') {
    throw new functions.https.HttpsError('invalid-argument', 'role and score required');
  }

  const uid = context.auth.uid;

  // Look up the student's institution from their customer record
  let institutionId = null;
  try {
    const custDoc = await admin.firestore().collection('customers').doc(uid).get();
    if (custDoc.exists) {
      institutionId = custDoc.data().institutionId || null;
    }
  } catch (err) {
    console.error('Error looking up customer:', err.message);
  }

  // Write the session record
  const session = {
    uid: uid,
    role: role,
    category: category || 'Unknown',
    score: Math.max(0, Math.min(5, score)), // Clamp 0-5
    questionCount: questionCount || 0,
    feature: feature || 'mock', // 'mock', 'browse', 'resume', 'jok'
    institutionId: institutionId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await admin.firestore().collection('student_sessions').add(session);

  return { recorded: true, institutionId: institutionId };
});

// Redeem a promo code — tags the customer with institutionId
exports.redeemPromoCode = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { code } = data;
  if (!code || typeof code !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Promo code required');
  }

  const uid = context.auth.uid;
  const normalizedCode = code.toUpperCase().trim();

  // Look up the promo code
  const promoDoc = await admin.firestore().collection('promoCodes').doc(normalizedCode).get();
  if (!promoDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Invalid promo code');
  }

  const promo = promoDoc.data();

  // Check if expired
  if (promo.expiresAt && promo.expiresAt.toDate() < new Date()) {
    throw new functions.https.HttpsError('failed-precondition', 'Promo code has expired');
  }

  // Check usage limit
  if (promo.maxUses && promo.currentUses >= promo.maxUses) {
    throw new functions.https.HttpsError('resource-exhausted', 'Promo code has reached its usage limit');
  }

  // Apply the promo code to the customer
  const updateData = {
    promoCode: normalizedCode,
    promoExpiresAt: promo.expiresAt || null,
  };

  // Tag with institutionId if the promo code has one
  if (promo.institutionId) {
    updateData.institutionId = promo.institutionId;
  }

  await admin.firestore().collection('customers').doc(uid).set(updateData, { merge: true });

  // Increment usage count
  await admin.firestore().collection('promoCodes').doc(normalizedCode).update({
    currentUses: admin.firestore.FieldValue.increment(1),
  });

  return {
    success: true,
    institutionId: promo.institutionId || null,
    institutionName: promo.institutionName || null,
  };
});

// Scheduled function: aggregate student sessions into institution stats
// Runs daily at midnight UTC via Google Cloud Scheduler
exports.aggregateInstitutionStats = functions.pubsub
  .schedule('0 0 * * *')
  .timeZone('UTC')
  .onRun(async (context) => {
    const db = admin.firestore();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Get all sessions from the last 30 days
    const sessionsSnap = await db.collection('student_sessions')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(thirtyDaysAgo))
      .get();

    // Group by institutionId
    const institutions = {};
    sessionsSnap.forEach(doc => {
      const s = doc.data();
      const instId = s.institutionId;
      if (!instId) return; // Skip sessions without institution

      if (!institutions[instId]) {
        institutions[instId] = {
          sessions: [],
          uids: new Set(),
          uidsLast7d: new Set(),
        };
      }
      institutions[instId].sessions.push(s);
      institutions[instId].uids.add(s.uid);
      if (s.createdAt && s.createdAt.toDate() >= sevenDaysAgo) {
        institutions[instId].uidsLast7d.add(s.uid);
      }
    });

    // Build stats for each institution
    for (const [instId, data] of Object.entries(institutions)) {
      const sessions = data.sessions;
      const totalSessions = sessions.length;
      const activeStudents = data.uids.size;
      const activeStudentsLast7d = data.uidsLast7d.size;

      // Questions answered
      const questionsAnswered = sessions.reduce((sum, s) => sum + (s.questionCount || 0), 0);

      // Average score
      const scores = sessions.filter(s => s.score > 0).map(s => s.score);
      const avgScore = scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : 0;

      // Top roles
      const roleCounts = {};
      sessions.forEach(s => {
        roleCounts[s.role] = (roleCounts[s.role] || 0) + 1;
      });
      const topRoles = Object.entries(roleCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));

      // Industry breakdown
      const industryCounts = {};
      sessions.forEach(s => {
        const cat = s.category || 'Unknown';
        industryCounts[cat] = (industryCounts[cat] || 0) + 1;
      });
      const industries = Object.entries(industryCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }));

      // Feature usage
      const featureCounts = { mock: 0, resume: 0, browse: 0, jok: 0 };
      sessions.forEach(s => {
        const f = s.feature || 'mock';
        if (featureCounts.hasOwnProperty(f)) featureCounts[f]++;
      });

      // Weekly breakdown (last 4 weeks)
      const weekly = [];
      for (let i = 0; i < 4; i++) {
        const weekStart = new Date(now.getTime() - (i + 1) * 7 * 24 * 60 * 60 * 1000);
        const weekEnd = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
        const weekSessions = sessions.filter(s => {
          const d = s.createdAt?.toDate?.();
          return d && d >= weekStart && d < weekEnd;
        });
        const weekScores = weekSessions.filter(s => s.score > 0).map(s => s.score);
        const weekAvg = weekScores.length > 0
          ? Math.round((weekScores.reduce((a, b) => a + b, 0) / weekScores.length) * 10) / 10
          : 0;
        const weekRoles = {};
        weekSessions.forEach(s => { weekRoles[s.role] = (weekRoles[s.role] || 0) + 1; });
        const topRole = Object.entries(weekRoles).sort((a, b) => b[1] - a[1])[0];

        weekly.push({
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          sessions: weekSessions.length,
          avgScore: weekAvg,
          topRole: topRole ? topRole[0] : 'N/A',
        });
      }

      // Score progression (avg score by session number per student)
      const studentSessions = {};
      sessions.forEach(s => {
        if (!studentSessions[s.uid]) studentSessions[s.uid] = [];
        studentSessions[s.uid].push(s.score);
      });
      const scoreProgression = [];
      for (let i = 0; i < 5; i++) {
        const scoresAtN = Object.values(studentSessions)
          .filter(arr => arr.length > i)
          .map(arr => arr[i]);
        if (scoresAtN.length > 0) {
          scoreProgression.push({
            sessionNum: i + 1,
            avgScore: Math.round((scoresAtN.reduce((a, b) => a + b, 0) / scoresAtN.length) * 10) / 10,
            count: scoresAtN.length,
          });
        }
      }

      // Write aggregated stats
      await db.collection('institution_stats').doc(instId).set({
        institutionId: instId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        periodStart: admin.firestore.Timestamp.fromDate(thirtyDaysAgo),
        periodEnd: admin.firestore.Timestamp.fromDate(now),
        activeStudents: activeStudents,
        activeStudentsLast7d: activeStudentsLast7d,
        totalSessions: totalSessions,
        questionsAnswered: questionsAnswered,
        avgScore: avgScore,
        topRoles: topRoles,
        industries: industries,
        features: featureCounts,
        weekly: weekly,
        scoreProgression: scoreProgression,
      }, { merge: true });

      console.log(`Aggregated stats for ${instId}: ${activeStudents} students, ${totalSessions} sessions`);
    }

    // Clean up sessions older than 90 days
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const oldSnap = await db.collection('student_sessions')
      .where('createdAt', '<', admin.firestore.Timestamp.fromDate(ninetyDaysAgo))
      .limit(500)
      .get();

    const batch = db.batch();
    oldSnap.forEach(doc => batch.delete(doc.ref));
    if (!oldSnap.empty) {
      await batch.commit();
      console.log(`Cleaned up ${oldSnap.size} old sessions`);
    }

    return null;
  });

// ============================================================
// JOB SEARCH ENGINE — CLOUD FUNCTIONS
// ============================================================

// Shared job source instances
const adzunaSource = new AdzunaSource();

/**
 * ingestJobs — Pulls jobs from configured providers and stores in Firestore.
 * Callable function for manual triggering. Also called by syncJobs.
 * 
 * @param {string} query - Search query
 * @param {string} location - Location filter
 * @param {number} maxPages - Max pages to fetch per provider (default 3)
 * @returns {{ stats: { created, updated, skipped, errors }, totalFetched }}
 */
exports.ingestJobs = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Only super admins can trigger ingestion
  const superAdminDoc = await admin.firestore()
    .collection('super_admins').doc(context.auth.uid).get();
  if (!superAdminDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  const { query, location, maxPages = 3 } = data;
  if (!query) {
    throw new functions.https.HttpsError('invalid-argument', 'query is required');
  }

  const db = admin.firestore();
  let totalFetched = 0;
  const allStats = { created: 0, updated: 0, skipped: 0, errors: 0 };

  // Fetch from Adzuna
  if (adzunaSource.isConfigured()) {
    try {
      for (let page = 1; page <= maxPages; page++) {
        const result = await adzunaSource.fetchJobs(query, location, { page });
        
        if (result.jobs.length === 0) break;
        
        totalFetched += result.jobs.length;
        
        // Normalize and set dedup keys
        const normalized = result.jobs.map(j => {
          const n = normalizeJob(j, adzunaSource);
          return n;
        });
        
        // Process with deduplication
        const stats = await processJobs(normalized, db);
        allStats.created += stats.created;
        allStats.updated += stats.updated;
        allStats.skipped += stats.skipped;
        allStats.errors += stats.errors;
        
        console.log(`[Ingest] Adzuna page ${page}: ${result.jobs.length} jobs, ${stats.created} created, ${stats.updated} updated`);
        
        // Rate limit: wait 500ms between pages
        if (page < maxPages) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch (err) {
      console.error('[Ingest] Adzuna error:', err.message);
      allStats.errors++;
    }
  } else {
    console.log('[Ingest] Adzuna not configured — skipping');
  }

  console.log(`[Ingest] Complete: ${totalFetched} fetched, ${allStats.created} created, ${allStats.updated} updated`);
  return { stats: allStats, totalFetched };
});

/**
 * searchJobs — Search jobs in Firestore with filters and pagination.
 * Callable function. Public (no auth required — jobs are public data).
 * 
 * @param {string} query - Search query (matched against title, company, description)
 * @param {Object} filters - Optional filters
 * @param {string} filters.location - Location filter
 * @param {boolean} filters.remote - Remote only
 * @param {string} filters.employmentType - Employment type filter
 * @param {number} filters.salaryMin - Minimum salary
 * @param {string} filters.seniority - Seniority level
 * @param {string} filters.sortBy - "relevance" | "date" | "salary"
 * @param {number} filters.page - Page number (1-indexed)
 * @param {number} filters.pageSize - Results per page (default 20)
 * @returns {{ jobs: Array, totalResults: number, page: number, hasMore: boolean }}
 */
exports.searchJobs = functions.https.onCall(async (data, context) => {
  const { query = '', filters = {} } = data;
  const {
    location = '',
    remote = null,
    employmentType = null,
    salaryMin = null,
    seniority = null,
    sortBy = 'relevance',
    page = 1,
    pageSize = 20,
  } = filters;

  const db = admin.firestore();
  const limit = Math.min(pageSize, 50);

  try {
    // Build Firestore query — use simple orderBy to avoid composite index requirements
    // All filtering happens in memory after fetch
    let queryRef = db.collection('jobs').orderBy('postedAt', 'desc');

    // Fetch enough to filter and rank
    const fetchLimit = Math.min(limit * 5, 250);
    queryRef = queryRef.limit(fetchLimit);

    const snap = await queryRef.get();
    let jobs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter active jobs in memory
    jobs = jobs.filter(job => job.active === true);

    // Apply filters in memory (avoids composite index requirements)
    if (remote === true) {
      jobs = jobs.filter(job => job.remote === true);
    }
    if (employmentType) {
      jobs = jobs.filter(job => job.employmentType === employmentType);
    }
    if (seniority) {
      jobs = jobs.filter(job => job.seniority === seniority);
    }

    // Post-fetch filtering (things Firestore can't do well)
    if (query) {
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/).filter(Boolean);
      
      jobs = jobs.map(job => {
        const searchText = [
          job.title || '',
          job.company || '',
          job.description || '',
          ...(job.skills || []),
          job.category || '',
          job.location || '',
        ].join(' ').toLowerCase();

        // Score based on term matches
        let score = 0;
        for (const term of queryTerms) {
          if ((job.title || '').toLowerCase().includes(term)) score += 10;
          if ((job.company || '').toLowerCase().includes(term)) score += 5;
          if ((job.skills || []).some(s => s.toLowerCase().includes(term))) score += 3;
          if ((job.description || '').toLowerCase().includes(term)) score += 1;
        }

        return { ...job, _relevanceScore: score };
      }).filter(job => job._relevanceScore > 0);
    }

    // Location filter (post-fetch — fuzzy matching)
    if (location && location.toLowerCase() !== 'remote') {
      const locLower = location.toLowerCase();
      jobs = jobs.filter(job => {
        const jobLoc = (job.location || '').toLowerCase();
        return jobLoc.includes(locLower) || 
               jobLoc.split(',').some(part => part.trim().startsWith(locLower.substring(0, 3)));
      });
    }

    // Salary filter (post-fetch)
    if (salaryMin) {
      jobs = jobs.filter(job => {
        if (!job.salaryMax && !job.salaryMin) return true; // Include jobs without salary data
        return (job.salaryMax || job.salaryMin || 0) >= salaryMin;
      });
    }

    // Sort by relevance if query provided
    if (query && sortBy === 'relevance') {
      jobs.sort((a, b) => (b._relevanceScore || 0) - (a._relevanceScore || 0));
    }

    // Get total before pagination
    const totalResults = jobs.length;

    // Paginate
    const offset = (page - 1) * limit;
    const paginatedJobs = jobs.slice(offset, offset + limit);

    // Clean up internal scoring fields before returning
    const cleanJobs = paginatedJobs.map(({ _relevanceScore, ...job }) => ({
      ...job,
      // Convert Firestore timestamps to ISO strings for frontend
      postedAt: job.postedAt?.toDate?.()?.toISOString() || job.postedAt || null,
      expiresAt: job.expiresAt?.toDate?.()?.toISOString() || job.expiresAt || null,
      importedAt: job.importedAt?.toDate?.()?.toISOString() || job.importedAt || null,
    }));

    return {
      jobs: cleanJobs,
      totalResults,
      page,
      hasMore: offset + limit < totalResults,
    };
  } catch (err) {
    console.error('[SearchJobs] Error:', err.message);
    throw new functions.https.HttpsError('internal', 'Search failed. Please try again.');
  }
});

/**
 * syncJobs — Scheduled function that updates jobs daily.
 * Runs at 3 AM UTC every day.
 * - Fetches fresh jobs for popular queries
 * - Marks expired jobs as inactive
 * - Updates lastSyncedAt timestamps
 */
exports.syncJobs = functions.pubsub.schedule('0 3 * * *').timeZone('UTC').onRun(async (context) => {
  const db = admin.firestore();

  // Popular queries to keep fresh
  const popularQueries = [
    'training specialist',
    'project manager',
    'software engineer',
    'nurse',
    'data analyst',
    'marketing manager',
    'financial analyst',
    'teacher',
    'sales representative',
    'human resources',
    'accountant',
    'customer service manager',
    'operations manager',
    'welder',
    'electrician',
  ];

  let totalIngested = 0;

  // Ingest fresh jobs for popular queries
  if (adzunaSource.isConfigured()) {
    for (const query of popularQueries) {
      try {
        const result = await adzunaSource.fetchJobs(query, '', { page: 1, resultsPerPage: 25 });
        
        if (result.jobs.length > 0) {
          const normalized = result.jobs.map(j => normalizeJob(j, adzunaSource));
          const stats = await processJobs(normalized, db);
          totalIngested += stats.created + stats.updated;
        }
        
        // Rate limit
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.error(`[Sync] Error fetching "${query}":`, err.message);
      }
    }
  }

  // Mark expired jobs as inactive
  const now = admin.firestore.Timestamp.now();
  const expiredSnap = await db.collection('jobs')
    .where('active', '==', true)
    .where('expiresAt', '<', now)
    .limit(500)
    .get();

  if (!expiredSnap.empty) {
    const batch = db.batch();
    expiredSnap.docs.forEach(doc => {
      batch.update(doc.ref, { active: false, lastSyncedAt: now });
    });
    await batch.commit();
    console.log(`[Sync] Deactivated ${expiredSnap.size} expired jobs`);
  }

  // Mark jobs older than 60 days as inactive (even without expiresAt)
  const sixtyDaysAgo = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  );
  const staleSnap = await db.collection('jobs')
    .where('active', '==', true)
    .where('postedAt', '<', sixtyDaysAgo)
    .limit(500)
    .get();

  if (!staleSnap.empty) {
    const batch = db.batch();
    staleSnap.docs.forEach(doc => {
      batch.update(doc.ref, { active: false, lastSyncedAt: now });
    });
    await batch.commit();
    console.log(`[Sync] Deactivated ${staleSnap.size} stale jobs (>60 days old)`);
  }

  console.log(`[Sync] Complete: ${totalIngested} jobs refreshed, expired/stale deactivated`);
  return null;
});

/**
 * trackJobEvent — Records job-related analytics events.
 * Callable function. Authenticated (optional — can track anonymous events).
 */
exports.trackJobEvent = functions.https.onCall(async (data, context) => {
  const { event, query, filters, jobId } = data;
  
  if (!event) {
    throw new functions.https.HttpsError('invalid-argument', 'event is required');
  }

  const validEvents = ['job_search', 'job_view', 'job_save', 'job_apply_click', 'job_filter_used', 'interview_prep_clicked'];
  if (!validEvents.includes(event)) {
    throw new functions.https.HttpsError('invalid-argument', `Invalid event type: ${event}`);
  }

  await admin.firestore().collection('jobAnalytics').add({
    event,
    query: query || null,
    filters: filters || null,
    jobId: jobId || null,
    uid: context.auth?.uid || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});

/**
 * saveJob — Save a job for the authenticated user.
 * Creates a reference in savedJobs/{uid}/jobs/{jobId}.
 */
exports.saveJob = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { jobId, status = 'saved', notes = '' } = data;
  if (!jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'jobId is required');
  }

  // Verify the job exists
  const jobDoc = await admin.firestore().collection('jobs').doc(jobId).get();
  if (!jobDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Job not found');
  }

  const uid = context.auth.uid;
  const saveRef = admin.firestore()
    .collection('savedJobs').doc(uid)
    .collection('jobs').doc(jobId);

  await saveRef.set({
    jobId,
    status,
    notes,
    savedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { success: true };
});

/**
 * unsaveJob — Remove a saved job for the authenticated user.
 */
exports.unsaveJob = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { jobId } = data;
  if (!jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'jobId is required');
  }

  const uid = context.auth.uid;
  await admin.firestore()
    .collection('savedJobs').doc(uid)
    .collection('jobs').doc(jobId)
    .delete();

  return { success: true };
});

/**
 * getSavedJobs — Get all saved jobs for the authenticated user.
 * Returns saved job metadata joined with job details.
 */
exports.getSavedJobs = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const savedSnap = await admin.firestore()
    .collection('savedJobs').doc(uid)
    .collection('jobs')
    .orderBy('savedAt', 'desc')
    .limit(100)
    .get();

  if (savedSnap.empty) {
    return { jobs: [] };
  }

  // Fetch job details for each saved job
  const jobs = [];
  for (const savedDoc of savedSnap.docs) {
    const savedData = savedDoc.data();
    const jobDoc = await admin.firestore().collection('jobs').doc(savedData.jobId).get();
    
    if (jobDoc.exists) {
      const jobData = jobDoc.data();
      jobs.push({
        ...jobData,
        id: jobDoc.id,
        savedStatus: savedData.status,
        savedNotes: savedData.notes,
        savedAt: savedData.savedAt?.toDate?.()?.toISOString() || null,
        postedAt: jobData.postedAt?.toDate?.()?.toISOString() || null,
      });
    }
  }

  return { jobs };
});

/**
 * updateSavedJobStatus — Update the status/notes of a saved job.
 */
exports.updateSavedJobStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { jobId, status, notes } = data;
  if (!jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'jobId is required');
  }

  const validStatuses = ['saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived'];
  if (status && !validStatuses.includes(status)) {
    throw new functions.https.HttpsError('invalid-argument', `Invalid status: ${status}`);
  }

  const uid = context.auth.uid;
  const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (status) updateData.status = status;
  if (notes !== undefined) updateData.notes = notes;

  await admin.firestore()
    .collection('savedJobs').doc(uid)
    .collection('jobs').doc(jobId)
    .update(updateData);

  return { success: true };
});

/**
 * getJobStats — Admin function to get job search analytics.
 * Returns aggregate stats about job data and search behavior.
 */
exports.getJobStats = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Check super admin access
  const superAdminDoc = await admin.firestore()
    .collection('super_admins').doc(context.auth.uid).get();
  if (!superAdminDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  const db = admin.firestore();

  // Count active jobs
  const activeSnap = await db.collection('jobs')
    .where('active', '==', true)
    .count().get();
  const activeJobs = activeSnap.data().count;

  // Count total jobs
  const totalSnap = await db.collection('jobs').count().get();
  const totalJobs = totalSnap.data().count;

  // Jobs by source
  const sources = {};
  const sourcesSnap = await db.collection('jobs')
    .where('active', '==', true)
    .select('sourceId')
    .limit(1000)
    .get();
  sourcesSnap.docs.forEach(doc => {
    const src = doc.data().sourceId || 'unknown';
    sources[src] = (sources[src] || 0) + 1;
  });

  // Recent analytics (last 7 days)
  const sevenDaysAgo = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  );
  const analyticsSnap = await db.collection('jobAnalytics')
    .where('createdAt', '>', sevenDaysAgo)
    .select('event')
    .limit(5000)
    .get();

  const events = {};
  analyticsSnap.docs.forEach(doc => {
    const evt = doc.data().event || 'unknown';
    events[evt] = (events[evt] || 0) + 1;
  });

  return {
    activeJobs,
    totalJobs,
    jobsBySource: sources,
    analyticsLast7Days: events,
  };
});

/**
 * seedJobs — One-time HTTP endpoint to seed jobs into Firestore.
 * Protected by a simple secret key.
 * Call: GET https://<project>.cloudfunctions.net/seedJobs?key=rolecall-seed-2026
 */
exports.seedJobs = functions.https.onRequest(async (req, res) => {
  const key = req.query.key;
  if (key !== 'rolecall-seed-2026') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  const db = admin.firestore();
  const source = new AdzunaSource();

  if (!source.isConfigured()) {
    return res.status(500).json({ error: 'Adzuna not configured' });
  }

  const queries = [
    'training specialist',
    'project manager',
    'nurse',
    'software engineer',
    'data analyst',
    'marketing manager',
    'accountant',
    'sales representative',
    'teacher',
    'electrician',
    'human resources manager',
    'operations manager',
    'financial analyst',
    'customer service manager',
    'welder',
  ];

  let totalFetched = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let errors = 0;

  for (const query of queries) {
    try {
      const result = await source.fetchJobs(query, '', { page: 1, resultsPerPage: 25 });
      
      if (result.jobs.length === 0) continue;
      
      const normalized = result.jobs.map(j => normalizeJob(j, source));
      const stats = await processJobs(normalized, db);
      
      totalFetched += result.jobs.length;
      totalCreated += stats.created;
      totalUpdated += stats.updated;
      errors += stats.errors;
      
      console.log(`[Seed] "${query}": ${result.jobs.length} fetched, ${stats.created} created, ${stats.updated} updated`);
      
      // Rate limit
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[Seed] Error for "${query}":`, err.message);
      errors++;
    }
  }

  res.json({
    success: true,
    totalFetched,
    totalCreated,
    totalUpdated,
    errors,
    queries: queries.length,
  });
});

/**
 * loadJobs — HTTP endpoint to bulk load normalized jobs into Firestore.
 * Accepts POST with JSON array of jobs.
 * Protected by the same secret key as seedJobs.
 */
exports.loadJobs = functions.https.onRequest(async (req, res) => {
  const key = req.query.key;
  if (key !== 'rolecall-seed-2026') {
    return res.status(403).json({ error: 'Invalid key' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required' });
  }

  const db = admin.firestore();
  const jobs = req.body;

  if (!Array.isArray(jobs)) {
    return res.status(400).json({ error: 'Body must be a JSON array' });
  }

  let created = 0;
  let errors = 0;
  const batch = db.batch();
  let batchCount = 0;

  for (const job of jobs) {
    try {
      const newRef = db.collection('jobs').doc();
      batch.set(newRef, {
        ...job,
        active: true,
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batchCount++;
      created++;

      if (batchCount >= 450) {
        await batch.commit();
        batchCount = 0;
      }
    } catch (err) {
      errors++;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  res.json({ success: true, created, errors, total: jobs.length });
});
