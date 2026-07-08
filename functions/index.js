const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const Stripe = require('stripe');

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
