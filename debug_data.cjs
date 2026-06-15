const fs = require('fs');
const html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
const js = html.substring(scriptStart, scriptEnd);

const dataStart = js.indexOf('const DATA = {');
const dataEnd = js.indexOf('};', dataStart) + 2;
const dataSection = js.substring(dataStart, dataEnd);

// Track brace depth with string awareness
let depth = 0;
let inString = false;
let escape = false;
let found = false;
let depths = [];

for (let i = 0; i < dataSection.length; i++) {
  const ch = dataSection[i];
  if (escape) { escape = false; continue; }
  if (ch === '\\' && inString) { escape = true; continue; }
  if (ch === '"' && !inString) { inString = true; continue; }
  if (ch === '"' && inString) { inString = false; continue; }
  if (inString) continue;

  if (ch === '{' || ch === '[') depth++;
  if (ch === '}' || ch === ']') {
    depth--;
    if (depth < 0) {
      console.log('Depth went negative at offset', i, 'char:', ch);
      const ctx = dataSection.substring(Math.max(0, i - 80), i + 80);
      console.log('Context:', JSON.stringify(ctx));
      found = true;
      break;
    }
  }
}

if (!found) {
  console.log('No negative depth found. Final depth:', depth);
}

// Now let's also check: is there a depth=1 point near the end that should be depth=0?
// After the final role's ]}, the DATA should close with };
// Let's find the last 500 chars and check manually
console.log('\nLast 300 chars of dataSection:');
console.log(JSON.stringify(dataSection.slice(-300)));

// Check the closing structure more carefully
// Find all depth changes in the last 500 chars
const last500 = dataSection.slice(-500);
depth = 0;
inString = false;
escape = false;
for (let i = 0; i < last500.length; i++) {
  const ch = last500[i];
  if (escape) { escape = false; continue; }
  if (ch === '\\' && inString) { escape = true; continue; }
  if (ch === '"' && !inString) { inString = true; continue; }
  if (ch === '"' && inString) { inString = false; continue; }
  if (inString) continue;
  if (ch === '{' || ch === '[') { depth++; console.log('offset', i, '{  -> depth', depth, JSON.stringify(last500.substring(Math.max(0,i-20), i+1))); }
  if (ch === '}' || ch === ']') { depth--; console.log('offset', i, ch, ' -> depth', depth, JSON.stringify(last500.substring(Math.max(0,i-20), i+1))); }
}
