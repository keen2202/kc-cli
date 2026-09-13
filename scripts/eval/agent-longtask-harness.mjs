#!/usr/bin/env node
/**
 * Agent long-task eval harness helpers (RI-SPEC §3.4 / RI-T10 + AGP T1).
 *
 * Commands:
 *   baseline       persist git status + typecheck under .workbuddy/eval/<run>/baseline/
 *   validate-probe validate probe answer keywords
 *   record-count   rerun controller command, extract authoritative number
 *   run-task       run ONE eval task (mock backend) and persist per-task record
 *   run-baseline   run held-in + held-out splits with mock backend → eval-runs/<runId>/
 *
 * Usage:
 *   node scripts/eval/agent-longtask-harness.mjs run-baseline --backend mock
 *   node scripts/eval/agent-longtask-harness.mjs run-baseline --backend mock --run r1 \
 *     --runs-root /tmp/eval-runs
 *   node scripts/eval/agent-longtask-harness.mjs run-task \
 *     --set scripts/eval/sets/longtask-held-in.json --task hi-write-greeting --run r1
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const WORKBUDDY_ROOT = path.join(ROOT, '.workbuddy', 'eval');
const EVAL_ROOT = path.join(ROOT, '.kc-cli', 'experiments', 'eval-runs');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SETS_DIR = path.join(SCRIPT_DIR, 'sets');
const STDOUT_MAX = 4096;
const TASK_RESULT_FORMAT = 'kc.eval_task_result.v1';

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

function truncateStdout(text) {
  return text.length <= STDOUT_MAX ? text : text.slice(0, STDOUT_MAX);
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
    stdoutExcerpt: rerun ? truncateStdout(rerun.stdout) : undefined,
  };
  const target = path.join(controlDir, `${args.name}.json`);
  fs.writeFileSync(target, JSON.stringify(record, null, 2), 'utf8');
  console.log(`[count] ${args.name}=${value} -> ${target}`);
}

// ── AGP T1: mock long-task eval ──────────────────────────────────────────

function loadEvalSet(setPath) {
  const raw = JSON.parse(fs.readFileSync(setPath, 'utf8'));
  if (raw.format !== 'kc.experiment_eval.v1') {
    throw new Error(`unknown eval set format: ${raw.format}`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error('eval set has no tasks');
  }
  for (const t of raw.tasks) {
    for (const field of ['taskId', 'repo', 'commit', 'prompt', 'testCommand', 'verificationCommand']) {
      if (typeof t[field] !== 'string' || !t[field]) throw new Error(`task missing ${field}`);
    }
    if (typeof t.maxTurns !== 'number' || typeof t.maxBudgetUsd !== 'number' || typeof t.timeoutSec !== 'number') {
      throw new Error(`task ${t.taskId} missing numeric limits`);
    }
  }
  return raw;
}

function resolveRunsRoot(args) {
  if (typeof args['runs-root'] === 'string') {
    return path.resolve(args['runs-root']);
  }
  return EVAL_ROOT;
}

function fixtureDirFor(repo) {
  const rel = repo.startsWith('local:') ? repo.slice('local:'.length) : repo;
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

/**
 * 确定性 mock 评估：按任务声明的 patch 应用到 fixture 副本，再真实跑 verificationCommand。
 * 同输入必得同输出（无随机、无网络、无时钟依赖于指标字段）。
 */
