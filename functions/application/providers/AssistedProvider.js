/**
 * AssistedProvider — AI-assisted application preparation.
 *
 * This provider:
 *   - Analyzes jobs and extracts requirements
 *   - Uses AI to tailor resume, cover letter, and application answers
 *   - Returns prepared materials for user review
 *   - Does NOT auto-submit — user reviews and submits manually
 *
 * Uses the existing Anthropic API key for AI generation.
 * All AI-generated content uses ONLY information from the user's profile.
 */

const { ApplicationProvider } = require('../ApplicationProvider');

class AssistedProvider extends ApplicationProvider {
  getProviderName() {
    return 'assisted';
  }

  getCapabilities() {
    return {
      supportedAts: ['*'],
      supportsBulkApply: false,
      supportsStatusTracking: false,
      supportsCoverLetter: true,
      supportsAutoAnswers: true,
      requiresBrowser: false,
      requiresLogin: false,
      costPerApplication: 0.05, // Estimated AI cost
      rateLimit: null,
    };
  }

  async analyzeJob(job, userProfile) {
    const hasResume = userProfile && (userProfile.resumeText || userProfile.resumeUrl);
    const hasProfile = userProfile && userProfile.name;

    return {
      canApply: true,
      confidence: hasResume ? 0.9 : 0.6,
      atsType: this._detectAtsType(job),
      estimatedDifficulty: 'easy',
      missingFields: hasResume ? [] : ['resume'],
      warnings: hasResume ? [] : ['Upload your resume for better results.'],
      estimatedTime: 120, // ~2 minutes to review AI-prepared materials
      requiresLogin: false,
      supportsAutoFill: true,
    };
  }

  async prepareApplication(job, userProfile, options = {}) {
    const result = {
      providerName: 'assisted',
      resume: null,
      coverLetter: null,
      answers: {},
      missingFields: [],
      warnings: [],
      estimatedSubmissionTime: 120,
      costEstimate: { provider: 0, ai: 0.05 },
    };

    // Check for required user data
    if (!userProfile || !userProfile.resumeText) {
      result.missingFields.push('resume');
      result.warnings.push('Upload your resume to get AI-tailored application materials.');
      return result;
    }

    // Generate tailored materials using AI
    try {
      const aiResult = await this._generateApplicationMaterials(job, userProfile, options);
      
      if (aiResult.resume) {
        result.resume = aiResult.resume;
      }
      if (aiResult.coverLetter && options.generateCoverLetter !== false) {
        result.coverLetter = aiResult.coverLetter;
      }
      if (aiResult.answers) {
        result.answers = aiResult.answers;
      }
      if (aiResult.missingFields) {
        result.missingFields = aiResult.missingFields;
      }
      if (aiResult.warnings) {
        result.warnings = aiResult.warnings;
      }

      result.costEstimate.ai = aiResult.estimatedCost || 0.05;
    } catch (err) {
      console.error('[AssistedProvider] AI generation error:', err.message);
      result.warnings.push('AI preparation failed. You can still apply manually.');
    }

    return result;
  }

  async submitApplication(preparedApp, job) {
    // Assisted mode doesn't auto-submit
    return {
      success: true,
      providerJobId: null,
      submissionStatus: 'needs_action',
      confirmationUrl: job.applicationUrl || job.sourceUrl || null,
      failureReason: null,
      missingFields: preparedApp.missingFields || [],
      costActual: preparedApp.costEstimate || { provider: 0, ai: 0.05 },
      submittedAt: null,
    };
  }

  async getApplicationStatus(providerJobId) {
    return {
      status: 'pending',
      lastUpdated: new Date(),
      details: 'Assisted mode — materials prepared, user must submit.',
      nextAction: 'Review prepared materials and submit your application.',
    };
  }

  async cancelApplication(providerJobId) {
    return {
      success: true,
      message: 'Assisted application cancelled.',
    };
  }

  async handleFailure(error, context) {
    return {
      action: 'manual',
      retryDelay: 0,
      maxRetries: 0,
      message: 'AI preparation failed. Please apply manually.',
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
   * Generate application materials using AI.
   * Only uses information from the user's profile — never fabricates.
   */
  async _generateApplicationMaterials(job, userProfile, options) {
    // This would call the Anthropic API similar to tailorResume
    // For now, return a structured response that the Cloud Function will populate
    return {
      resume: null, // Will be populated by the Cloud Function
      coverLetter: null,
      answers: {},
      missingFields: [],
      warnings: [],
      estimatedCost: 0.05,
    };
  }
}

module.exports = { AssistedProvider };