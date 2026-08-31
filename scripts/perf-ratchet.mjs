#!/usr/bin/env node
// Performance ratchet: compares scripts/perf-current.json against the
// committed scripts/perf-baseline.json.
//   - startup p50 regresses more than REGRESSION_PCT above baseline -> exit 1
//   - startup p50 improves by >= RATCHET_PCT -> baseline lowered (commit it)
// Usage: npm run bench:startup && node scripts/perf-ratchet.mjs

import fs from 'node:fs';
import path from 'node:path';

const REGRESSION_PCT = 20; // CI machine noise margin
const RATCHET_PCT = 10;

const repoRoot = path.resolve(import.meta.dirname, '..');
const currentPath = process.argv[2] ?? path.join(repoRoot, 'scripts', 'perf-current.json');
const baselinePath = process.argv[3] ?? path.join(repoRoot, 'scripts', 'perf-baseline.json');

function fail(msg) {
  console.error(`[perf-ratchet] FAIL: ${msg}`);
  process.exit(1);
}

let current, baseline;
try { current = JSON.parse(fs.readFileSync(currentPath, 'utf8')); }
catch { fail(`current measurement not found at ${currentPath}. Run \`npm run bench:startup\` first.`); }
try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); }
catch { fail(`baseline not found at ${baselinePath}. Run \`npm run bench:startup -- --update\` first.`); }

if (!current.startup || !baseline.startup) {
  fail('both current and baseline must contain a `startup` section');
}

const cur = current.startup.p50;
const base = baseline.startup.p50;
const deltaPct = ((cur - base) / base) * 100;

console.log(`[perf-ratchet] startup p50: current=${cur}ms baseline=${base}ms delta=${deltaPct.toFixed(1)}%`);

if (deltaPct > REGRESSION_PCT) {
  fail(`startup p50 regressed ${deltaPct.toFixed(1)}% (> ${REGRESSION_PCT}% allowed)`);
}

if (deltaPct <= -RATCHET_PCT) {
  baseline.startup = current.startup;
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`[perf-ratchet] RATCHETED DOWN (faster): baseline p50 ${base}ms -> ${cur}ms. Commit scripts/perf-baseline.json.`);
} else {
  console.log('[perf-ratchet] OK');
}
