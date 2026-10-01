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

    // Check for required user data — prefer base resume over tailored resume history
    const hasResume = userProfile && (userProfile.resumeText || userProfile.resumeStructured);
    if (!hasResume) {
      result.missingFields.push('resume');
      result.warnings.push('Upload your base resume in the Applications page to get AI-tailored application materials.');
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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        resume: null,
        coverLetter: null,
        answers: {},
        missingFields: [],
        warnings: ['AI service not configured.'],
        estimatedCost: 0,
      };
    }

    const resumeText = userProfile.resumeText || '';
    const jobTitle = job.title || 'Unknown Position';
    const company = job.company || 'Unknown Company';
    const jobDesc = job.description || '';
    const jobSkills = (job.skills || []).join(', ');
    const jobRequirements = (job.requirements || []).join('\n');

    // Build user profile summary for context
    const profileSummary = [
      userProfile.name ? `Name: ${userProfile.name}` : '',
      userProfile.email ? `Email: ${userProfile.email}` : '',
      userProfile.phone ? `Phone: ${userProfile.phone}` : '',
      userProfile.location ? `Location: ${userProfile.location}` : '',
      userProfile.linkedin ? `LinkedIn: ${userProfile.linkedin}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are a professional career advisor helping a user apply for a job. Generate application materials using ONLY information from the user's resume and profile. NEVER fabricate experience, degrees, certifications, skills, or accomplishments.

JOB DETAILS:
Title: ${jobTitle}
Company: ${company}
Description: ${jobDesc.substring(0, 3000)}
Key Skills: ${jobSkills}
Requirements: ${jobRequirements.substring(0, 2000)}

USER PROFILE:
${profileSummary}

USER RESUME:
${resumeText.substring(0, 6000)}

Generate the following in JSON format (no markdown, just raw JSON):

{
  "resume": {
    "tailored_summary": "2-3 sentence professional summary rewritten to emphasize relevance to this specific job",
    "key_changes": ["change 1", "change 2", "change 3"],
    "match_score": 75,
    "relevant_skills": ["skill1", "skill2", "skill3"]
  },
  "coverLetter": "A professional cover letter (3-4 paragraphs) tailored to this specific job and company. Use the user's actual experience from their resume. Address the hiring manager professionally. Mention specific requirements from the job description and how the user's experience matches. Do NOT fabricate any experience or qualifications.",
  "answers": {
    "Why are you interested in this role?": "Based on the user's background and this specific job",
    "What makes you a good fit?": "Based on actual resume experience",
    "Describe your relevant experience": "Based on actual work history"
  },
  "missing_fields": [],
  "warnings": []
}

Rules:
- Use ONLY information from the user's resume and profile
- NEVER invent experience, degrees, certifications, employers, or skills
- If the resume doesn't have enough information for a question, add it to "missing_fields"
- The cover letter should reference specific requirements from the job description
- Answers should be based on actual resume content
- If the user lacks required experience, note it in "warnings"
- Keep the cover letter professional and concise (3-4 paragraphs)
- Return ONLY valid JSON, no markdown formatting`;

    let result;
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error('[AssistedProvider] Anthropic API error:', resp.status, errText);
        throw new Error('API returned ' + resp.status);
      }

      const data = await resp.json();
      const responseText = data.content[0].text.trim();

      // Parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Could not parse AI response as JSON');
      }

      result = JSON.parse(jsonMatch[0]);
    } catch (err) {
      console.error('[AssistedProvider] AI generation error:', err.message);
      return {
        resume: null,
        coverLetter: null,
        answers: {},
        missingFields: [],
        warnings: ['AI generation failed: ' + err.message],
        estimatedCost: 0,
      };
    }

    // Estimate cost (Sonnet: ~$3/1M input, ~$15/1M output)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(JSON.stringify(result).length / 4);
    const estimatedCost = (inputTokens * 3 + outputTokens * 15) / 1000000;

    return {
      resume: result.resume || null,
      coverLetter: result.coverLetter || null,
      answers: result.answers || {},
      missingFields: result.missing_fields || [],
      warnings: result.warnings || [],
      estimatedCost: Math.max(estimatedCost, 0.01),
    };
  }
}

module.exports = { AssistedProvider };