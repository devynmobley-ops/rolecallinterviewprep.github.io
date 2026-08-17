/**
 * TheMuseSource — Job data provider using The Muse API.
 * 
 * The Muse is a legitimate job platform with company profiles.
 * Free tier: unlimited API access, no key required.
 * 
 * API docs: https://www.themuse.com/developers/api/v2
 */

const https = require('https');
const { JobSource } = require('./JobSource');

const MUSE_BASE_URL = 'https://www.themuse.com/api/public/jobs';

class TheMuseSource extends JobSource {
  getSourceName() {
    return 'themuse';
  }

  async fetchJobs(query, location, options = {}) {
    const page = options.page || 1;
    const params = new URLSearchParams({
      page: page.toString(),
    });

    // The Muse API supports category and level filters
    if (query) {
      // The Muse doesn't have a direct search param, but we can filter by category
      // We'll fetch all and filter in normalize
    }

    const url = `${MUSE_BASE_URL}?${params.toString()}`;
    console.log(`[TheMuse] Fetching page ${page}`);

    const body = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const reqOptions = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'RoleCall/1.0' },
      };
      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`TheMuse API error ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('TheMuse request timeout')); });
      req.end();
    });

    const data = JSON.parse(body);
    const jobs = (data.results || []).map(raw => this.normalizeJob(raw));

    // Filter by query in title/description if provided
    let filtered = jobs;
    if (query) {
      const queryLower = query.toLowerCase();
      const terms = queryLower.split(/\s+/);
      filtered = jobs.filter(job => {
        const text = (job.title + ' ' + job.description + ' ' + job.company).toLowerCase();
        return terms.some(term => text.includes(term));
      });
    }

    return {
      jobs: filtered,
      totalResults: data.total || 0,
      page: page,
    };
  }

  normalizeJob(raw) {
    const locations = (raw.locations || []).map(l => l.name).join(', ');
    const level = raw.levels && raw.levels.length > 0 ? raw.levels[0].name : null;
    const category = raw.categories && raw.categories.length > 0 ? raw.categories[0].name : null;
    const description = this.cleanHtml(raw.contents || '');
    const title = raw.name || 'Untitled Position';
    const company = raw.company ? raw.company.name : 'Unknown Company';
    const postedAt = raw.publication_date ? new Date(raw.publication_date) : null;
    const landingPage = raw.refs ? raw.refs.landing_page : '';

    return {
      sourceId: 'themuse',
      externalId: String(raw.id || ''),
      title,
      company,
      companyLogo: null,
      description,
      location: locations || 'Unknown',
      remote: this.detectRemote(title, description, locations),
      hybrid: this.detectHybrid(title, description),
      employmentType: 'full-time', // The Muse doesn't always specify
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: 'USD',
      category,
      seniority: this.normalizeLevel(level),
      skills: this.extractSkills(title, description),
      requirements: this.extractRequirements(description),
      postedAt,
      expiresAt: null,
      applicationUrl: landingPage,
      sourceUrl: landingPage,
      deduplicationKey: '',
      active: true,
      importedAt: new Date(),
      lastSyncedAt: new Date(),
    };
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

  normalizeLevel(level) {
    if (!level) return 'mid';
    const lower = level.toLowerCase();
    if (lower.includes('entry') || lower.includes('junior')) return 'entry';
    if (lower.includes('senior') || lower.includes('lead') || lower.includes('principal')) return 'senior';
    if (lower.includes('director') || lower.includes('executive') || lower.includes('c-level')) return 'executive';
    return 'mid';
  }

  detectRemote(title, desc, loc) {
    const t = (title + ' ' + desc + ' ' + loc).toLowerCase();
    return ['remote', 'work from home', 'wfh', 'telecommute', 'virtual', 'anywhere'].some(kw => t.includes(kw));
  }

  detectHybrid(title, desc) {
    const t = (title + ' ' + desc).toLowerCase();
    return t.includes('hybrid');
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

module.exports = { TheMuseSource };
