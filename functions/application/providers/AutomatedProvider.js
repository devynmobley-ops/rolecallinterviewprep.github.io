/**
 * AutomatedProvider — Automated application submission.
 *
 * This is a STUB provider that defines the interface for future
 * automated application submission. It will eventually integrate with:
 *   - Third-party application services
 *   - Browser automation (Playwright/Puppeteer)
 *   - Direct ATS API integrations (Greenhouse, Lever, etc.)
 *
 * Currently returns stub responses. Real implementations will be added
 * as the automation infrastructure matures.
 *
 * SAFETY: This provider NEVER fabricates user data. If information
 * is missing, it returns needsUserAction with the specific fields.
 */

const { ApplicationProvider } = require('../ApplicationProvider');

class AutomatedProvider extends ApplicationProvider {
  constructor() {
    super();
    this.subProviders = new Map();
    // Future: register specific ATS integrations
    // this.subProviders.set('greenhouse', new GreenhouseSubProvider());
    // this.subProviders.set('lever', new LeverSubProvider());
  }

  getProviderName() {
    return 'automated';
  }

  getCapabilities() {
    return {
      supportedAts: [], // No ATS supported yet — stub
      supportsBulkApply: false,
      supportsStatusTracking: true,
      supportsCoverLetter: true,
      supportsAutoAnswers: true,
      requiresBrowser: true,
      requiresLogin: false,
      costPerApplication: 0.50, // Estimated for future third-party integration
      rateLimit: { requests: 10, perSeconds: 60 },
    };
  }

  async analyzeJob(job, userProfile) {
    // Stub: automated mode not yet available
    return {
      canApply: false,
      confidence: 0,
      atsType: this._detectAtsType(job),
      estimatedDifficulty: 'hard',
      missingFields: [],
      warnings: ['Automated application is not yet available. Please use Manual or Assisted mode.'],
      estimatedTime: null,
      requiresLogin: false,
      supportsAutoFill: false,
    };
  }

  async prepareApplication(job, userProfile, options = {}) {
    return {
      providerName: 'automated',
      resume: null,
      coverLetter: null,
      answers: {},
      missingFields: [],
      warnings: ['Automated application is not yet available.'],
      estimatedSubmissionTime: null,
      costEstimate: { provider: 0.50, ai: 0.05 },
    };
  }

  async submitApplication(preparedApp, job) {
    // Stub: not yet implemented
    return {
      success: false,
      providerJobId: null,
      submissionStatus: 'failed',
      confirmationUrl: null,
      failureReason: 'Automated application is not yet available. Please use Manual or Assisted mode.',
      missingFields: [],
      costActual: { provider: 0, ai: 0 },
      submittedAt: null,
    };
  }

  async getApplicationStatus(providerJobId) {
    return {
      status: 'pending',
      lastUpdated: new Date(),
      details: 'Automated submission not yet available.',
      nextAction: null,
    };
  }

  async cancelApplication(providerJobId) {
    return {
      success: true,
      message: 'Automated application cancelled.',
    };
  }

  async handleFailure(error, context) {
    return {
      action: 'manual',
      retryDelay: 0,
      maxRetries: 0,
      message: 'Automated submission failed. Please apply manually.',
      requiresUserInput: false,
    };
  }

  /**
   * Detect ATS type from job data.
   */
  _detectAtsType(job) {
    const url = (job.applicationUrl || job.sourceUrl || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const combined = url + ' ' + desc;

    if (combined.includes('greenhouse.io') || combined.includes('greenhouse')) return 'greenhouse';
    if (combined.includes('lever.co') || combined.includes('lever')) return 'lever';
    if (combined.includes('workday.com') || combined.includes('workday')) return 'workday';
    if (combined.includes('icims.com') || combined.includes('icims')) return 'icims';
    if (combined.includes('taleo') || combined.includes('oracle.com/careers')) return 'taleo';
    if (combined.includes('smartrecruiters')) return 'smartrecruiters';
    if (combined.includes('bamboohr')) return 'bamboohr';
    if (combined.includes('jazz.co') || combined.includes('jazzhr')) return 'jazzhr';
    if (combined.includes('jobvite')) return 'jobvite';
    if (combined.includes('ashbyhq') || combined.includes('ashby')) return 'ashby';
    if (combined.includes('myworkdayjobs')) return 'workday';
    if (combined.includes('linkedin.com/jobs')) return 'linkedin';

    return 'unknown';
  }

  /**
   * Register a sub-provider for a specific ATS.
   * Future use: when ATS-specific integrations are built.
   */
  registerSubProvider(atsType, provider) {
    this.subProviders.set(atsType, provider);
  }
}

module.exports = { AutomatedProvider };