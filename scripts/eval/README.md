# Agent Long-Task Eval Harness Helpers

This directory contains tracked helpers for the long-task evaluation harness
described in `docs/specs/agent-report-integrity-spec.md` §3.4 (RI-T10) and the
AGP experiment runtime eval baseline (`docs/specs/agp-experiment-runtime-spec.md` §3.6, Task T1).

The external `agent-longtask-eval-harness` skill is not shipped with this
repository. `agent-longtask-harness.mjs` provides the deterministic,
file-based pieces required by the spec so controllers can adopt them without
relying on volatile process handles.

## Layout

```
scripts/eval/
├── agent-longtask-harness.mjs   # baseline / probes / run-task / run-baseline
├── metrics.ts                   # kc.experiment_eval.v1 + SplitResult aggregator (tsx)
├── sets/
│   ├── longtask-held-in.json    # fixed held-in split (frozen)
│   └── longtask-held-out.json   # fixed held-out split (frozen, disjoint)
└── fixtures/                    # local fixture workspaces for mock tasks
```

### `kc.experiment_eval.v1` task fields

`taskId`, `repo`, `commit`, `prompt`, `testCommand`, `verificationCommand`,
`maxTurns`, `maxBudgetUsd`, `timeoutSec` (+ optional `mock` config for the
deterministic mock backend).

### Run artifacts

Baseline products are written under:

```
.kc-cli/experiments/eval-runs/<runId>/
├── meta.json
├── tasks/<taskId>/record.json   # patchFiles, verificationCommand, exit code, turns, cost, noPatch
├── tasks/<taskId>/patch.diff
├── tasks/<taskId>/stdout.txt    # truncated ≤4KB
├── split-held-in.json
├── split-held-out.json
└── summary.json
```

`SplitResult` (spec §3.6): `{ tasks, verifiedTaskRate, noPatchRate, avgTurns, avgCostUsd, safetyViolations }`.

## Commands

```bash
# Persist git status + typecheck output under .workbuddy/eval/<run>/baseline/
node scripts/eval/agent-longtask-harness.mjs baseline --run LT1-001

# Validate a probe answer against controller-required keywords; exit 1 and
# write .workbuddy/eval/<run>/probes/<probe>.followup.txt when keywords are missing.
node scripts/eval/agent-longtask-harness.mjs validate-probe \
  --run LT1-001 --probe checkout-1 --file answer.txt --keywords 关键词A,关键词B

# Rerun the controller command and persist its authoritative numeric output.
node scripts/eval/agent-longtask-harness.mjs record-count \
  --run LT1-001 --name tests --command "npx vitest run --reporter=json" \
  --pattern "numTotalTests[^0-9]*(\\d+)"

# Run a single eval task (mock backend) into eval-runs/<run>/tasks/<taskId>/
node scripts/eval/agent-longtask-harness.mjs run-task \
  --set scripts/eval/sets/longtask-held-in.json --task hi-write-greeting --run demo-1

# Run the frozen held-in + held-out baseline (mock backend, CI-safe)
npm run eval:baseline
# equivalent:
node scripts/eval/agent-longtask-harness.mjs run-baseline --backend mock

# Aggregate SplitResult from an existing run directory
npm run eval:metrics -- .kc-cli/experiments/eval-runs/<runId>
# or: npx tsx scripts/eval/metrics.ts .kc-cli/experiments/eval-runs/<runId>
```

Optional flags for `run-baseline` / `run-task`:

- `--run <runId>` — run directory name (default: `mock-<timestamp>`)
- `--runs-root <dir>` — override `.kc-cli/experiments/eval-runs` (useful in tests)
- `--sets-dir <dir>` — override `scripts/eval/sets`
- `--backend mock` — only backend shipped in T1; real provider backends need an explicit switch + API key (T5)

## How to run a baseline

1. Ensure splits are frozen: edit `sets/*.json` only when intentionally re-baselining; never mid-experiment.
2. `npm run eval:baseline` — writes `.kc-cli/experiments/eval-runs/<runId>/summary.json`.
3. Compare against a candidate later with T5/T6 acceptance gate (`scripts/agp/acceptance-gate.ts`, not yet in T1). Until then, compare two `summary.json` files by reading `splits.held-in` / `splits.held-out`.

## Comparing baseline vs candidate (preview)

The non-regression gate (spec §3.6) will require:

```
accept =
  candidate.safetyViolations === 0 &&
  ΔheldIn  >= 0 &&
  ΔheldOut >= 0 &&
  (ΔheldIn > 0 || ΔheldOut > 0) &&
  candidate.noPatchRate <= baseline.noPatchRate &&
  candidate.avgCostUsd  <= baseline.avgCostUsd * 1.2
```

T1 only supplies the fixed splits + mock baseline metrics. The gate itself is T6.

## Known traps

- **Baseline handles are volatile across turns.** Always read baseline state
  from `.workbuddy/eval/<run>/baseline/*.log`, never from an in-memory task
  handle or background job reference.
- **Numeric conclusions are claims, not facts.** A sub-agent's count must cite
  a verbatim `CommandRunClaim.evidenceLine`; the controller should rerun the
  command and treat `control/<name>.json` as authoritative.
- **Probe answers must contain the controller's required keywords.** Use
  `validate-probe` before declaring a checkpoint answered; missing keywords
  fail with a ready-to-send follow-up instead of silently passing.
- **"作答见消息开头"/"stdout 未被捕获" are deflection signals.** The report
  integrity gate (R1/R5) flags them when evidence shows otherwise.
- **Do not persist raw tool output bundles.** Only bounded summaries belong in
  run artifacts; command stdout is truncated to 4 KB.
- **Mock backend is deterministic by design.** Same set + same mock config →
  same SplitResult. Do not inject timestamps/random into metric fields.
- **Candidates must not read held-out.** Generators and candidates may only
  use held-in metadata; held-out content and outputs stay in the lab evaluator.
