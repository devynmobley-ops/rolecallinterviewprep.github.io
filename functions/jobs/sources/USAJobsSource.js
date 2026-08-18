/**
 * USAJobsSource — Job data provider using the USAJobs API.
 * 
 * USAJobs is the federal government's official job board.
 * Free tier: unlimited API access, requires API key + User-Agent.
 * 
 * API docs: https://developer.usajobs.gov/API/
 */

const https = require('https');
const { JobSource } = require('./JobSource');

const USAJOBS_BASE_URL = 'https://data.usajobs.gov/api/Search';

class USAJobsSource extends JobSource {
  constructor() {
    super();
    this.apiKey = process.env.USAJOBS_API_KEY || '';
    this.userAgent = process.env.USAJOBS_USER_AGENT || 'rolecallinterviewprep.com';
  }

  getSourceName() {
    return 'usajobs';
  }

  isConfigured() {
    return !!this.apiKey;
  }

  async fetchJobs(query, location, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('USAJobs API not configured. Set USAJOBS_API_KEY environment variable.');
    }

    const page = options.page || 1;
    const params = new URLSearchParams({
      Keyword: query || '',
      ResultsPerPage: '25',
      Page: page.toString(),
    });

    if (location) {
      params.set('LocationName', location);
    }

    const url = `${USAJOBS_BASE_URL}?${params.toString()}`;
    console.log(`[USAJobs] Fetching: ${query}, page ${page}`);

    const body = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': this.userAgent,
          'Authorization-Key': this.apiKey,
        },
      };
      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`USAJobs API error ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('USAJobs request timeout')); });
      req.end();
    });

    const data = JSON.parse(body);
    const result = data.SearchResult || {};
    const jobs = (result.SearchResultItems || []).map(item => this.normalizeJob(item));

    return {
      jobs,
      totalResults: result.SearchResultCountAll || 0,
      page: page,
    };
  }

  normalizeJob(item) {
    const match = item.MatchedObjectDescriptor || {};
    const position = match.PositionTitle || 'Untitled Position';
    const org = match.OrganizationName || 'Unknown Agency';
    const location = (match.PositionLocationDisplay || '').replace(/;/g, ', ');
    const desc = match.UserArea?.Details?.MajorDuties?.join(' ') || match.QualificationSummary || '';
    const minPay = match.PositionRemuneration?.[0]?.MinimumRange || null;
    const maxPay = match.PositionRemuneration?.[0]?.MaximumRange || null;
    const payInterval = match.PositionRemuneration?.[0]?.RateIntervalCode || 'Per Year';
    const posted = match.PublicStartDate ? new Date(match.PublicStartDate) : null;
    const applyUrl = match.ApplyURI?.[0] || '';
    const category = match.JobCategory?.[0]?.Name || null;
    const empType = match.PositionSchedule?.[0]?.Name || null;
    const seniority = match.UserArea?.Details?.LowGrade || null;

    return {
      sourceId: 'usajobs',
      externalId: item.MatchedObjectId || '',
      title: position,
      company: org,
      companyLogo: null,
      description: this.cleanText(desc),
      location: location || 'Various Locations',
      remote: this.detectRemote(position, desc, location),
      hybrid: this.detectHybrid(position, desc),
      employmentType: this.normalizeEmploymentType(empType),
      salaryMin: minPay ? Math.round(parseFloat(minPay)) : null,
      salaryMax: maxPay ? Math.round(parseFloat(maxPay)) : null,
      salaryCurrency: 'USD',
      category,
      seniority: this.inferSeniority(seniority, position),
      skills: this.extractSkills(position, desc),
      requirements: this.extractRequirements(desc),
      postedAt: posted,
      expiresAt: null,
      applicationUrl: applyUrl,
      sourceUrl: applyUrl,
      deduplicationKey: '',
      active: true,
      importedAt: new Date(),
      lastSyncedAt: new Date(),
    };
  }

  cleanText(text) {
    if (!text) return '';
    let t = text.replace(/<[^>]*>/g, ' ').replace(/&[a-zA-Z]+;/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > 3000) t = t.substring(0, 3000) + '...';
    return t;
  }

  detectRemote(title, desc, loc) {
    const t = (title + ' ' + desc + ' ' + loc).toLowerCase();
    return ['remote', 'telework', 'work from home', 'virtual', 'anywhere'].some(kw => t.includes(kw));
  }

  detectHybrid(title, desc) {
    const t = (title + ' ' + desc).toLowerCase();
    return t.includes('hybrid');
  }

  normalizeEmploymentType(type) {
    if (!type) return 'full-time';
    const lower = type.toLowerCase();
    if (lower.includes('full')) return 'full-time';
    if (lower.includes('part')) return 'part-time';
    if (lower.includes('temp') || lower.includes('term')) return 'contract';
    if (lower.includes('intern')) return 'internship';
    return 'full-time';
  }

  inferSeniority(grade, title) {
    if (!grade) return 'mid';
    const g = parseInt(grade);
    if (g <= 7) return 'entry';
    if (g <= 11) return 'mid';
    if (g <= 13) return 'senior';
    return 'executive';
  }

  extractSkills(title, desc) {
    const text = (title + ' ' + desc).toLowerCase();
    const skills = new Set();
    const patterns = [
      'security clearance', 'top secret', 'ts/sci',
      'project management', 'agile', 'scrum', 'data analysis',
      'excel', 'sql', 'python', 'java', 'javascript',
      'communication', 'leadership', 'training', 'compliance',
      'audit', 'budget', 'procurement', 'contracting',
    ];
    for (const p of patterns) {
      if (text.includes(p)) skills.add(p);
    }
    return Array.from(skills).slice(0, 10);
  }

  extractRequirements(desc) {
    const reqs = [];
    const lines = desc.split(/[.;\n]/);
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes('degree') || lower.includes('experience') || lower.includes('certification') ||
          lower.includes('clearance') || lower.includes('qualification')) {
        const cleaned = line.trim();
        if (cleaned.length > 10 && cleaned.length < 200) reqs.push(cleaned);
      }
    }
    return reqs.slice(0, 8);
  }
}

module.exports = { USAJobsSource };
