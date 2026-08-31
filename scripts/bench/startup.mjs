#!/usr/bin/env node
// Startup benchmark: cold-starts the CLI from source (via tsx, matching the
// npm run kc path) with KC_BENCH_STARTUP=1, records wall-clock p50/p95,
// writes scripts/perf-current.json. Wall time includes tsx transform
// overhead; every run pays it equally, so relative comparisons stay valid.
// Pass --update to (re)write the committed scripts/perf-baseline.json.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RUNS = 10;
const repoRoot = path.resolve(import.meta.dirname, '../..');
const entry = path.join(repoRoot, 'src', 'main.ts');

const samples = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      KC_BENCH_STARTUP: '1',
      LOG_LEVEL: 'error',
      // Windows has no sandbox backend; without this flag compose() aborts
      // before the bench exit point. No-op where a backend exists (CI linux).
      KC_SANDBOX_FAIL_IF_NO_SANDBOX: 'false',
    },
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 60_000,
  });
  const elapsed = performance.now() - t0;
  if (res.status !== 0) {
    console.error(`[bench:startup] run ${i} exited ${res.status}:`, String(res.stderr).slice(0, 500));
    process.exit(1);
  }
  samples.push(elapsed);
}

const round1 = (n) => Math.round(n * 10) / 10;
const sorted = [...samples].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
const result = {
  metric: 'startup_ms',
  runs: RUNS,
  p50: round1(p50),
  p95: round1(p95),
  samples: samples.map(round1),
  timestamp: new Date().toISOString(),
};

const currentPath = path.join(repoRoot, 'scripts', 'perf-current.json');
let current = {};
try { current = JSON.parse(fs.readFileSync(currentPath, 'utf8')); } catch { /* first run */ }
current.startup = result;
fs.writeFileSync(currentPath, JSON.stringify(current, null, 2) + '\n');

if (process.argv.includes('--update')) {
  const baselinePath = path.join(repoRoot, 'scripts', 'perf-baseline.json');
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch { /* first run */ }
  baseline.startup = result;
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`[bench:startup] baseline updated: p50=${result.p50}ms p95=${result.p95}ms`);
} else {
  console.log(`[bench:startup] p50=${result.p50}ms p95=${result.p95}ms (samples: ${result.samples.join(', ')})`);
}
