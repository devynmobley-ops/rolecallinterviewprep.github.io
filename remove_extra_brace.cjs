const fs = require('fs');
let html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);

// Remove one extra '}' at line 3196 (0-indexed line 3195)
const lines = js.split('\n');
// Line 3196 is index 3195
console.log('Line 3196:', JSON.stringify(lines[3195]));
console.log('Line 3197:', JSON.stringify(lines[3196]));
console.log('Line 3198:', JSON.stringify(lines[3197]));

// Remove line 3196 (the extra })
lines.splice(3195, 1);

js = lines.join('\n');

try {
  new Function(js);
  console.log('Fixed JS: VALID');
} catch(e) {
  console.log('Fixed JS: INVALID -', e.message);
}

html = html.substring(0, scriptStart) + js + html.substring(scriptEnd);
fs.writeFileSync('C:/interview_prep/www/index.html', html);
console.log('File written');
