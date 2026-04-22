const fs = require('fs');
const path = require('path');

// Read index.html and extract DATA, CERTS, DIFFICULTY objects
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function extractObject(source, varName) {
  const startRe = new RegExp('const ' + varName + ' = \\{');
  const match = source.match(startRe);
  if (!match) throw new Error('Could not find ' + varName);
  const startIdx = match.index + match[0].length - 1;
  // Find matching closing brace
  let depth = 0;
  let i = startIdx;
  while (i < source.length) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  const objStr = source.substring(startIdx, i + 1);
  return eval('(' + objStr + ')');
}

const DATA = extractObject(html, 'DATA');
const CERTS = extractObject(html, 'CERTS');
const DIFFICULTY = extractObject(html, 'DIFFICULTY');
const CATEGORY_DEFAULT = extractObject(html, 'CATEGORY_DEFAULT_DIFFICULTY');

function getDifficulty(roleName) {
  if (DIFFICULTY[roleName]) return DIFFICULTY[roleName];
  for (const [catName, cat] of Object.entries(DATA)) {
    if (cat.roles[roleName]) return CATEGORY_DEFAULT[catName] || 'Entry';
  }
  return 'Entry';
}

function getCategory(roleName) {
  for (const [catName, cat] of Object.entries(DATA)) {
    if (cat.roles[roleName]) return catName;
  }
  return 'Other';
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generatePage(roleName, category) {
  const questions = DATA[category].roles[roleName];
  const certs = CERTS[roleName];
  const difficulty = getDifficulty(roleName);
  const slug = slugify(roleName);
  const url = 'https://rollcallinterviewprep.com/interview/' + slug + '.html';
  const icon = DATA[category].icon;

  const freeQuestions = questions.slice(0, 4);
  const lockedQuestions = questions.slice(4);

  const desc = `Practice ${escapeHtml(roleName)} interview questions with expert tips. ${questions.length} questions covering key topics for ${difficulty.toLowerCase()}-level ${escapeHtml(category.toLowerCase())} roles.`;

  // Build FAQ JSON-LD from free questions
  const faqItems = freeQuestions.map(q => ({
    '@type': 'Question',
    name: q.q,
    acceptedAnswer: {
      '@type': 'Answer',
      text: q.tip
    }
  }));

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems
  });

  // Related roles from same category (up to 6)
  const relatedRoles = Object.keys(DATA[category].roles)
    .filter(r => r !== roleName)
    .slice(0, 6);

  const relatedHtml = relatedRoles.map(r =>
    `<a href="/interview/${slugify(r)}.html" class="related-role">${escapeHtml(r)}</a>`
  ).join('\n          ');

  const freeQuestionsHtml = freeQuestions.map((q, i) => `
      <div class="question-card">
        <div class="q-number">Q${i + 1}</div>
        <div class="q-text">${escapeHtml(q.q)}</div>
        <div class="q-tip">
          <strong>Tip:</strong> ${escapeHtml(q.tip)}
        </div>
      </div>`).join('\n');

  const lockedQuestionsHtml = lockedQuestions.map((q, i) => `
      <div class="question-card locked">
        <div class="q-number">Q${i + 5}</div>
        <div class="q-text">${escapeHtml(q.q)}</div>
        <div class="q-lock">
          <span class="lock-icon">&#128274;</span>
          <a href="https://rollcallinterviewprep.com/" class="unlock-link">Sign up free to unlock</a>
        </div>
      </div>`).join('\n');

  let certsHtml = '';
  if (certs) {
    certsHtml = `
    <section class="certs-section">
      <h2>Education & Certifications</h2>
      <div class="certs-grid">
        <div class="cert-block">
          <h3>Degrees</h3>
          <ul>${certs.degrees.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
        </div>
        <div class="cert-block">
          <h3>Certifications</h3>
          <ul>${certs.certs.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>
        <div class="cert-block">
          <h3>Career Paths</h3>
          <ul>${certs.paths.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </div>
      </div>
    </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(roleName)} Interview Questions & Tips | RoleCall</title>
  <meta name="description" content="${desc}">
  <meta name="keywords" content="${escapeHtml(roleName)} interview questions, ${escapeHtml(roleName)} interview tips, ${escapeHtml(roleName)} interview prep, ${escapeHtml(category.toLowerCase())} jobs">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${escapeHtml(roleName)} Interview Questions | RoleCall">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${url}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(roleName)} Interview Questions | RoleCall">
  <meta name="twitter:description" content="${desc}">
  <script type="application/ld+json">${jsonLd}</script>
  <style>
    :root {
      --bg: #0f0f14; --card: #1a1a24; --accent: #6c5ce7; --accent-light: #a29bfe;
      --text: #f0f0f5; --text-secondary: #8e8ea0; --card-hover: #22222f;
      --radius: 12px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 20px 16px; }
    .nav { padding: 12px 0; margin-bottom: 8px; }
    .nav a { color: var(--accent); text-decoration: none; font-size: 14px; }
    .nav a:hover { text-decoration: underline; }
    .hero { text-align: center; padding: 32px 0 24px; }
    .hero .category-badge {
      display: inline-block; background: var(--card); color: var(--accent);
      padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
      margin-bottom: 12px;
    }
    .hero h1 {
      font-size: 32px; font-weight: 800; margin-bottom: 8px;
      background: linear-gradient(135deg, var(--accent), var(--accent-light));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero .meta {
      font-size: 14px; color: var(--text-secondary);
    }
    .hero .difficulty {
      display: inline-block; padding: 2px 10px; border-radius: 12px;
      font-size: 11px; font-weight: 700; margin-left: 8px;
    }
    .difficulty-entry { background: #2d6a4f33; color: #52b788; }
    .difficulty-mid { background: #f9ca2433; color: #f9ca24; }
    .difficulty-senior { background: #e74c3c33; color: #e74c3c; }
    .cta-top {
      text-align: center; margin: 20px 0 28px;
    }
    .btn {
      display: inline-block; padding: 14px 32px; border-radius: var(--radius);
      font-size: 16px; font-weight: 700; text-decoration: none; cursor: pointer;
      transition: transform 0.15s, opacity 0.15s; border: none;
    }
    .btn:active { transform: scale(0.97); }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-light));
      color: #fff;
    }
    .btn-outline {
      background: transparent; color: var(--accent);
      border: 2px solid var(--accent); margin-left: 12px;
    }
    h2 {
      font-size: 20px; font-weight: 700; margin: 32px 0 16px;
      padding-bottom: 8px; border-bottom: 1px solid var(--card-hover);
    }
    .question-card {
      background: var(--card); border-radius: var(--radius); padding: 20px;
      margin-bottom: 12px; border: 1px solid transparent;
      transition: border-color 0.2s;
    }
    .question-card:hover { border-color: var(--accent); }
    .question-card.locked { opacity: 0.55; }
    .question-card.locked:hover { border-color: transparent; }
    .q-number {
      font-size: 11px; font-weight: 700; color: var(--accent);
      text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;
    }
    .q-text { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
    .q-tip {
      font-size: 14px; color: var(--text-secondary); line-height: 1.5;
      padding: 12px; background: var(--card-hover); border-radius: 8px;
    }
    .q-tip strong { color: var(--accent-light); }
    .q-lock {
      text-align: center; padding: 12px;
    }
    .lock-icon { font-size: 20px; }
    .unlock-link {
      color: var(--accent); font-size: 13px; margin-left: 6px;
      text-decoration: none; font-weight: 600;
    }
    .unlock-link:hover { text-decoration: underline; }
    .certs-section { margin-top: 8px; }
    .certs-grid {
      display: grid; grid-template-columns: 1fr; gap: 16px;
    }
    @media (min-width: 600px) {
      .certs-grid { grid-template-columns: 1fr 1fr 1fr; }
    }
    .cert-block {
      background: var(--card); border-radius: var(--radius); padding: 16px;
    }
    .cert-block h3 {
      font-size: 13px; font-weight: 700; color: var(--accent);
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;
    }
    .cert-block ul {
      list-style: none; padding: 0;
    }
    .cert-block li {
      font-size: 13px; color: var(--text-secondary); padding: 4px 0;
      border-bottom: 1px solid var(--card-hover);
    }
    .cert-block li:last-child { border-bottom: none; }
    .cta-bottom {
      text-align: center; padding: 40px 0 32px;
    }
    .related-section { margin-top: 8px; }
    .related-grid {
      display: flex; flex-wrap: wrap; gap: 8px;
    }
    .related-role {
      display: inline-block; background: var(--card); color: var(--text);
      padding: 8px 16px; border-radius: 20px; font-size: 13px;
      text-decoration: none; transition: background 0.2s;
    }
    .related-role:hover { background: var(--card-hover); color: var(--accent); }
    footer {
      text-align: center; padding: 32px 0; border-top: 1px solid var(--card-hover);
      margin-top: 40px;
    }
    footer a { color: var(--text-secondary); text-decoration: none; font-size: 13px; margin: 0 12px; }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <nav class="nav">
      <a href="https://rollcallinterviewprep.com/">&#8592; Back to RoleCall</a>
    </nav>

    <div class="hero">
      <span class="category-badge">${icon} ${escapeHtml(category)}</span>
      <h1>${escapeHtml(roleName)} Interview Questions</h1>
      <div class="meta">
        ${questions.length} expert-crafted questions
        <span class="difficulty difficulty-${difficulty.toLowerCase()}">${difficulty}</span>
      </div>
    </div>

    <div class="cta-top">
      <a href="https://rollcallinterviewprep.com/" class="btn btn-primary">Practice Free</a>
      <a href="https://rollcallinterviewprep.com/" class="btn btn-outline">Unlock All ${questions.length} Questions</a>
    </div>

    <section>
      <h2>Sample Interview Questions</h2>
      ${freeQuestionsHtml}
    </section>

    <section>
      <h2>More Questions (${lockedQuestions.length} locked)</h2>
      ${lockedQuestionsHtml}
    </section>
    ${certsHtml}

    <div class="cta-bottom">
      <p style="color:var(--text-secondary);margin-bottom:16px;font-size:15px;">Get all ${questions.length} questions with expert tips on RoleCall</p>
      <a href="https://rollcallinterviewprep.com/" class="btn btn-primary">Start Practicing Free</a>
    </div>

    <section class="related-section">
      <h2>Related ${escapeHtml(category)} Roles</h2>
      <div class="related-grid">
          ${relatedHtml}
      </div>
    </section>

    <footer>
      <a href="https://rollcallinterviewprep.com/">Home</a>
      <a href="https://rollcallinterviewprep.com/interview/software-engineer.html">Popular: Software Engineer</a>
      <a href="https://rollcallinterviewprep.com/interview/registered-nurse.html">Popular: Nurse</a>
      <a href="https://rollcallinterviewprep.com/interview/accountant.html">Popular: Accountant</a>
    </footer>
  </div>
</body>
</html>`;
}

// Generate all pages
const interviewDir = path.join(__dirname, 'interview');
if (!fs.existsSync(interviewDir)) {
  fs.mkdirSync(interviewDir, { recursive: true });
}

const urls = [];
const usedSlugs = {};
let count = 0;

for (const [category, catData] of Object.entries(DATA)) {
  for (const roleName of Object.keys(catData.roles)) {
    let slug = slugify(roleName);
    if (usedSlugs[slug]) {
      slug = slug + '-' + slugify(category);
    }
    usedSlugs[slug] = true;
    const filename = slug + '.html';
    const filepath = path.join(interviewDir, filename);
    const pageHtml = generatePage(roleName, category);
    fs.writeFileSync(filepath, pageHtml, 'utf8');
    urls.push('https://rollcallinterviewprep.com/interview/' + filename);
    count++;
  }
}

console.log('Generated ' + count + ' landing pages in /interview/');

// Generate sitemap.xml
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://rollcallinterviewprep.com/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${urls.map(u => `  <url>
    <loc>${u}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join('\n')}
</urlset>`;

fs.writeFileSync(path.join(__dirname, 'sitemap.xml'), sitemap, 'utf8');
console.log('Generated sitemap.xml with ' + (urls.length + 1) + ' URLs');
