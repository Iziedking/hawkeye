const text = "buy 2$ worth of 0xCA...";

const numMatch = text.match(/([\d.]+)\s*(?:of|worth)/i);
console.log('Regex: /([\d.]+)\s*(?:of|worth)/i');
console.log('Input:', text);
console.log('Match:', numMatch);
console.log('\nThis should match "2$" but:');
console.log('  The $ in "2$" is NOT captured by \d');
console.log('  So the match is actually capturing 0 with nothing before "of"');
console.log('\nLet me check what actually matches:');

const text2 = "buy 2 worth of 0xCA...";
const match2 = text2.match(/([\d.]+)\s*(?:of|worth)/i);
console.log('\nInput (without $):', text2);
console.log('Match:', match2);

// Ah! The issue is the $ is between the number and "worth"
const text3 = "buy 2$ worth of 0xCA...";
const match3 = text3.match(/([\d.]+)\s*(?:of|worth)/i);
console.log('\nInput (with $):', text3);
console.log('Match:', match3);
console.log('Why null? Because there is a $ between the digit and "worth"');
console.log('The regex expects optional whitespace \s* not a $ character');
