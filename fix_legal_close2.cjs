const fs = require('fs');
let html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');

const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);

// Find DATA section boundaries
const dataStart = js.indexOf('const DATA = {');
const dataEnd = js.indexOf('};', dataStart) + 2;
const dataSection = js.substring(dataStart, dataEnd);

console.log('DATA start offset:', dataStart);
console.log('DATA end offset:', dataEnd);
console.log('Last 100 chars of DATA:', JSON.stringify(dataSection.slice(-100)));

// The DATA ending is: ]\n}\n\t};
// Need:                ]\n}\n}\n};

// Find the pattern within DATA
const lastBracketInData = dataSection.lastIndexOf(']');
console.log('Last ] in DATA at offset:', lastBracketInData);
console.log('After last ]:', JSON.stringify(dataSection.substring(lastBracketInData, lastBracketInData + 30)));

// Replace in the full JS
const globalLastBracket = dataStart + lastBracketInData;
const afterGlobal = js.substring(globalLastBracket, globalLastBracket + 30);
console.log('Global after ]:', JSON.stringify(afterGlobal));

// Fix: replace ']\n}\n\t};' with ']\n}\n}\n};' at the end of DATA
const fixed = js.substring(0, globalLastBracket) + ']\n}\n}\n};' + js.substring(dataEnd);

// Verify
try {
  new Function(fixed);
  console.log('Full JS: VALID');
} catch(e) {
  console.log('Full JS: INVALID -', e.message);
}

// Write back
html = html.substring(0, scriptStart) + fixed + html.substring(scriptEnd);
fs.writeFileSync('C:/interview_prep/www/index.html', html);
console.log('File written');
