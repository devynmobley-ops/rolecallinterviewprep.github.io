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
