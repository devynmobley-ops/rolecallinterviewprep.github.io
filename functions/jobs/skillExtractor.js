/**
 * Shared skill and requirement extraction for all job sources.
 * 
 * Provides consistent, high-quality skill detection across all providers.
 */

// Comprehensive skill patterns organized by category
const SKILL_PATTERNS = {
  // Programming Languages
  languages: [
    'javascript', 'typescript', 'python', 'java', 'c\\+\\+', 'c#', 'ruby', 'php',
    'swift', 'kotlin', 'go', 'golang', 'rust', 'scala', 'r\\b', 'perl', 'sql',
    'nosql', 'html', 'css', 'sass', 'less', 'coffeescript',
  ],
  
  // Frameworks & Libraries
  frameworks: [
    'react', 'reactjs', 'react\\.js', 'angular', 'angularjs', 'vue', 'vuejs', 'vue\\.js',
    'node\\.js', 'nodejs', 'express', 'django', 'flask', 'spring', 'spring boot',
    'rails', 'ruby on rails', 'laravel', 'symfony', 'asp\\.net', 'dotnet',
    'next\\.js', 'nextjs', 'nuxt', 'svelte', 'jquery', 'bootstrap', 'tailwind',
    'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy',
  ],
  
  // Cloud & DevOps
  cloud: [
    'aws', 'amazon web services', 'azure', 'gcp', 'google cloud', 'heroku',
    'digitalocean', 'docker', 'kubernetes', 'k8s', 'terraform', 'ansible',
    'jenkins', 'ci/cd', 'ci cd', 'github actions', 'gitlab ci', 'circleci',
    'nginx', 'apache', 'linux', 'unix', 'bash', 'shell scripting',
  ],
  
  // Databases
  databases: [
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch',
    'dynamodb', 'firebase', 'firestore', 'sqlite', 'oracle', 'sql server',
    'cassandra', 'neo4j', 'couchdb',
  ],
  
  // Data & Analytics
  data: [
    'tableau', 'power bi', 'powerbi', 'looker', 'google analytics', 'mixpanel',
    'amplitude', 'segment', 'snowflake', 'bigquery', 'redshift', 'spark',
    'hadoop', 'kafka', 'airflow', 'dbt', 'etl', 'data pipeline',
    'machine learning', 'ml', 'ai', 'artificial intelligence', 'deep learning',
    'nlp', 'natural language processing', 'computer vision',
  ],
  
  // Design & Creative
  design: [
    'figma', 'sketch', 'adobe xd', 'photoshop', 'illustrator', 'indesign',
    'after effects', 'premiere pro', 'final cut', 'blender', 'maya',
    'ui/ux', 'ui ux', 'user experience', 'user interface', 'wireframing',
    'prototyping', 'graphic design', 'web design',
  ],
  
  // Business & Product
  business: [
    'product management', 'project management', 'agile', 'scrum', 'kanban',
    'jira', 'confluence', 'asana', 'trello', 'monday\\.com', 'notion',
    'slack', 'microsoft teams', 'zoom', 'salesforce', 'hubspot', 'marketo',
    'google workspace', 'microsoft office', 'excel', 'word', 'powerpoint',
    'sharepoint', 'outlook',
  ],
  
  // Healthcare
  healthcare: [
    'emr', 'ehr', 'epic', 'cerner', 'allscripts', 'meditech',
    'hipaa', 'hippa', 'clinical', 'patient care', 'nursing',
    'pharmacy', 'radiology', 'laboratory', 'medical coding', 'icd-10', 'cpt',
    'electronic health records', 'medical terminology',
  ],
  
  // Finance & Accounting
  finance: [
    'gaap', 'ifrs', 'financial reporting', 'financial analysis',
    'accounts payable', 'accounts receivable', 'general ledger',
    'budgeting', 'forecasting', 'variance analysis', 'audit',
    'tax', 'tax preparation', 'bookkeeping', 'quickbooks', 'xero',
    'sap', 'oracle financials', 'bloomberg', 'reuters',
  ],
  
  // Soft Skills
  softSkills: [
    'communication', 'leadership', 'teamwork', 'problem solving',
    'critical thinking', 'time management', 'organization',
    'attention to detail', 'analytical', 'interpersonal',
    'presentation', 'public speaking', 'negotiation',
    'customer service', 'client relations', 'mentoring', 'coaching',
    'training', 'teaching', 'instructional design',
  ],
};

// Flatten all patterns for quick matching
const ALL_SKILLS = Object.values(SKILL_PATTERNS).flat();

// Common certifications
const CERTIFICATION_PATTERNS = [
  'pmp', 'csm', 'csm', 'aws certified', 'azure certified', 'gcp certified',
  'comptia', 'security\\+', 'network\\+', 'a\\+',
  'cissp', 'cism', 'cisa', 'ceh',
  'phr', 'sphr', 'shrm-cp', 'shrm-scp',
  'cpa', 'cfa', 'frm',
  'rn', 'bsn', 'msn', 'np', 'pa-c',
  'six sigma', 'lean', 'itil',
];

