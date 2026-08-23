#!/usr/bin/env node
// Coverage ratchet (audit round3 T20 / spec §4-M7).
//
// Usage:
//   npx vitest run --coverage --coverage.reporter=json-summary   (or npm run test:coverage)
//   node scripts/coverage-ratchet.mjs [summaryPath] [baselinePath]
//
// Defaults: summary = coverage/coverage-summary.json, baseline = scripts/coverage-baseline.json
//
// Semantics:
//   - Any tracked module whose line coverage drops BELOW its baseline → exit 1 (regression).
//   - A module exceeding its baseline by >= 1.0pp gets its baseline RAISED automatically
//     (ratchet-up); the updated baseline JSON must be committed with the change.
//   - Modules present in coverage but missing from the baseline are initialized at their
//     current value on first sight (recorded as "initialized").

import fs from 'node:fs';
import path from 'node:path';

const RATCHET_STEP_PCT = 1.0;
const EPSILON = 0.001;

const summaryPath = process.argv[2] ?? 'coverage/coverage-summary.json';
const baselinePath = process.argv[3] ?? path.join(import.meta.dirname, 'coverage-baseline.json');

function fail(msg) {
  console.error(`[coverage-ratchet] FAIL: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(summaryPath)) {
  fail(`coverage summary not found at ${summaryPath}. Run: npx vitest run --coverage.coverage.reporter=json-summary`);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

/** Map every covered src file to its top-level tracked module (src/<module>/...). */
function moduleOf(file) {
  // Summary keys may be absolute (<cwd>/src/...) or repo-relative (src/...).
  const rel = file.startsWith(process.cwd() + '/') ? file.slice(process.cwd().length + 1) : file;
  const m = rel.match(/^src\/([^/]+)\//);
  return m ? m[1] : null;
}

/** Aggregate line coverage across files per module (line-weighted). */
const perModule = new Map(); // module -> { covered, total }
for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const relFile = file.startsWith(process.cwd() + '/') ? file.slice(process.cwd().length + 1) : file;
  if (!relFile.startsWith('src/') || (!relFile.endsWith('.ts') && !relFile.endsWith('.tsx'))) continue;
  void file;
  const mod = moduleOf(file);
  if (!mod) continue;
  const t = data.lines?.total ?? 0;
  const c = data.lines?.covered ?? 0;
  if (t === 0 && c === 0) continue;
  const agg = perModule.get(mod) ?? { covered: 0, total: 0 };
  agg.covered += c;
  agg.total += t;
  perModule.set(mod, agg);
}

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
} catch {
  baseline = { modules: {}, note: '' };
}
baseline.modules ??= {};

const regressions = [];
const ratchets = [];
const initializations = [];

for (const [mod, agg] of [...perModule.entries()].sort()) {
  if (agg.total === 0) continue;
  const pct = (agg.covered / agg.total) * 100;
  const base = baseline.modules[mod];
  if (base === undefined) {
    initializations.push(`${mod}: ${pct.toFixed(2)}%`);
    baseline.modules[mod] = Number(pct.toFixed(2));
  } else if (pct < base - EPSILON) {
    regressions.push(`${mod}: ${pct.toFixed(2)}% < baseline ${base.toFixed(2)}%`);
  } else if (pct - base >= RATCHET_STEP_PCT) {
    ratchets.push(`${mod}: ${base.toFixed(2)}% -> ${pct.toFixed(2)}%`);
    baseline.modules[mod] = Number(pct.toFixed(2));
  }
}

console.log('[coverage-ratchet] module lines coverage:');
for (const [mod, agg] of [...perModule.entries()].sort()) {
  const pct = agg.total ? ((agg.covered / agg.total) * 100).toFixed(2) : 'n/a';
  const base = baseline.modules[mod];
  console.log(`  ${mod.padEnd(14)} ${String(pct).padStart(6)}%  (baseline ${base !== undefined ? Number(base).toFixed(2) : '-'})`);
}

if (initializations.length) {
  console.log(`[coverage-ratchet] initialized baselines:\n  ${initializations.join('\n  ')}`);
}
if (ratchets.length) {
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`[coverage-ratchet] RATCHETED UP (commit ${path.relative(process.cwd(), baselinePath)}):\n  ${ratchets.join('\n  ')}`);
} else if (initializations.length) {
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
}

if (regressions.length) {
  fail(`coverage regressed below ratchet baseline:\n  ${regressions.join('\n  ')}`);
}
console.log('[coverage-ratchet] OK');
