/**
 * Auto-Apply Cloud Functions — Application provider integration.
 *
 * These functions bridge the frontend Application Tracker with the
 * backend provider abstraction. They handle:
 *   - Job analysis (can this job be auto-applied?)
 *   - Application preparation (AI generates materials)
 *   - Application submission (through the provider)
 *   - Feature authorization (account type + org policy + subscription)
 */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const { getProviderManager } = require('./application/ProviderManager');

/**
 * Check if a user can use Auto-Apply.
 * Separates visibility from authorization.
 */
async function checkAutoApplyAuthorization(uid) {
  const db = admin.firestore();
  const customerDoc = await db.collection('customers').doc(uid).get();

  if (!customerDoc.exists) {
    return { authorized: false, reason: 'no_account' };
  }

  const custData = customerDoc.data();
  const accountType = custData.accountType;
  const organizationId = custData.organizationId;

  // Personal accounts: visible by default, subscription required
  if (accountType === 'PERSONAL') {
    // Check subscription
    const subSnap = await db.collection('customers').doc(uid)
      .collection('subscriptions')
      .where('status', 'in', ['active', 'trialing'])
      .get();

    if (!subSnap.empty) {
      return { authorized: true, reason: 'subscribed' };
    }

    // Check promo code
    if (custData.promoCode) {
      const promoExp = custData.promoExpiresAt;
      if (!promoExp || promoExp.toDate() > new Date()) {
        return { authorized: true, reason: 'promo_code' };
      }
    }

    return { authorized: false, reason: 'subscription_required' };
  }

  // Student accounts: hidden by default, org must enable
  if (accountType === 'STUDENT') {
    if (!organizationId) {
      return { authorized: false, reason: 'no_organization' };
    }

    // Check org feature policy
    const policySnap = await db.collection('organizations')
      .doc(organizationId)
      .collection('featurePolicies')
      .doc('default')
      .get();

    if (policySnap.exists) {
      const features = policySnap.data().features || {};
      if (features.AUTO_APPLY === true) {
        return { authorized: true, reason: 'org_enabled' };
      }
    }

    return { authorized: false, reason: 'org_disabled' };
  }

  // No account type set
  return { authorized: false, reason: 'no_account_type' };
}

/**
 * Analyze a job for auto-apply feasibility.
 * Returns analysis without starting the application.
 */
exports.analyzeJobForApply = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const { jobId, job } = data;

  if (!jobId && !job) {
    throw new functions.https.HttpsError('invalid-argument', 'jobId or job required');
  }

  // Check authorization
  const authCheck = await checkAutoApplyAuthorization(uid);
  if (!authCheck.authorized) {
    throw new functions.https.HttpsError('permission-denied', 'Auto-Apply not available: ' + authCheck.reason);
  }

  // Get job data
  let jobData = job;
  if (jobId && !jobData) {
    const jobDoc = await admin.firestore().collection('jobs').doc(jobId).get();
    if (!jobDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Job not found');
    }
    jobData = jobDoc.data();
  }

  // Get user profile
  const userDoc = await admin.firestore().collection('customers').doc(uid).get();
  const userProfile = userDoc.exists ? userDoc.data() : {};

  // Analyze with provider manager
  const manager = getProviderManager();
  const { provider, analysis, name } = await manager.analyzeForBestProvider(jobData, userProfile);

  return {
    analysis,
    providerName: name,
    capabilities: provider.getCapabilities(),
  };
});

/**
 * Prepare an application — generate resume, cover letter, answers.
 * Returns prepared materials for user review before submission.
 */
