const fs = require('fs');
let html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');

const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);

// Find DATA section
const dataStart = js.indexOf('const DATA = {');
const dataEnd = js.indexOf('};', dataStart) + 2;

const lastBracketInData = js.lastIndexOf(']', dataEnd - 1);
const between = js.substring(lastBracketInData, dataEnd);
console.log('Between ] and };:', JSON.stringify(between));

// Replace ending
const fixed = js.substring(0, lastBracketInData) + ']\n}\n}\n};' + js.substring(dataEnd);

// Verify
try {
  new Function(fixed);
  console.log('Full JS: VALID');
} catch(e) {
  console.log('Full JS: INVALID -', e.message);
  // Show context around error
  const m = e.message;
  console.log('Error:', m);
}

// Write back
html = html.substring(0, scriptStart) + fixed + html.substring(scriptEnd);
fs.writeFileSync('C:/interview_prep/www/index.html', html);
console.log('File written');
