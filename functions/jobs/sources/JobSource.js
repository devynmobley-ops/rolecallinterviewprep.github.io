/**
 * JobSource — Base interface for job data providers.
 * 
 * Every provider must implement these methods:
 *   fetchJobs(query, location, options) → { jobs: [...], totalResults, page }
 *   normalizeJob(rawJob) → RoleCallJobSchema
 *   getSourceName() → string
 * 
 * The RoleCallJobSchema is the normalized format all providers produce.
 */

class JobSource {
  /**
   * Fetch jobs from the provider.
   * @param {string} query - Search query (e.g. "training specialist")
   * @param {string} location - Location filter (e.g. "Philadelphia, PA" or "Remote")
   * @param {Object} options - Additional filters
   * @param {number} options.page - Page number (1-indexed)
   * @param {number} options.resultsPerPage - Results per page
   * @param {string} options.remote - "remote" | "hybrid" | "onsite" | null
   * @param {string} options.employmentType - "full-time" | "part-time" | "contract" | null
   * @param {number} options.salaryMin - Minimum salary filter
   * @param {string} options.sortBy - "relevance" | "date" | "salary"
   * @returns {{ jobs: Array, totalResults: number, page: number }}
   */
  async fetchJobs(query, location, options = {}) {
    throw new Error('fetchJobs() must be implemented by subclass');
  }

  /**
   * Normalize a raw provider job into the RoleCall schema.
   * @param {Object} rawJob - Raw job data from the provider
   * @returns {Object} Normalized RoleCall job
   */
  normalizeJob(rawJob) {
    throw new Error('normalizeJob() must be implemented by subclass');
  }

  /**
   * Get the source identifier.
   * @returns {string}
   */
  getSourceName() {
    throw new Error('getSourceName() must be implemented by subclass');
  }

  /**
   * Generate a deduplication key for a normalized job.
   * Uses company + normalized title + location to detect duplicates.
   * @param {Object} job - A normalized RoleCall job
   * @returns {string}
   */
  generateDedupKey(job) {
    const company = (job.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const title = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const location = (job.location || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${company}|${title}|${location}`;
  }
}

/**
 * RoleCall Job Schema — the normalized format all providers produce.
 * 
 * {
 *   sourceId: string,           // Provider name (e.g. "adzuna")
 *   externalId: string,         // Provider's unique job ID
 *   title: string,              // Job title
 *   company: string,            // Company name
 *   companyLogo: string|null,   // Company logo URL
 *   description: string,        // Full job description (plain text)
 *   location: string,           // Location string
 *   remote: boolean,            // Is remote
 *   hybrid: boolean,            // Is hybrid
 *   employmentType: string,     // "full-time" | "part-time" | "contract" | "internship"
 *   salaryMin: number|null,     // Minimum salary (annual, USD)
 *   salaryMax: number|null,     // Maximum salary (annual, USD)
 *   salaryCurrency: string,     // Currency code (default "USD")
 *   category: string|null,      // Job category/department
 *   seniority: string|null,     // "entry" | "mid" | "senior" | "lead" | "executive"
 *   skills: string[],           // Extracted skills/keywords
 *   requirements: string[],     // Key requirements
 *   postedAt: Date|null,        // When the job was posted
 *   expiresAt: Date|null,       // When the job expires
 *   applicationUrl: string,     // URL to apply (original employer page)
 *   sourceUrl: string,          // URL on the source platform
 *   deduplicationKey: string,   // Key for duplicate detection
 *   active: boolean,            // Whether the job is currently active
 *   importedAt: Date,           // When RoleCall imported it
 *   lastSyncedAt: Date,         // Last time it was synced
 * }
 */

module.exports = { JobSource };
