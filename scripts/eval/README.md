# Agent Long-Task Eval Harness Helpers

This directory contains tracked helpers for the long-task evaluation harness
described in `docs/specs/agent-report-integrity-spec.md` §3.4 (RI-T10).

The external `agent-longtask-eval-harness` skill is not shipped with this
repository. `agent-longtask-harness.mjs` provides the deterministic,
file-based pieces required by the spec so controllers can adopt them without
relying on volatile process handles.

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
```

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
  run artifacts; command stdout is truncated to 4 KB in memory by the
  ExecutionEnv trace.
