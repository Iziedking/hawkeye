// Find and run every *.smoke-test.ts under src/ via tsx, in series.
// Each smoke test owns its own assertions and exits non-zero on failure;
// this runner just aggregates results and surfaces an exit code to CI.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

function findSmokeTests(dir, results = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    let s;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (s.isDirectory()) findSmokeTests(path, results);
    else if (path.endsWith(".smoke-test.ts") || path.endsWith("/smoke-test.ts")) results.push(path);
  }
  return results;
}

const tests = findSmokeTests(join(ROOT, "src")).sort();

if (tests.length === 0) {
  console.log("No smoke tests found.");
  process.exit(0);
}

console.log(`Running ${tests.length} smoke test(s)\n`);

const failed = [];
for (const test of tests) {
  const rel = relative(ROOT, test);
  console.log(`\n━━━ ${rel} ━━━`);
  const r = spawnSync("npx", ["tsx", test], { stdio: "inherit" });
  if (r.status !== 0) failed.push(rel);
}

console.log("\n────────────────────────────");
if (failed.length === 0) {
  console.log(`✓ All ${tests.length} smoke test(s) passed`);
  process.exit(0);
}
console.error(`✗ ${failed.length}/${tests.length} smoke test(s) failed:`);
for (const f of failed) console.error(`  - ${f}`);
process.exit(1);
