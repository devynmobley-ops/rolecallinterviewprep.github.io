const fs = require('fs');
let html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');
const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);

// Find the broken line
const broken = "const suggestions = JSON.parse(localStorage.getItem('preppro-suggestions') || '[]";
const brokenIdx = js.indexOf(broken);

// What should this function be? Let me find the function start
const funcStart = js.lastIndexOf('\nfunction ', brokenIdx);
console.log('Function starts at offset:', funcStart);
console.log('Function:', js.substring(funcStart, funcStart + 80));

// Find the function name
const funcNameMatch = js.substring(funcStart).match(/function\s+(\w+)/);
console.log('Function name:', funcNameMatch ? funcNameMatch[1] : 'unknown');

// The function likely saves a suggestion. Let me reconstruct it.
// Pattern: it has entry with { role, why, date }, then parses existing suggestions, pushes, saves.
const fix = `    const suggestions = JSON.parse(localStorage.getItem('preppro-suggestions') || '[]');
    suggestions.push(entry);
    localStorage.setItem('preppro-suggestions', JSON.stringify(suggestions));
  } catch(e) {}
}`;

js = js.substring(0, brokenIdx) + fix + js.substring(brokenIdx + broken.length);

// Verify
try {
  new Function(js);
  console.log('Fixed JS: VALID');
} catch(e) {
  console.log('Fixed JS: INVALID -', e.message);
}

// Write back
html = html.substring(0, scriptStart) + js + html.substring(scriptEnd);
fs.writeFileSync('C:/interview_prep/www/index.html', html);
console.log('File written');