/**
 * Extract skills from job title and description.
 * Returns array of skill strings (lowercase, deduplicated).
 */
function extractSkills(title, description) {
  const text = (title + ' ' + description).toLowerCase();
  const found = new Set();
  
  // Check all skill patterns
  for (const pattern of ALL_SKILLS) {
    const regex = new RegExp(`\\b${pattern}\\b`, 'i');
    if (regex.test(text)) {
      // Normalize the skill name
      const normalized = normalizeSkillName(pattern);
      if (normalized) found.add(normalized);
    }
  }
  
  // Check certifications
  for (const cert of CERTIFICATION_PATTERNS) {
    const regex = new RegExp(`\\b${cert}\\b`, 'i');
    if (regex.test(text)) {
      found.add(cert.replace(/\\/g, '').toUpperCase());
    }
  }
  
  return Array.from(found).slice(0, 15);
}

/**
 * Normalize skill name to a consistent format.
 */
function normalizeSkillName(pattern) {
  const map = {
    'reactjs': 'react',
    'react\\.js': 'react',
    'vuejs': 'vue',
    'vue\\.js': 'vue',
    'nodejs': 'node.js',
    'node\\.js': 'node.js',
    'nextjs': 'next.js',
    'next\\.js': 'next.js',
    'powerbi': 'power bi',
    'k8s': 'kubernetes',
    'ci/cd': 'ci/cd',
    'ci cd': 'ci/cd',
    'ui/ux': 'ui/ux',
    'ui ux': 'ui/ux',
    'machine learning': 'machine learning',
    'ml': 'machine learning',
    'ai': 'artificial intelligence',
    'artificial intelligence': 'artificial intelligence',
    'nlp': 'nlp',
    'natural language processing': 'nlp',
    'hippa': 'hipaa',
    'ehr': 'emr/ehr',
    'emr': 'emr/ehr',
  };
  
  const cleaned = pattern.replace(/\\/g, '').replace(/\\./g, '.');
  return map[cleaned] || cleaned;
}

/**
 * Extract requirements from job description.
 * Returns array of requirement strings.
 */
function extractRequirements(description) {
  if (!description) return [];
  
  const reqs = [];
  const lines = description.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Check if line looks like a requirement
    const isListItem = /^[\•\-\*✓✔▸▹►→]/.test(trimmed) || /^\d+[\.\)]\s/.test(trimmed);
    if (!isListItem) continue;
    
    const lower = trimmed.toLowerCase();
    
    // Look for requirement indicators
    const isRequirement = 
      lower.includes('required') ||
      lower.includes('must have') ||
      lower.includes('minimum') ||
      lower.includes('bachelor') ||
      lower.includes('master') ||
      lower.includes('degree') ||
      lower.includes('years of experience') ||
      lower.includes('experience with') ||
      lower.includes('proficiency') ||
      lower.includes('knowledge of') ||
      lower.includes('familiarity with') ||
      lower.includes('ability to') ||
      lower.includes('strong') ||
      lower.includes('excellent') ||
      lower.includes('proven') ||
      lower.includes('demonstrated');
    
    if (isRequirement) {
      const cleaned = trimmed.replace(/^[\•\-\*✓✔▸▹►→\d\.\)]+\s*/, '').trim();
      if (cleaned.length > 10 && cleaned.length < 300) {
        reqs.push(cleaned);
      }
    }
  }
  
  return reqs.slice(0, 10);
}

/**
 * Extract salary from text if not provided by API.
 */
function extractSalaryFromText(text) {
  if (!text) return { min: null, max: null, currency: 'USD' };
  
  const patterns = [
    // $50,000 - $70,000
    /\$(\d{1,3}(?:,\d{3})*)\s*(?:-|to|–)\s*\$(\d{1,3}(?:,\d{3})*)/i,
    // $50K - $70K
    /\$(\d{1,3})k\s*(?:-|to|–)\s*\$(\d{1,3})k/i,
    // $50,000+
    /\$(\d{1,3}(?:,\d{3})*)\+?/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let min = parseInt(match[1].replace(/,/g, ''));
      let max = match[2] ? parseInt(match[2].replace(/,/g, '')) : null;
      
      // Handle K notation
      if (pattern.toString().includes('k')) {
        min *= 1000;
        if (max) max *= 1000;
      }
      
      // Sanity check (annual salary should be between $20K and $500K)
      if (min >= 20000 && min <= 500000) {
        return { min, max, currency: 'USD' };
      }
    }
  }
  
  return { min: null, max: null, currency: 'USD' };
}

module.exports = {
  extractSkills,
  extractRequirements,
  extractSalaryFromText,
  SKILL_PATTERNS,
  ALL_SKILLS,
};