function evaluateTaskMock(task, { runId, split, backend }) {
  const mock = task.mock ?? { mode: 'no-patch', turns: 1, costUsd: 0 };
  const fixtureDir = fixtureDirFor(task.repo);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`fixture not found: ${fixtureDir}`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-eval-task-'));
  let verificationExitCode = null;
  let stdout = '';
  let stderr = '';
  let patchBody = '';
  const patchFiles = [];
  let errorCode = null;

  try {
    fs.cpSync(fixtureDir, workDir, { recursive: true });

    if (mock.mode === 'apply-patch' && Array.isArray(mock.patchFiles)) {
      for (const file of mock.patchFiles) {
        const target = path.join(workDir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        fs.writeFileSync(target, file.content, 'utf8');
        patchFiles.push(file.path);
        patchBody += `--- a/${file.path}\n+++ b/${file.path}\n`;
        if (prev !== null) patchBody += `-${prev.split('\n').join('\n-')}\n`;
        patchBody += `+${file.content.split('\n').join('\n+')}\n`;
      }
    }

    const noPatch = patchFiles.length === 0;
    let verified = false;

    if (!noPatch && task.verificationCommand) {
      const result = spawnSync(task.verificationCommand, {
        cwd: workDir,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      verificationExitCode = typeof result.status === 'number' ? result.status : 1;
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
      verified = verificationExitCode === 0;
    }

    let turns = Math.min(mock.turns, task.maxTurns);
    let costUsd = mock.costUsd;
    if (mock.turns > task.maxTurns) errorCode = 'max_turns';
    if (mock.costUsd > task.maxBudgetUsd) errorCode = 'budget_exceeded';

    const excerpt = truncateStdout([stdout, stderr ? `# stderr\n${stderr}` : ''].filter(Boolean).join('\n'));

    return {
      result: {
        format: TASK_RESULT_FORMAT,
        taskId: task.taskId,
        split,
        backend,
        runId,
        repo: task.repo,
        commit: task.commit,
        success: errorCode === null,
        verified,
        noPatch,
        turns,
        costUsd,
        patchFiles,
        verificationCommand: task.verificationCommand,
        verificationExitCode,
        safetyViolations: 0,
        errorCode,
        stdoutExcerpt: excerpt,
        timestamp: 0, // 确定性：mock 结果不含墙钟
      },
      patchBody,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function writeTaskArtifacts(evalRunDir, result, patchBody) {
  const taskDir = path.join(evalRunDir, 'tasks', result.taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'record.json'), JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(path.join(taskDir, 'patch.diff'), patchBody, 'utf8');
  fs.writeFileSync(path.join(taskDir, 'stdout.txt'), result.stdoutExcerpt ?? '', 'utf8');
  return taskDir;
}

function runOneTask(task, { runId, split, backend, evalRunDir }) {
  if (backend !== 'mock') {
    throw new Error(`backend not available in T1: ${backend} (real provider needs explicit enable + API key)`);
  }
  const { result, patchBody } = evaluateTaskMock(task, { runId, split, backend });
  const taskDir = writeTaskArtifacts(evalRunDir, result, patchBody);
  return { result, taskDir };
}

function ensureEvalRunDir(args, backend) {
  const runsRoot = resolveRunsRoot(args);
  const runId =
    typeof args.run === 'string' && args.run
      ? args.run
      : `${backend}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const evalRunDir = path.join(runsRoot, runId);
  fs.mkdirSync(evalRunDir, { recursive: true });
  return { runId, evalRunDir, runsRoot };
}

function cmdRunTask(args) {
  if (typeof args.set !== 'string') throw new Error('missing --set <eval-set.json>');
  if (typeof args.task !== 'string') throw new Error('missing --task <taskId>');
  const backend = typeof args.backend === 'string' ? args.backend : 'mock';
  const set = loadEvalSet(path.resolve(args.set));
  const task = set.tasks.find((t) => t.taskId === args.task);
  if (!task) throw new Error(`task not found in set: ${args.task}`);

  const { runId, evalRunDir } = ensureEvalRunDir(args, backend);
  const { result, taskDir } = runOneTask(task, {
    runId,
    split: set.split,
    backend,
    evalRunDir,
  });
  console.log(
    `[run-task] ${result.taskId} verified=${result.verified} noPatch=${result.noPatch} ` +
      `turns=${result.turns} cost=${result.costUsd} exit=${result.verificationExitCode} -> ${taskDir}`,
  );
}

function cmdRunBaseline(args) {
  const backend = typeof args.backend === 'string' ? args.backend : 'mock';
  const setsDir = typeof args['sets-dir'] === 'string' ? path.resolve(args['sets-dir']) : DEFAULT_SETS_DIR;
  const { runId, evalRunDir } = ensureEvalRunDir(args, backend);

  const heldInPath = path.join(setsDir, 'longtask-held-in.json');
  const heldOutPath = path.join(setsDir, 'longtask-held-out.json');
  const heldIn = loadEvalSet(heldInPath);
  const heldOut = loadEvalSet(heldOutPath);

  const inIds = new Set(heldIn.tasks.map((t) => t.taskId));
  for (const t of heldOut.tasks) {
    if (inIds.has(t.taskId)) throw new Error(`taskId overlaps splits: ${t.taskId}`);
  }

  const meta = {
    runId,
    backend,
    createdAt: new Date().toISOString(),
    sets: { 'held-in': heldInPath, 'held-out': heldOutPath },
    note: 'mock backend is deterministic; createdAt is metadata only',
  };
  fs.writeFileSync(path.join(evalRunDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const allResults = [];
  for (const set of [heldIn, heldOut]) {
    for (const task of set.tasks) {
      const { result, taskDir } = runOneTask(task, {
        runId,
        split: set.split,
        backend,
        evalRunDir,
      });
      allResults.push(result);
      console.log(
        `[run-baseline] ${set.split}/${result.taskId} verified=${result.verified} noPatch=${result.noPatch} -> ${taskDir}`,
      );
    }
  }

  // 内联聚合（与 metrics.ts 规则一致，避免 mjs→ts 依赖）
  const splits = {};
  for (const set of [heldIn, heldOut]) {
    const records = allResults.filter((r) => r.split === set.split);
    const n = records.length || 1;
    const verified = records.filter((r) => r.verified).length;
    const noPatch = records.filter((r) => r.noPatch).length;
    const turns = records.reduce((s, r) => s + r.turns, 0);
    const cost = records.reduce((s, r) => s + r.costUsd, 0);
    const safety = records.reduce((s, r) => s + r.safetyViolations, 0);
    const round4 = (x) => Math.round(x * 10000) / 10000;
    splits[set.split] = {
      tasks: records.length,
      verifiedTaskRate: round4(verified / n),
      noPatchRate: round4(noPatch / n),
      avgTurns: round4(turns / n),
      avgCostUsd: round4(cost / n),
      safetyViolations: safety,
    };
    fs.writeFileSync(
      path.join(evalRunDir, `split-${set.split}.json`),
      JSON.stringify(splits[set.split], null, 2),
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(evalRunDir, 'summary.json'),
    JSON.stringify({ runId, backend, createdAt: meta.createdAt, splits }, null, 2),
    'utf8',
  );
  console.log(`[run-baseline] runId=${runId} -> ${evalRunDir}`);
  console.log(JSON.stringify(splits, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'baseline') cmdBaseline(args);
    else if (command === 'validate-probe') cmdValidateProbe(args);
    else if (command === 'record-count') cmdRecordCount(args);
    else if (command === 'run-task') cmdRunTask(args);
    else if (command === 'run-baseline') cmdRunBaseline(args);
    else {
      console.error(
        'Usage: node scripts/eval/agent-longtask-harness.mjs <baseline|validate-probe|record-count|run-task|run-baseline> [...]',
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`[agent-longtask-harness] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
