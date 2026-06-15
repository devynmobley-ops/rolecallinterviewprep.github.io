const fs = require('fs');
let html = fs.readFileSync('C:/interview_prep/www/index.html', 'utf8');

const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>');
let js = html.substring(scriptStart, scriptEnd);

// Fix Legal closing: replace ']\n}\n\t};' with ']\n}\n}\n};'
// The last role array closes with ']', then role closes with '}', then roles closes with '}', then category closes with '}', then DATA closes with '};'
// Currently: ] \n } \n \t};  (missing roles: {} closing and category closing)
// Need:     ] \n } (close last role) \n } (close roles) \n } (close Legal category) \n }; (close DATA)

// Actually, let me think about this more carefully.
// Structure is:
// "Legal": {
//   icon: "...",
//   roles: {
//     "Paralegal": [...],
//     ...
//     "Notary Public": [
//       {q:..., tip:...},
//       {q:..., tip:...}
//     ]
//   }
// }
// };

// Current ending:
// {q:"..."}
// ]
// }
// 	};

// Missing: close roles (}), close Legal category (})
// Current } closes the last role's array
// Wait - let me re-examine. The } after ] closes... let me trace it.

// "Notary Public": [   <- opens role (depth for roles)
//   {q:..., tip:...}   <- opens/closes question object
// ]
// }  <- closes "Notary Public" or closes roles?

// Actually looking at the other categories for comparison:
// In Service: ...]} <- close last question, close array
//   }  <- close last role
// }  <- close roles
// }, <- close category

// So the Legal ending should be:
// ] <- close Notary Public's array
// } <- close Notary Public role
// } <- close roles
// } <- close Legal category
// }; <- close DATA

// Currently we have:
// ]
// }
// \t};

// So we're missing } (close roles) and } (close Legal)
// The existing } must close the last role (Notary Public)
// We need to add: } (close roles) and } (close Legal)

// Let me find the exact pattern to replace
const lastBracketPos = js.lastIndexOf(']');
const afterBracket = js.substring(lastBracketPos, lastBracketPos + 30);
console.log('After last ]:', JSON.stringify(afterBracket));

// Replace ']\n}\n\t};' with ']\n}\n}\n};'
// But need to be careful about the tab
const oldEnding = js.substring(lastBracketPos);
console.log('Last bracket to end:', JSON.stringify(oldEnding.slice(0, 50)));

// The pattern is: ]\n}\n\t};
// Need:            ]\n}\n}\n};

// Replace the ending
const newData = js.substring(0, lastBracketPos) + ']\n}\n}\n};';

// Verify
try {
  new Function(newData);
  console.log('Fixed DATA: VALID');
} catch(e) {
  console.log('Fixed DATA: INVALID -', e.message);
}

// Write back
html = html.substring(0, scriptStart) + newData + html.substring(scriptEnd);
fs.writeFileSync('C:/interview_prep/www/index.html', html);
console.log('File written');
