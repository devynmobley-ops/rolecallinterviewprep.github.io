const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
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
exports.createCheckoutSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = request.auth.uid;
  const priceId = request.data.priceId;

  if (!priceId) {
    throw new HttpsError('invalid-argument', 'priceId required');
  }

  // Get or create Stripe customer
  const customerSnap = await admin.firestore().collection('customers').doc(uid).get();

  let customerId;
  if (customerSnap.exists && customerSnap.data().stripeCustomerId) {
    customerId = customerSnap.data().stripeCustomerId;
  } else {
    const customer = await getStripe().customers.create({
      email: request.auth.token.email,
      metadata: { firebaseUID: uid }
    });
    customerId = customer.id;
    await admin.firestore().collection('customers').doc(uid).set(
      { stripeCustomerId: customerId }, { merge: true }
    );
  }

  // Create Checkout Session
  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: 'https://rollcallinterviewprep.com/?checkout=success',
    cancel_url: 'https://rollcallinterviewprep.com/?checkout=cancel',
    subscription_data: {
      trial_period_days: 7,
    },
  });

  return { url: session.url };
});

// Receive Stripe webhook events and write subscription status to Firestore
exports.stripeWebhook = onRequest(async (req, res) => {
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
exports.createPortalSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = request.auth.uid;
  const customerSnap = await admin.firestore().collection('customers').doc(uid).get();

  if (!customerSnap.exists || !customerSnap.data().stripeCustomerId) {
    throw new HttpsError('not-found', 'No Stripe customer found');
  }

  const customerId = customerSnap.data().stripeCustomerId;

  const portalSession = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: 'https://rollcallinterviewprep.com/',
  });

  return { url: portalSession.url };
});

// Server-side subscription check (fallback)
exports.checkSubscription = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = request.auth.uid;
  const subscriptionsSnap = await admin.firestore()
    .collection('customers').doc(uid)
    .collection('subscriptions')
    .where('status', 'in', ['active', 'trialing'])
    .get();

  return { isSubscribed: !subscriptionsSnap.empty };
});
