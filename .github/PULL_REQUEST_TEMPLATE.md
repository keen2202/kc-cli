# Pull Request

## Summary

<!-- What does this PR do? -->

## Docs–Implementation Consistency Checklist (audit round3 T12)

AGENTS.md is the single source of truth for agent-facing claims. If your change
touches any of the following, update BOTH the code and AGENTS.md/README in the
same PR — reviewers will spot-check these numbers:

- [ ] **Provider count** claims (`11 provider endpoints / 3 client classes`) — `src/api/index.ts` factory + README Features
- [ ] **Tool count** claims (`23 registered tools = 21 under src/tools/ + TeamCreate + LSP`) — `src/tools/registry.ts` TOOL_MANIFEST
- [ ] **Submodule count** claims (`13 QueryEngine sub-modules`) — `src/query/QueryEngine*.ts`
- [ ] **Hook model** wording (`call` + permission check + plugin preToolUse/postToolUse; NO per-tool prepare/finalize) — executor pipeline
- [ ] **Memory features** wording (auto-extraction yes; consolidation parked → `docs/specs/memory-consolidation-pending.md`)
- [ ] **Reserved subsystems** labeled as such (AGP evolution infra, IM adapters)

## Checklist

- [ ] `npm run typecheck` zero errors
- [ ] Tests added/updated for behavior changes (UI changes need `test/ui/behavior/**` tests)
- [ ] No soft-skips added (`it.skipIf`/`describe.skipIf` only, visible in reporter)
- [ ] No new `vi.mock` of permissions/sandbox/protectedPaths with call-count assertions
- [ ] Coverage ratchet baseline respected (`scripts/coverage-ratchet.mjs`)
