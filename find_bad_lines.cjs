const fs = require('fs');
const html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
const js = html.substring(scriptStart, scriptEnd);
const lines = js.split('\n');

// Find lines containing 'undefined'
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'undefined') {
    console.log('Line', (i+1), ': undefined');
  }
}

// Also check for truncated string literals - lines containing '[ ] without closing
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Check for unterminated string: has '[ ] or '[ but line doesn't end with closing quote/bracket
  if (line.includes("JSON.parse(localStorage.getItem('preppro-suggestions') || '[]")) {
    console.log('Found truncated line at', (i+1), ':', JSON.stringify(line));
  }
}

// Find what's around line 3191
for (let i = 3188; i < 3210; i++) {
  console.log((i+1) + ': ' + JSON.stringify(lines[i]));
}
