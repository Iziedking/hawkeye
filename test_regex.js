const USD_DOLLAR = /\$(\d+(?:,\d{3})*(?:\.\d+)?)\b/;
const telegram_usd = /\$\s*([\d.]+)|(\d+(?:\.\d+)?)\s*\$/;

const test1 = 'buy 2$ worth of 0xCA...';
const test2 = 'buy $2 worth of 0xCA...';
const test3 = 'buy 2 $ worth of 0xCA...';

console.log('llm-router USD_DOLLAR:');
console.log('  "2$":', test1.match(USD_DOLLAR));
console.log('  "$2":', test2.match(USD_DOLLAR));
console.log('  "2 $":', test3.match(USD_DOLLAR));

console.log('\ntelegram-gateway fallback regex:');
console.log('  "2$":', test1.match(telegram_usd));
console.log('  "$2":', test2.match(telegram_usd));
console.log('  "2 $":', test3.match(telegram_usd));
