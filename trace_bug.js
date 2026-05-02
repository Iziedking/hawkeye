// Simulating the bug flow:
// User says: "buy 2$ worth of 0xCA..."

// Step 1: Check tryDegenShortcut in llm-router.ts (line 78-113)
const EVM_ADDR = /0x[a-fA-F0-9]{40}/;
const text = "buy 2$ worth of 0xCAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE";

// extractAmount function from llm-router.ts (line 115-132)
const USD_DOLLAR = /\$(\d+(?:,\d{3})*(?:\.\d+)?)\b/;
const USD_TOKEN_AMOUNT = /\b(\d+(?:\.\d+)?)\s*(usdc|usdt|dai|busd)\b/i;
const NATIVE_AMOUNT = /\b(\d+(?:\.\d+)?)\s*(eth|sol|bnb|matic|avax|native)\b/i;

function extractAmount(text) {
  const dollar = text.match(USD_DOLLAR);
  console.log('  USD_DOLLAR match:', dollar);
  if (dollar && dollar[1]) {
    const v = Number(dollar[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v > 0) return { value: v, unit: "USD" };
  }
  const usd = text.match(USD_TOKEN_AMOUNT);
  if (usd && usd[1]) {
    const v = Number(usd[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, unit: "USD" };
  }
  const native = text.match(NATIVE_AMOUNT);
  console.log('  NATIVE_AMOUNT match:', native);
  if (native && native[1]) {
    const v = Number(native[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, unit: "NATIVE" };
  }
  return { value: 0, unit: "NATIVE" };
}

console.log('Input: "' + text + '"');
console.log('\nExtractAmount in tryDegenShortcut:');
const amount = extractAmount(text);
console.log('Result:', amount);
console.log('\nProblem: "2$" format is NOT matched by USD_DOLLAR regex!');
console.log('  USD_DOLLAR expects: $ THEN digits');
console.log('  But we have: digits THEN $');
console.log('\nSince no USD match, extractAmount returns { value: 0, unit: "NATIVE" }');

// Step 2: Fallback in telegram-gateway.ts (line 1421-1439)
const telegram_usd = /\$\s*([\d.]+)|(\d+(?:\.\d+)?)\s*\$/;
console.log('\n\nTelegram Gateway Fallback:');
const fallbackAmount = text.match(telegram_usd);
console.log('  telegram_usd match:', fallbackAmount);
console.log('  This WOULD catch "2$" with group 2');

const numMatch = text.match(/([\d.]+)\s*(?:of|worth)/i);
console.log('  numMatch (for "of|worth"):', numMatch);
console.log('\n  If LLM extracted amount.value=0, fallback would try:');
console.log('    1. USD regex: NO MATCH (because 2$ not $2)');
console.log('    2. ETH regex: NO MATCH (no ETH keyword)');
console.log('    3. "of|worth" regex: YES MATCH - captures "2" as NATIVE');
console.log('\n  Result: { value: 2, unit: "NATIVE" } (WRONG - should be USD)');
