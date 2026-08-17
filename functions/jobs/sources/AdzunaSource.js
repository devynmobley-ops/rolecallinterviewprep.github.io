/**
 * AdzunaSource — Job data provider using the Adzuna API.
 * 
 * Adzuna is a legitimate job aggregator with an official API.
 * Free tier: up to 10,000 calls/month.
 * 
 * Requires environment variables:
 *   ADZUNA_APP_ID  — Your Adzuna app ID
 *   ADZUNA_API_KEY — Your Adzuna API key
 * 
 * API docs: https://developer.adzuna.com/overview
 */

const https = require('https');
const { JobSource } = require('./JobSource');

const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';

// Map of US states for location normalization
const US_STATES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC'
};

class AdzunaSource extends JobSource {
  constructor() {
    super();
    this.appId = process.env.ADZUNA_APP_ID;
    this.apiKey = process.env.ADZUNA_API_KEY;
    this.country = 'us'; // Adzuna country code
  }

  getSourceName() {
    return 'adzuna';
  }

  isConfigured() {
    return !!(this.appId && this.apiKey);
  }

  /**
   * Build the Adzuna API URL for a search.
   */
  buildUrl(query, page, options = {}) {
    const resultsPerPage = options.resultsPerPage || 25;
    const params = new URLSearchParams({
      app_id: this.appId,
      app_key: this.apiKey,
      results_per_page: Math.min(resultsPerPage, 50).toString(),
      page: (page || 1).toString(),
      what: query || '',
      max_days_old: '30', // Only jobs from last 30 days
    });

    // Location filter
    if (options.location && options.location.toLowerCase() !== 'remote') {
      params.set('where', options.location);
    }

    // Remote filter
    if (options.remote === 'remote') {
      params.set('remote', '1');
    }

    // Salary minimum
    if (options.salaryMin) {
      params.set('salary_min', options.salaryMin.toString());
    }

    // Sort
    if (options.sortBy === 'date') {
      params.set('sort_by', 'date');
    } else if (options.sortBy === 'salary') {
      params.set('sort_by', 'salary');
    }

    return `${ADZUNA_BASE_URL}/${this.country}/search/${page || 1}?${params.toString()}`;
  }

  /**
   * Fetch jobs from Adzuna.
   */
  async fetchJobs(query, location, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Adzuna API not configured. Set ADZUNA_APP_ID and ADZUNA_API_KEY environment variables.');
    }

    const url = this.buildUrl(query, options.page || 1, { ...options, location });
    
    console.log(`[Adzuna] Fetching: ${query} in ${location || 'anywhere'}, page ${options.page || 1}`);
    
