/**
 * CareerjetSource — Job data provider using the Careerjet API.
 *
 * Careerjet is a job aggregator with 40M+ jobs across 90+ countries.
 * Free tier: unlimited access via affiliate partner program.
 * Requires: API key (free from careerjet.com/partners)
 *
 * API docs: https://www.careerjet.com/partners/api/
 *
 * IMPORTANT: Careerjet requires displaying their branding on results.
 * This is handled by including the source URL which links back to Careerjet.
 */

const https = require('https');
const { JobSource } = require('./JobSource');

const CAREERJET_API_HOST = 'search.api.careerjet.net';
const CAREERJET_API_PATH = '/v4/query';

class CareerjetSource extends JobSource {
  getSourceName() {
    return 'careerjet';
  }

  isConfigured() {
    return !!process.env.CAREERJET_API_KEY;
  }

  async fetchJobs(query, location, options = {}) {
    if (!this.isConfigured()) {
      console.log('[Careerjet] No API key configured — skipping');
      return { jobs: [], totalResults: 0, page: 1 };
    }

    const page = options.page || 1;
    const pageSize = options.resultsPerPage || 25;

    const params = new URLSearchParams({
      locale_code: 'en_US',
      keywords: query || '',
      location: location || '',
      sort: 'relevance',
      page: page.toString(),
      page_size: Math.min(pageSize, 100).toString(),
      fragment_size: '300', // Get more description text
      user_ip: '0.0.0.0', // Required by API — server-side fetch
      user_agent: 'RoleCall/1.0 (job-search)',
    });

    // Add employment type filters
    if (options.employmentType === 'full-time') {
      params.set('work_hours', 'f');
    } else if (options.employmentType === 'part-time') {
      params.set('work_hours', 'p');
    }

    // Add contract type filter
    if (options.contractType) {
      params.set('contract_type', options.contractType);
    }

    const url = `${CAREERJET_API_PATH}?${params.toString()}`;
    console.log(`[Careerjet] Fetching page ${page} for "${query}"`);

    const apiKey = process.env.CAREERJET_API_KEY;
    const credentials = Buffer.from(`${apiKey}:`).toString('base64');

    const body = await new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: CAREERJET_API_HOST,
        path: url,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${credentials}`,
          'User-Agent': 'RoleCall/1.0',
        },
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Careerjet API error ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Careerjet request timeout'));
      });
      req.end();
    });

    const data = JSON.parse(body);

    // Handle location mode (multiple locations found)
    if (data.type === 'LOCATIONS') {
      console.log(`[Careerjet] Location mode: ${data.message}`);
      return { jobs: [], totalResults: 0, page: 1 };
    }

    // Handle no results
    if (data.type !== 'JOBS' || !data.jobs) {
      console.log(`[Careerjet] No jobs found: ${data.message || 'unknown'}`);
      return { jobs: [], totalResults: 0, page: 1 };
    }

    const jobs = data.jobs.map(raw => this.normalizeJob(raw));

    console.log(`[Careerjet] Got ${jobs.length} jobs (${data.hits} total hits, ${data.pages} pages)`);

    return {
      jobs,
      totalResults: data.hits || 0,
      page: page,
    };
  }

  normalizeJob(raw) {
    const title = raw.title || 'Untitled Position';
    const company = raw.company || 'Unknown Company';
    const description = this.cleanHtml(raw.description || '');
    const location = raw.locations || 'Unknown';

    // Parse salary
    let salaryMin = raw.salary_min || null;
    let salaryMax = raw.salary_max || null;
    let salaryCurrency = raw.salary_currency_code || 'USD';

    // Convert hourly/monthly/weekly to yearly estimates
    if (raw.salary_type === 'H') {
      // Hourly → yearly (2080 hours)
      if (salaryMin) salaryMin = Math.round(salaryMin * 2080);
      if (salaryMax) salaryMax = Math.round(salaryMax * 2080);
    } else if (raw.salary_type === 'M') {
      // Monthly → yearly
      if (salaryMin) salaryMin = Math.round(salaryMin * 12);
      if (salaryMax) salaryMax = Math.round(salaryMax * 12);
    } else if (raw.salary_type === 'W') {
      // Weekly → yearly
      if (salaryMin) salaryMin = Math.round(salaryMin * 52);
      if (salaryMax) salaryMax = Math.round(salaryMax * 52);
    } else if (raw.salary_type === 'D') {
      // Daily → yearly (260 working days)
      if (salaryMin) salaryMin = Math.round(salaryMin * 260);
      if (salaryMax) salaryMax = Math.round(salaryMax * 260);
    }

    // Parse date
    let postedAt = null;
    if (raw.date) {
      try {
        postedAt = new Date(raw.date);
      } catch (e) {
        // Ignore date parse errors
      }
    }

    // Generate external ID from URL (Careerjet doesn't provide one)
    const externalId = this.generateIdFromUrl(raw.url || '');

    return {
      sourceId: 'careerjet',
      externalId: externalId,
      title,
      company,
      companyLogo: null,
      description,
      location,
      remote: this.detectRemote(title, description, location),
      hybrid: this.detectHybrid(title, description),
      employmentType: this.detectEmploymentType(title, description),
      salaryMin,
      salaryMax,
      salaryCurrency,
      category: null,
      seniority: this.detectSeniority(title, description),
      skills: this.extractSkills(title, description),
      requirements: this.extractRequirements(description),
      postedAt,
      expiresAt: null,
      applicationUrl: raw.url || '',
      sourceUrl: raw.url || '',
      deduplicationKey: '',
      active: true,
      importedAt: new Date(),
      lastSyncedAt: new Date(),
    };
  }

  generateIdFromUrl(url) {
    // Generate a stable ID from the URL
    if (!url) return 'cj-' + Date.now();
    const crypto = require('crypto');
    return 'cj-' + crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
  }

  cleanHtml(html) {
    if (!html) return '';
    let text = html.replace(/<[^>]*>/g, ' ');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&[a-zA-Z]+;/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 3000) text = text.substring(0, 3000) + '...';
    return text;
  }

  detectRemote(title, desc, loc) {
    const t = (title + ' ' + desc + ' ' + loc).toLowerCase();
    return ['remote', 'work from home', 'wfh', 'telecommute', 'virtual', 'anywhere'].some(kw => t.includes(kw));
  }

  detectHybrid(title, desc) {
    const t = (title + ' ' + desc).toLowerCase();
    return t.includes('hybrid');
  }

  detectEmploymentType(title, desc) {
    const t = (title + ' ' + desc).toLowerCase();
    if (t.includes('part-time') || t.includes('part time')) return 'part-time';
    if (t.includes('contract') || t.includes('contractor')) return 'contract';
    if (t.includes('internship') || t.includes('intern')) return 'internship';
    if (t.includes('temporary') || t.includes('temp')) return 'contract';
    return 'full-time';
  }

  detectSeniority(title, desc) {
    const t = (title + ' ' + desc).toLowerCase();
    if (t.includes('senior') || t.includes('sr.') || t.includes('lead') || t.includes('principal')) return 'senior';
    if (t.includes('junior') || t.includes('jr.') || t.includes('entry') || t.includes('associate')) return 'entry';
    if (t.includes('director') || t.includes('vp ') || t.includes('vice president') || t.includes('c-level') || t.includes('chief')) return 'executive';
    if (t.includes('manager') || t.includes('head of')) return 'mid';
    return 'mid';
  }

  extractSkills(title, desc) {
    const text = (title + ' ' + desc).toLowerCase();
    const skills = new Set();
    const patterns = [
      'javascript', 'python', 'java', 'sql', 'react', 'node.js', 'aws', 'azure',
      'excel', 'power bi', 'tableau', 'salesforce', 'jira', 'confluence',
      'emr', 'epic', 'cerner', 'hipaa', 'project management', 'agile', 'scrum',
      'data analysis', 'reporting', 'compliance', 'communication', 'leadership',
      'training', 'mentoring', 'coaching', 'presentation',
    ];
    for (const p of patterns) {
      if (text.includes(p)) skills.add(p);
    }
    return Array.from(skills).slice(0, 10);
  }

  extractRequirements(desc) {
    const reqs = [];
    const lines = desc.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[\•\-\*\✓\✔]/.test(trimmed) || /^\d+\./.test(trimmed)) {
        const lower = trimmed.toLowerCase();
        if (lower.includes('required') || lower.includes('must have') || lower.includes('minimum') ||
            lower.includes('bachelor') || lower.includes('master') || lower.includes('degree') ||
            lower.includes('years of experience')) {
          const cleaned = trimmed.replace(/^[\•\-\*\✓\✔\d\.]+\s*/, '').trim();
          if (cleaned.length > 10 && cleaned.length < 200) reqs.push(cleaned);
        }
      }
    }
    return reqs.slice(0, 8);
  }
}

module.exports = { CareerjetSource };