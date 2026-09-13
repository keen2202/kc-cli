# Offline AGP lab

Offline experiment runtime for kc-cli (product-identity v3.3). Core only reads
a promoted catalog; this directory owns candidates, evaluation, the acceptance
gate, promotion, and rollback.

## End-to-end demo (T8)

```bash
npm run agp:demo
# or: npx tsx scripts/agp/cli.ts demo --no-promote --repeats 3
```

Pipeline: load `candidates/failure-recovery-001.json` → mock evaluatePair
(held-in + held-out, 3 repeats averaged) → acceptance gate → promote → catalog
`active`.

Mock pin carries `mockTaskOverrides` so the candidate arm can show a real
Δ verifiedTaskRate without touching eval sets/fixtures. The production payload
stays the prompt-surface text.

### Kill criteria (spec §5.3)

Stop and keep AGP archived if:

- the same candidate is irreproducible across two rounds on the same split
- three candidates all fail to beat baseline without regression
- evaluation cost exceeds budget or triggers safety violations
- making the experiment work would require changing permissions/sandbox/protectedPaths/executor

## Commands

```bash
npm run agp:status
npm run agp:list
npm run agp:evaluate -- --baseline-run <dir> --candidate-run <dir> --repeats 3
npx tsx scripts/agp/cli.ts promote <artifactId> <variantId> --yes
npx tsx scripts/agp/cli.ts rollback <artifactId> --yes
```

## Layout

```
scripts/agp/
  lab-paths.ts           paths, baseHash, atomic JSON write
  version-store.ts       lineage snapshots
  overlay-store.ts       baseline + variants + status machine
  evidence-store.ts      immutable evidence by hash
  catalog-writer.ts      rebuild catalog.json (temp+rename)
  acceptance-gate.ts     pure non-regression gate (T6)
  promotion.ts           evidence-bound promote / rollback
  decision-log.ts        append-only decisions.jsonl
  artifact-adapter.ts    frozen allowlist + candidate schema
  candidate-generator.ts manual JSON intake + held-in isolation
  evaluator-backend.ts   EvaluatorBackend / VariantPin / evaluatePair
  mock-longtask-backend.ts  deterministic mock evaluator
  swebench-backend.ts    blocked skeleton (no adapter in repo yet)
  e2e.ts                 T8 demo pipeline
  candidates/            manual candidate JSON
  cli.ts                 status | list | archive | evaluate | promote | rollback | demo
```

## Invariants

- `src/**` never imports `scripts/agp/**`
- Lab may type-only import `src/experiments/{protocol,catalog}.ts`
- Catalog is written only here; runtime (`FileExperimentRuntime`) is read-only
- Candidates cannot write eval sets, fixtures, or evaluator sources
- Promote requires `--yes` + gate-report evidence with `accept=true`
