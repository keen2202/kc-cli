#!/usr/bin/env node
/**
 * Agent long-task eval harness helpers (RI-SPEC §3.4 / RI-T10).
 *
 * The external `agent-longtask-eval-harness` skill is not shipped in this
 * repository. This tracked helper implements the deterministic pieces of that
 * harness so baseline/probe/number handling can be scripted and audited:
 *
 *   baseline       persist `git status` + typecheck output under
 *                  `.workbuddy/eval/<run>/baseline/*.log` (file-based across
 *                  turns; no volatile process handles).
 *   validate-probe validate that a probe answer contains required keywords;
 *                  exit 1 with a ready-to-send follow-up when it does not.
 *   record-count   rerun a controller command, extract the authoritative
 *                  numeric result and write it back to the run record.
 *
 * Usage:
 *   node scripts/eval/agent-longtask-harness.mjs baseline --run LT1-001
 *   node scripts/eval/agent-longtask-harness.mjs validate-probe \
 *     --run LT1-001 --probe checkout-1 --file answer.txt --keywords 关键词A,关键词B
 *   node scripts/eval/agent-longtask-harness.mjs record-count \
 *     --run LT1-001 --name tests --command "npx vitest run --reporter=json" \
 *     --pattern "numTotalTests[^0-9]*(\\d+)"
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WORKBUDDY_ROOT = path.join(ROOT, '.workbuddy', 'eval');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function requireRun(args) {
  if (!args.run || typeof args.run !== 'string') {
    throw new Error('missing --run <run-id>');
  }
  const runDir = path.join(WORKBUDDY_ROOT, args.run);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function runCapture(command, cwd = ROOT) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function cmdBaseline(args) {
  const runDir = requireRun(args);
  const baselineDir = path.join(runDir, 'baseline');
  fs.mkdirSync(baselineDir, { recursive: true });

  const jobs = [
    { name: 'git-status', command: 'git status --short' },
    { name: 'typecheck', command: 'npm run typecheck' },
  ];
  const manifest = [];

  for (const job of jobs) {
    const result = runCapture(job.command);
    const logName = `${job.name}.log`;
    const logPath = path.join(baselineDir, logName);
    const body = [
      `$ ${result.command}`,
      `# started: ${result.startedAt}`,
      `# finished: ${result.finishedAt}`,
      `# exitCode: ${result.exitCode}`,
      '',
      result.stdout,
      result.stderr ? '# stderr\n' + result.stderr : '',
    ].join('\n');
    fs.writeFileSync(logPath, body, 'utf8');
    manifest.push({ ...result, logName });
    console.log(`[baseline] ${job.name} exit=${result.exitCode} -> ${logPath}`);
  }

  fs.writeFileSync(
    path.join(baselineDir, 'manifest.json'),
    JSON.stringify({ run: args.run, capturedAt: new Date().toISOString(), commands: manifest }, null, 2),
    'utf8',
  );
}

function cmdValidateProbe(args) {
  const runDir = requireRun(args);
  if (!args.file || typeof args.file !== 'string') throw new Error('missing --file <answer-file>');
  const keywords = String(args.keywords ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keywords.length === 0) throw new Error('missing --keywords <k1,k2>');

  const answer = fs.readFileSync(args.file, 'utf8');
  const missing = keywords.filter((keyword) => !answer.toLowerCase().includes(keyword.toLowerCase()));
  const probeName = typeof args.probe === 'string' ? args.probe : 'probe';
  const probeDir = path.join(runDir, 'probes');
  fs.mkdirSync(probeDir, { recursive: true });
  const record = {
    probe: probeName,
    checkedAt: new Date().toISOString(),
    file: args.file,
    keywords,
    missing,
    passed: missing.length === 0,
  };
  fs.writeFileSync(path.join(probeDir, `${probeName}.json`), JSON.stringify(record, null, 2), 'utf8');

  if (missing.length === 0) {
    console.log(`[probe] ${probeName}: PASS`);
    return;
  }

  const followUp = [
    `Checkpoint ${probeName} answer is incomplete.`,
    `Missing required keyword(s): ${missing.join(', ')}`,
    'Please answer explicitly in your final report and do not deflect with "见消息开头".',
  ].join('\n');
  fs.writeFileSync(path.join(probeDir, `${probeName}.followup.txt`), followUp + '\n', 'utf8');
  console.error(`[probe] ${probeName}: FOLLOW-UP REQUIRED`);
  console.error(followUp);
  process.exitCode = 1;
}

function cmdRecordCount(args) {
  const runDir = requireRun(args);
  if (!args.name || typeof args.name !== 'string') throw new Error('missing --name <name>');

  let value;
  let rerun = null;
  if (typeof args.command === 'string') {
    rerun = runCapture(args.command);
    const pattern = new RegExp(typeof args.pattern === 'string' ? args.pattern : '(\\d+)');
    const match = rerun.stdout.match(pattern) ?? rerun.stderr.match(pattern);
    if (!match || !match[1]) {
      throw new Error(`controller rerun produced no parsable number: ${args.command}`);
    }
    value = Number(match[1].replace(/,/g, ''));
  } else if (args.value !== undefined) {
    value = Number(args.value);
  } else {
    throw new Error('missing --command <controller-rerun-command> (or --value for offline fixtures)');
  }
  if (!Number.isFinite(value)) throw new Error(`parsed value is not finite: ${value}`);

  const controlDir = path.join(runDir, 'control');
  fs.mkdirSync(controlDir, { recursive: true });
  const record = {
    name: args.name,
    value,
    authoritativeSource: rerun ? 'controller-rerun' : 'offline-fixture',
    recordedAt: new Date().toISOString(),
    command: rerun?.command,
    exitCode: rerun?.exitCode,
    stdoutExcerpt: rerun ? rerun.stdout.slice(0, 4096) : undefined,
  };
  const target = path.join(controlDir, `${args.name}.json`);
  fs.writeFileSync(target, JSON.stringify(record, null, 2), 'utf8');
  console.log(`[count] ${args.name}=${value} -> ${target}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'baseline') cmdBaseline(args);
    else if (command === 'validate-probe') cmdValidateProbe(args);
    else if (command === 'record-count') cmdRecordCount(args);
    else {
      console.error('Usage: node scripts/eval/agent-longtask-harness.mjs <baseline|validate-probe|record-count> [...]');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`[agent-longtask-harness] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
