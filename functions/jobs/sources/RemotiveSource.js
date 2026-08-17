/**
 * RemotiveSource — Job data provider using the Remotive API.
 * 
 * Remotive is a legitimate remote job board.
 * Free tier: unlimited API access, no key required.
 * 
 * API docs: https://remotive.com/api-documentation
 */

const https = require('https');
const { JobSource } = require('./JobSource');

const REMOTIVE_BASE_URL = 'https://remotive.com/api/remote-jobs';

class RemotiveSource extends JobSource {
  getSourceName() {
    return 'remotive';
  }

  async fetchJobs(query, location, options = {}) {
    const params = new URLSearchParams();
    if (query) params.set('search', query);
    if (options.limit) params.set('limit', options.limit.toString());

    const url = `${REMOTIVE_BASE_URL}${params.toString() ? '?' + params.toString() : ''}`;
    console.log(`[Remotive] Fetching: ${query || 'all'}`);

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
            reject(new Error(`Remotive API error ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Remotive request timeout')); });
      req.end();
    });

    const data = JSON.parse(body);
    const jobs = (data.jobs || []).map(raw => this.normalizeJob(raw));

    return {
      jobs,
      totalResults: data['job-count'] || jobs.length,
      page: 1,
    };
  }

  normalizeJob(raw) {
    const title = raw.title || 'Untitled Position';
    const company = raw.company_name || 'Unknown Company';
    const description = this.cleanHtml(raw.description || '');
    const location = raw.candidate_required_location || 'Remote';
    const postedAt = raw.publication_date ? new Date(raw.publication_date) : null;
    const category = raw.category || null;
    const salary = this.extractSalary(raw.salary);

    return {
      sourceId: 'remotive',
      externalId: String(raw.id || ''),
      title,
      company,
      companyLogo: raw.company_logo || null,
      description,
      location,
      remote: true, // Remotive is all remote
      hybrid: false,
      employmentType: this.normalizeJobType(raw.job_type),
      salaryMin: salary.min,
      salaryMax: salary.max,
      salaryCurrency: 'USD',
      category,
      seniority: this.inferSeniority(title, description),
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

  extractSalary(salaryStr) {
    if (!salaryStr) return { min: null, max: null };
    // Try to extract numbers from salary string
    const numbers = salaryStr.match(/[\d,]+/g);
    if (numbers && numbers.length >= 2) {
      return { min: parseInt(numbers[0].replace(/,/g, '')), max: parseInt(numbers[1].replace(/,/g, '')) };
    }
    if (numbers && numbers.length === 1) {
      return { min: parseInt(numbers[0].replace(/,/g, '')), max: null };
    }
    return { min: null, max: null };
  }

  normalizeJobType(type) {
    if (!type) return 'full-time';
    const lower = type.toLowerCase();
    if (lower.includes('full')) return 'full-time';
    if (lower.includes('part')) return 'part-time';
    if (lower.includes('contract') || lower.includes('freelance')) return 'contract';
    if (lower.includes('intern')) return 'internship';
    return 'full-time';
  }

  inferSeniority(title, desc) {
    const t = (title + ' ' + desc).toLowerCase();
    if (/\b(intern|internship)\b/.test(t)) return 'entry';
    if (/\b(junior|jr\.?|entry.level|associate)\b/.test(t)) return 'entry';
    if (/\b(senior|sr\.?|lead|principal|staff)\b/.test(t)) return 'senior';
    if (/\b(manager|director|head of|vp|chief)\b/.test(t)) return 'executive';
    return 'mid';
  }

  extractSkills(title, desc) {
    const text = (title + ' ' + desc).toLowerCase();
    const skills = new Set();
    const patterns = [
      'javascript', 'python', 'java', 'sql', 'react', 'node.js', 'aws', 'azure',
      'typescript', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin',
      'docker', 'kubernetes', 'terraform', 'figma', 'sketch',
      'project management', 'agile', 'scrum', 'data analysis',
      'communication', 'leadership', 'training',
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

module.exports = { RemotiveSource };
