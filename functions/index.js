const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();

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
exports.tailorResume = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Check subscription
  const uid = context.auth.uid;
  const subscriptionsSnap = await admin.firestore()
    .collection('customers').doc(uid)
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing'])
    .get();

  if (subscriptionsSnap.empty) {
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

  // Call Claude Haiku
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let analysis;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a professional resume consultant. Analyze this resume against the job description and provide actionable feedback.

RESUME:
${resumeText.substring(0, 8000)}

JOB DESCRIPTION:
${jobDescription.substring(0, 4000)}

Respond in this exact JSON format (no markdown, just raw JSON):
{
  "matchScore": <number 0-100>,
  "summary": "<2-3 sentence overall assessment>",
  "missingKeywords": ["<skill or keyword from job description missing in resume>", "..."],
  "strengths": ["<what aligns well between resume and job>", "..."],
  "suggestedBullets": [
    {"original": "<current bullet or section>", "improved": "<better version tailored to job>"},
    ...
  ],
  "actionItems": ["<specific action to improve the resume>", "..."]
}

Focus on:
1. Keywords/skills from the job description that are missing from the resume
2. Bullet points that could be reworded to better match the job
3. Strengths that already align well
4. Specific, actionable improvements

Provide 3-5 items per category. Be specific and practical.`
      }]
    });

    const responseText = message.content[0].text.trim();
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
      ...analysis,
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
exports.deepDive = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Check subscription
  const uid = context.auth.uid;
  const subscriptionsSnap = await admin.firestore()
    .collection('customers').doc(uid)
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing'])
    .get();

  if (subscriptionsSnap.empty) {
    throw new functions.https.HttpsError('permission-denied', 'Pro subscription required');
  }

  const { question, tip, role } = data;
  if (!question) {
    throw new functions.https.HttpsError('invalid-argument', 'question required');
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are an expert interview coach. Give a detailed breakdown of how to answer this interview question for a ${role || 'general'} role.

Question: "${question}"
${tip ? 'Basic tip: ' + tip : ''}

Provide a concise but detailed breakdown with these sections:

1. WHAT THEY'RE REALLY ASKING — The hidden intent behind the question
2. HOW TO STRUCTURE YOUR ANSWER — A clear framework to follow
3. EXAMPLE STARTER — A strong opening sentence they can adapt
4. COMMON MISTAKES — What to avoid
5. PRO MOVE — One thing that separates great answers from good ones

Keep it practical and specific. No fluff. Use bullet points for readability.`
      }]
    });

    return { content: message.content[0].text };
  } catch (err) {
    console.error('Deep Dive error:', err.message);
    throw new functions.https.HttpsError('internal', 'Analysis failed. Please try again.');
  }
});
