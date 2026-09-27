/**
 * ManualProvider — Manual application mode.
 *
 * This provider doesn't automate anything. It:
 *   - Analyzes jobs to extract application URLs
 *   - Returns the direct application link
 *   - Tracks that the user will apply manually
 *
 * Used as the fallback when no automation is available,
 * or when the user chooses to apply manually.
 */

const { ApplicationProvider } = require('../ApplicationProvider');

class ManualProvider extends ApplicationProvider {
  getProviderName() {
    return 'manual';
  }

  getCapabilities() {
    return {
      supportedAts: ['*'], // Works with any ATS
      supportsBulkApply: false,
      supportsStatusTracking: false,
      supportsCoverLetter: false,
      supportsAutoAnswers: false,
      requiresBrowser: false,
      requiresLogin: false,
      costPerApplication: 0,
      rateLimit: null,
    };
  }

  async analyzeJob(job, userProfile) {
    return {
      canApply: true,
      confidence: 1.0,
      atsType: 'unknown',
      estimatedDifficulty: 'medium',
      missingFields: [],
      warnings: [],
      estimatedTime: 300, // ~5 minutes for manual application
      requiresLogin: false,
      supportsAutoFill: false,
    };
  }

  async prepareApplication(job, userProfile, options = {}) {
    return {
      providerName: 'manual',
      resume: null,
      coverLetter: null,
      answers: {},
      missingFields: [],
      warnings: ['Manual mode — you will complete the application yourself.'],
      estimatedSubmissionTime: 300,
      costEstimate: { provider: 0, ai: 0 },
    };
  }

  async submitApplication(preparedApp, job) {
    // Manual mode doesn't submit — returns the application URL for the user
    return {
      success: true,
      providerJobId: null,
      submissionStatus: 'needs_action',
      confirmationUrl: job.applicationUrl || job.sourceUrl || null,
      failureReason: null,
      missingFields: [],
      costActual: { provider: 0, ai: 0 },
      submittedAt: null,
    };
  }

  async getApplicationStatus(providerJobId) {
    return {
      status: 'pending',
      lastUpdated: new Date(),
      details: 'Manual application — status must be updated by user.',
      nextAction: 'Update your application status in the tracker.',
    };
  }

  async cancelApplication(providerJobId) {
    return {
      success: true,
      message: 'Manual application cancelled.',
    };
  }

  async handleFailure(error, context) {
    return {
      action: 'manual',
      retryDelay: 0,
      maxRetries: 0,
      message: 'Please apply manually using the job link.',
      requiresUserInput: false,
    };
  }
}

module.exports = { ManualProvider };