    const body = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'RoleCall/1.0',
        },
      };
      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Adzuna API error ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Adzuna request timeout')); });
      req.end();
    });
    
    const data = JSON.parse(body);
    
    const jobs = (data.results || []).map(raw => this.normalizeJob(raw));
    
    return {
      jobs,
      totalResults: data.count || 0,
      page: options.page || 1,
    };
  }

  /**
   * Normalize an Adzuna job into the RoleCall schema.
   */
  normalizeJob(raw) {
    const location = this.extractLocation(raw);
    const salary = this.extractSalary(raw);
    const postedAt = raw.created ? new Date(raw.created) : null;
    const isRemote = this.detectRemote(raw);
    
    return {
      sourceId: 'adzuna',
      externalId: String(raw.id || ''),
      title: raw.title || 'Untitled Position',
      company: raw.company?.display_name || 'Unknown Company',
      companyLogo: raw.company?.logo || null,
      description: this.cleanDescription(raw.description || ''),
      location: location.display,
      remote: isRemote,
      hybrid: this.detectHybrid(raw),
      employmentType: this.normalizeEmploymentType(raw.contract_type, raw.contract_time),
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryCurrency: 'USD',
      category: raw.category?.label || null,
      seniority: this.inferSeniority(raw.title || '', raw.description || ''),
      skills: this.extractSkills(raw.title || '', raw.description || ''),
      requirements: this.extractRequirements(raw.description || ''),
      postedAt,
      expiresAt: raw.valid_through ? new Date(raw.valid_through) : null,
      applicationUrl: raw.redirect_url || raw.url || '',
      sourceUrl: raw.redirect_url || '',
      deduplicationKey: '', // Set by JobSource.generateDedupKey after normalization
      active: true,
      importedAt: new Date(),
      lastSyncedAt: new Date(),
    };
  }

  /**
   * Extract location information.
   */
  extractLocation(raw) {
    const loc = raw.location || {};
    const areas = loc.area || [];
    
    // Adzuna area array: [country, state, city, ...]
    const city = areas.length > 2 ? areas[areas.length - 1] : '';
    const state = areas.length > 1 ? areas[areas.length - 2] : '';
    
    const parts = [city, state].filter(Boolean);
    return {
      display: parts.length > 0 ? parts.join(', ') : (loc.display_name || 'Unknown'),
      city,
      state,
    };
  }

  /**
   * Extract salary information.
   */
  extractSalary(raw) {
    if (raw.salary_min != null && raw.salary_max != null) {
      return {
        min: Math.round(raw.salary_min),
        max: Math.round(raw.salary_max),
      };
    }
    if (raw.salary_is_predicted === '1' && raw.salary_min != null) {
      return {
        min: Math.round(raw.salary_min),
        max: raw.salary_max ? Math.round(raw.salary_max) : null,
      };
    }
    return { min: null, max: null };
  }

  /**
   * Detect if a job is remote.
   */
  detectRemote(raw) {
    const title = (raw.title || '').toLowerCase();
    const desc = (raw.description || '').toLowerCase();
    const locDisplay = (raw.location?.display_name || '').toLowerCase();
    
    const remoteKeywords = ['remote', 'work from home', 'wfh', 'telecommute', 'virtual', 'anywhere'];
    return remoteKeywords.some(kw => 
      title.includes(kw) || locDisplay.includes(kw) || desc.includes('fully remote') || desc.includes('100% remote')
    );
  }

  /**
   * Detect if a job is hybrid.
   */
  detectHybrid(raw) {
    const title = (raw.title || '').toLowerCase();
    const desc = (raw.description || '').toLowerCase();
    
    return title.includes('hybrid') || desc.includes('hybrid schedule') || desc.includes('hybrid work');
  }

  /**
   * Normalize employment type from Adzuna fields.
   */
  normalizeEmploymentType(contractType, contractTime) {
    if (contractTime === 'full_time') return 'full-time';
    if (contractTime === 'part_time') return 'part-time';
    if (contractType === 'contract') return 'contract';
    if (contractType === 'internship') return 'internship';
    if (contractType === 'permanent') return 'full-time';
    return 'full-time'; // Default
  }

  /**
   * Infer seniority level from title and description.
   */
  inferSeniority(title, description) {
    const t = (title + ' ' + description).toLowerCase();
    
    if (/\b(intern|internship)\b/.test(t)) return 'entry';
    if (/\b(junior|jr\.?|entry.level|associate|assistant)\b/.test(t)) return 'entry';
    if (/\b(senior|sr\.?|lead|principal|staff)\b/.test(t)) return 'senior';
    if (/\b(manager|director|head of|vp|vice president|chief|c-suite)\b/.test(t)) return 'executive';
    if (/\b(mid.level|experienced)\b/.test(t)) return 'mid';
    
    return 'mid'; // Default assumption
  }

  /**
   * Extract skills/keywords from title and description.
   */
  extractSkills(title, description) {
    const text = (title + ' ' + description).toLowerCase();
    const skills = new Set();
    
    // Common skill patterns
    const skillPatterns = [
      // Technical
      'javascript', 'python', 'java', 'sql', 'react', 'node.js', 'aws', 'azure',
      'excel', 'power bi', 'tableau', 'salesforce', 'jira', 'confluence',
      'sharepoint', 'teams', 'slack', 'figma', 'photoshop',
      // Healthcare
      'emr', 'epic', 'cerner', 'ehr', 'hipaa', 'patient care', 'clinical',
      'nursing', 'patient safety', 'medical terminology',
      // Business
      'project management', 'agile', 'scrum', 'lean', 'six sigma',
      'data analysis', 'reporting', 'compliance', 'audit',
      // Soft skills
      'communication', 'leadership', 'teamwork', 'problem solving',
      'training', 'mentoring', 'coaching', 'presentation',
      // Education
      'curriculum', 'instructional design', 'lms', 'e-learning',
      'teaching', 'facilitation', 'adult learning',
    ];
    
    for (const skill of skillPatterns) {
      if (text.includes(skill)) {
        skills.add(skill);
      }
    }
    
    return Array.from(skills).slice(0, 10); // Cap at 10 skills
  }

  /**
   * Extract key requirements from description.
   */
  extractRequirements(description) {
    const requirements = [];
    const lines = description.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Look for requirement-like lines (bullets with "required", "must have", "minimum", etc.)
      if (/^[\•\-\*\✓\✔]/.test(trimmed) || /^\d+\./.test(trimmed)) {
        const lower = trimmed.toLowerCase();
        if (lower.includes('required') || lower.includes('must have') || 
            lower.includes('minimum') || lower.includes('bachelor') || 
            lower.includes('master') || lower.includes('degree') ||
            lower.includes('years of experience') || lower.includes('certification')) {
          // Clean up the bullet point
          const cleaned = trimmed.replace(/^[\•\-\*\✓\✔\d\.]+\s*/, '').trim();
          if (cleaned.length > 10 && cleaned.length < 200) {
            requirements.push(cleaned);
          }
        }
      }
    }
    
    return requirements.slice(0, 8); // Cap at 8 requirements
  }

  /**
   * Clean HTML/description text into plain text.
   */
  cleanDescription(raw) {
    if (!raw) return '';
    
    // Remove HTML tags
    let text = raw.replace(/<[^>]*>/g, ' ');
    // Decode HTML entities
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim();
    // Truncate to reasonable length for storage
    if (text.length > 3000) {
      text = text.substring(0, 3000) + '...';
    }
    
    return text;
  }
}

module.exports = { AdzunaSource };
