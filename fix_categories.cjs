const fs = require('fs');
let html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');

const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);
const lines = js.split('\n');

// Find all orphaned icon: lines (where previous line is '}' without ',')
let fixCount = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith('icon:')) {
    const prev = lines[i-1] ? lines[i-1].trim() : '';
    // prev should be '}' (closing the previous roles section)
    if (prev === '}') {
      // The line before '}' should be ']' (closing the last role's array)
      // We need to change:
      // '}' -> '},'  (close roles, comma)
      // Add '"CategoryName": {' before icon:
      // Category name can be determined from the icon
      const icon = lines[i].trim();
      let catName = '';
      if (icon.includes('🏥')) catName = 'Healthcare';
      else if (icon.includes('💼')) catName = 'Business';
      else if (icon.includes('💰')) catName = 'Sales';
      else if (icon.includes('🎓')) catName = 'Education';
      else if (icon.includes('🔧')) catName = 'Trades';
      else if (icon.includes('🎨')) catName = 'Creative';
      else if (icon.includes('🛒')) catName = 'Service';
      else if (icon.includes('⚖️')) catName = 'Legal';
      else catName = 'Unknown';

      // Check if this icon already has a category wrapper
      // The previous line should be '},' not just '}'
      lines[i-1] = '},';
      // Insert category header
      lines.splice(i, 0, '  "' + catName + ': {');
      // Wait, we need the format: "CategoryName": {
      // The indentation should match
      lines[i] = '  "' + catName + '": {';
      fixCount++;
      i++; // skip the inserted line
    }
  }
}

console.log('Fixed', fixCount, 'category transitions');

js = lines.join('\n');

// Fix the Legal closing at the end - find the last '];' in DATA
// After Notary Public's ']', the Legal category needs to close with '}', then DATA closes with '};'
const lastBracket = js.lastIndexOf(']');
if (lastBracket > 0) {
  const afterBracket = js.substring(lastBracket, lastBracket + 10);
  if (afterBracket.startsWith(']\n};')) {
    js = js.substring(0, lastBracket) + ']\n  }\n};' + js.substring(lastBracket + 4);
    console.log('Fixed Legal closing');
  } else {
    console.log('After last ]:', JSON.stringify(afterBracket));
  }
}

// Write back
html = html.substring(0, scriptStart) + js + html.substring(scriptEnd);
fs.writeFileSync('C:/interview_prep/www/index.html', html);

// Verify
try {
  new Function(js);
  console.log('JS syntax: VALID');
} catch(e) {
  console.log('JS syntax error:', e.message);
  try {
    require('acorn').parse(js, { ecmaVersion: 2020 });
  } catch(e2) {
    const line = e2.loc.line;
    console.log('Error at line', line);
    const jsLines = js.split('\n');
    for (let j = Math.max(1, line - 3); j <= Math.min(jsLines.length, line + 3); j++) {
      console.log('  ' + j + ': ' + jsLines[j-1].substring(0, 150));
    }
  }
}
