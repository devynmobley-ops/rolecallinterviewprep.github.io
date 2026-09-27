/**
 * ApplicationProvider — Base interface for application submission providers.
 *
 * Every provider must implement these methods:
 *   analyzeJob(job, userProfile) → ApplicationAnalysis
 *   prepareApplication(job, userProfile, options) → PreparedApplication
 *   submitApplication(preparedApp) → SubmissionResult
 *   getApplicationStatus(providerJobId) → StatusUpdate
 *   cancelApplication(providerJobId) → CancelResult
 *   handleFailure(error, context) → FailureAction
 *   getProviderName() → string
 *   getCapabilities() → Capabilities
 *
 * The RoleCall application workflow:
 *   1. analyzeJob() — Can this provider handle this job?
 *   2. prepareApplication() — Prepare resume, cover letter, answers
 *   3. submitApplication() — Submit through the provider
 *   4. getApplicationStatus() — Poll for submission status
 *
 * Providers should NEVER fabricate user data. If information is missing,
 * return { needsUserAction: true, missingFields: [...] }.
 */

class ApplicationProvider {
  /**
   * Analyze a job to determine if this provider can handle it.
   * Returns feasibility assessment and any missing requirements.
   *
   * @param {Object} job - Normalized RoleCall job
   * @param {Object} userProfile - User's profile/resume data
   * @returns {Promise<ApplicationAnalysis>}
   *
   * ApplicationAnalysis: {
   *   canApply: boolean,
   *   confidence: number (0-1),
   *   atsType: string | null,        // e.g. "greenhouse", "lever", "workday", "unknown"
   *   estimatedDifficulty: string,    // "easy" | "medium" | "hard" | "impossible"
   *   missingFields: string[],        // Fields the user needs to provide
   *   warnings: string[],             // Potential issues
   *   estimatedTime: number | null,   // Estimated seconds to complete
   *   requiresLogin: boolean,         // Whether the ATS requires login
   *   supportsAutoFill: boolean,      // Whether fields can be auto-filled
   * }
   */
  async analyzeJob(job, userProfile) {
    throw new Error('analyzeJob() must be implemented by subclass');
  }

  /**
   * Prepare an application — generate resume, cover letter, answers.
   * Does NOT submit. Returns prepared data for user review.
   *
   * @param {Object} job - Normalized RoleCall job
   * @param {Object} userProfile - User's profile/resume data
   * @param {Object} options - Preparation options
   * @param {string} options.mode - "assisted" | "automated"
   * @param {boolean} options.generateCoverLetter - Whether to generate a cover letter
   * @param {Object} options.customAnswers - User-provided answers to override AI
   * @returns {Promise<PreparedApplication>}
   *
   * PreparedApplication: {
   *   providerName: string,
   *   resume: { text: string, pdf: string (base64) } | null,
   *   coverLetter: { text: string } | null,
   *   answers: { [fieldId]: { value: string, confidence: number, source: string } },
   *   missingFields: string[],
   *   warnings: string[],
   *   estimatedSubmissionTime: number | null,
   *   costEstimate: { provider: number, ai: number } | null,
   * }
   */
  async prepareApplication(job, userProfile, options = {}) {
    throw new Error('prepareApplication() must be implemented by subclass');
  }

  /**
   * Submit the application through the provider.
   *
   * @param {Object} preparedApp - Output from prepareApplication()
   * @param {Object} job - The original job
   * @returns {Promise<SubmissionResult>}
   *
   * SubmissionResult: {
   *   success: boolean,
   *   providerJobId: string | null,   // Provider's tracking ID
   *   submissionStatus: string,        // "submitted" | "pending" | "failed" | "blocked" | "needs_action"
   *   confirmationUrl: string | null,  // URL to confirm/check status
   *   failureReason: string | null,
   *   missingFields: string[],
   *   costActual: { provider: number, ai: number } | null,
   *   submittedAt: Date | null,
   * }
   */
  async submitApplication(preparedApp, job) {
    throw new Error('submitApplication() must be implemented by subclass');
  }

  /**
   * Get the current status of a submitted application.
   *
   * @param {string} providerJobId - The provider's tracking ID
   * @returns {Promise<StatusUpdate>}
   *
   * StatusUpdate: {
   *   status: string,       // "pending" | "submitted" | "reviewed" | "interview" | "rejected" | "offer"
   *   lastUpdated: Date,
   *   details: string | null,
   *   nextAction: string | null,
   * }
   */
  async getApplicationStatus(providerJobId) {
    throw new Error('getApplicationStatus() must be implemented by subclass');
  }

  /**
   * Cancel or withdraw a submitted application.
   *
   * @param {string} providerJobId - The provider's tracking ID
   * @returns {Promise<CancelResult>}
   *
   * CancelResult: {
   *   success: boolean,
   *   message: string,
   * }
   */
  async cancelApplication(providerJobId) {
    throw new Error('cancelApplication() must be implemented by subclass');
  }

  /**
   * Handle a failure during the application process.
   * Returns the recommended action.
   *
   * @param {Error} error - The error that occurred
   * @param {Object} context - Context about what stage failed
   * @returns {Promise<FailureAction>}
   *
   * FailureAction: {
   *   action: string,        // "retry" | "skip" | "manual" | "abort" | "ask_user"
   *   retryDelay: number,    // ms to wait before retry (if action=retry)
   *   maxRetries: number,
   *   message: string,       // User-facing message
   *   requiresUserInput: boolean,
   * }
   */
  async handleFailure(error, context) {
    throw new Error('handleFailure() must be implemented by subclass');
  }

  /**
   * Get the provider name.
   * @returns {string}
   */
  getProviderName() {
    throw new Error('getProviderName() must be implemented by subclass');
  }

  /**
   * Get the provider's capabilities.
   * @returns {Capabilities}
   *
   * Capabilities: {
   *   supportedAts: string[],         // ATS types this provider can handle
   *   supportsBulkApply: boolean,
   *   supportsStatusTracking: boolean,
   *   supportsCoverLetter: boolean,
   *   supportsAutoAnswers: boolean,
   *   requiresBrowser: boolean,       // Needs browser automation
   *   requiresLogin: boolean,         // Needs user's ATS credentials
   *   costPerApplication: number | null,  // Estimated cost in USD
   *   rateLimit: { requests: number, perSeconds: number } | null,
   * }
   */
  getCapabilities() {
    throw new Error('getCapabilities() must be implemented by subclass');
  }
}

module.exports = { ApplicationProvider };