exports.prepareApplication = functions.runWith({ secrets: ['ANTHROPIC_API_KEY'] }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const { jobId, job, mode = 'assisted', generateCoverLetter = true, customAnswers = {} } = data;

  if (!jobId && !job) {
    throw new functions.https.HttpsError('invalid-argument', 'jobId or job required');
  }

  // Check authorization
  const authCheck = await checkAutoApplyAuthorization(uid);
  if (!authCheck.authorized) {
    throw new functions.https.HttpsError('permission-denied', 'Auto-Apply not available: ' + authCheck.reason);
  }

  // Get job data
  let jobData = job;
  if (jobId && !jobData) {
    const jobDoc = await admin.firestore().collection('jobs').doc(jobId).get();
    if (!jobDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Job not found');
    }
    jobData = jobDoc.data();
  }

  // Get user profile (including resume data)
  const db = admin.firestore();
  const userDoc = await db.collection('customers').doc(uid).get();
  const userProfile = userDoc.exists ? userDoc.data() : {};

  // Get latest resume from user's resume history
  const resumeSnap = await db.collection('customers').doc(uid)
    .collection('resumes')
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  if (!resumeSnap.empty) {
    const resumeData = resumeSnap.docs[0].data();
    userProfile.resumeText = resumeData.resume ? JSON.stringify(resumeData.resume) : null;
    userProfile.resumeScore = resumeData.matchScore;
  }

  // Select provider and prepare
  const manager = getProviderManager();
  const provider = manager.selectProvider(jobData, mode, userProfile);

  if (!provider) {
    throw new functions.https.HttpsError('failed-precondition', 'No provider available for mode: ' + mode);
  }

  try {
    const prepared = await provider.prepareApplication(jobData, userProfile, {
      mode,
      generateCoverLetter,
      customAnswers,
    });

    // Track cost
    if (prepared.costEstimate) {
      await db.collection('applicationCosts').add({
        uid,
        jobId: jobId || null,
        provider: provider.getProviderName(),
        costAI: prepared.costEstimate.ai || 0,
        costProvider: prepared.costEstimate.provider || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return {
      prepared,
      providerName: provider.getProviderName(),
    };
  } catch (err) {
    console.error('[prepareApplication] Error:', err);
    const failureAction = await provider.handleFailure(err, { stage: 'prepare', jobId });
    throw new functions.https.HttpsError('internal', failureAction.message || 'Preparation failed');
  }
});

/**
 * Get available application modes for a job.
 * Returns which modes the user can use based on auth + job type.
 */
exports.getApplicationModes = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const { jobId, job } = data;

  // Check authorization
  const authCheck = await checkAutoApplyAuthorization(uid);

  // Get job data if provided
  let jobData = job || null;
  if (jobId && !jobData) {
    const jobDoc = await admin.firestore().collection('jobs').doc(jobId).get();
    if (jobDoc.exists) {
      jobData = jobDoc.data();
    }
  }

  const modes = [];

  // Manual is always available
  modes.push({
    mode: 'manual',
    available: true,
    label: 'Manual',
    description: 'Apply yourself using the job link.',
    icon: '👤',
  });

  // Assisted is available if authorized
  if (authCheck.authorized) {
    modes.push({
      mode: 'assisted',
      available: true,
      label: 'Assisted',
      description: 'AI prepares your resume, cover letter, and answers. You review and submit.',
      icon: '🤝',
    });
  } else {
    modes.push({
      mode: 'assisted',
      available: false,
      label: 'Assisted',
      description: 'Requires Pro subscription or school access.',
      icon: '🤝',
      requiresUpgrade: true,
    });
  }

  // Automated — currently disabled (stub provider)
  modes.push({
    mode: 'automated',
    available: false,
    label: 'Auto-Apply',
    description: 'Coming soon — RollCall will submit applications for you.',
    icon: '🤖',
    comingSoon: true,
  });

  return {
    modes,
    authCheck,
  };
});

/**
 * Admin: Get provider system status and capabilities.
 */
exports.getProviderStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  // Check super admin
  const superAdminDoc = await admin.firestore()
    .collection('super_admins').doc(context.auth.uid).get();
  if (!superAdminDoc.exists) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }

  const manager = getProviderManager();

  return {
    providers: manager.getProviderNames(),
    capabilities: manager.getAllCapabilities(),
  };
});