# KC-CLI RepoWiki

> AI-powered intelligent CLI agent system for software development. v3.2.0, TypeScript, ESM.

## Overview

KC-CLI is a modular CLI agent that orchestrates LLM providers, 21 built-in tools, sandboxed execution, and multi-agent coordination to assist developers. Architecture patterns derived from comparative analysis of PilotDeck (OpenBMB) and pi (earendil-works).

## Quick Navigation

### Core Architecture
- [[Architecture]] -- System design, module interconnections, data flow
- [[Query-Engine]] -- Core state machine: idle -> compact -> stream -> decide -> execute
- [[State-Management]] -- Observable state store, session tree, state machine validation

### Subsystems
- [[Tools-System]] -- 21 built-in tools, plugin-hook execution pipeline, lazy loading, registry
- [[API-Clients]] -- 11 LLM providers, streaming protocol, prompt system
- [[Permission-System]] -- 6-step deny-first engine, protected paths, plugin rules
- [[Sandbox]] -- Docker/Bubblewrap/seccomp isolation, HMAC signing, policy system
- [[Orchestrator]] -- Multi-agent lifecycle, EventBus, permission cascading
- [[Memory-System]] -- File-based persistent memory, relevance search, auto-extraction
- [[Plugin-System]] -- Contribution-based plugins, hooks, permission rules
- [[UI-System]] -- Terminal UI (ink/React), layout system, focus-stack dialogs, theme system
- [[Configuration]] -- 5-layer config, env vars, Zod validation
- AGP (Autogenesis Protocol) -- Self-evolving multi-agent system with SEPL pipeline

### Development
- [[Development-Guide]] -- Setup, commands, testing, conventions
- [[Testing]] -- Vitest patterns, mocks, coverage, test structure

## Key Metrics

| Metric | Value |
|--------|-------|
| Version | 3.2.0 |
| Language | TypeScript (strict, ES2022, ESNext modules) |
| Built-in Tools | 21 |
| LLM Providers | 11 |
| Test Files | 178 |
| Tests | 3899 |
| Source Modules | 23 directories |
| Error Codes | 18 (KCError) |

## Architecture Diagram

```
                          ┌──────────────┐
                          │   main.ts    │
                          │  (5 phases)  │
                          └──────┬───────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼────────┐ ┌──────▼──────┐ ┌─────────▼────────┐
     │   Bootstrap     │ │   Tools     │ │   Plugins        │
     │ config + state  │ │  Registry   │ │  PluginManager   │
     └────────┬────────┘ └──────┬──────┘ └─────────┬────────┘
              │                 │                   │
              └────────┬────────┴───────────────────┘
                       │
              ┌────────▼────────┐
              │  QueryEngine    │◄─── State Machine
              │  (Facade)       │     (idle/compact/stream/decide/execute)
              └───┬───┬───┬───┬┘
                  │   │   │   │
    ┌─────────────┘   │   │   └─────────────┐
    │                 │   │                 │
┌───▼───┐  ┌─────────▼┐ ┌▼────────┐ ┌──────▼──────┐
│ State │  │Compaction│ │ Memory  │ │   Error     │
│  Conv │  │ Handler  │ │ Handler │ │  Handler    │
└───┬───┘  └─────────┬┘ └┬────────┘ └──────┬──────┘
    │                │   │                 │
    └────────┬───────┴───┴─────────────────┘
             │
    ┌────────▼────────┐
    │ ToolExecutor    │
    │ (single/parallel)│
    └───┬────┬────┬───┘
        │    │    │
   ┌────▼┐ ┌▼───┐┌▼────────┐
   │Perm ││Sand││ Plugins  │
   │Engine││box ││ hooks    │
   └─────┘└────┘└──────────┘
             │
    ┌────────▼────────┐
    │ ExecutionEnv    │
    │ (FS + Shell)    │
    └─────────────────┘
```

## Quick Start

```bash
# Install
npm install

# Set API key
export KC_API_KEY=sk-xxx

# Interactive mode
npm run kc

# Single prompt
npm run kc -- "Find all TypeScript files"

# Run tests
npm test
```

## Key Design Decisions

1. **Protocol-first**: Each module exports types in `protocol.ts`, avoiding circular deps
2. **Typed errors**: `KCError` with stable `ErrorCode` for classification and retry decisions
3. **Deny-first permissions**: Security by default, explicit allow
4. **HMAC sandbox markers**: Prevent forgery of sandbox-wrapped commands
5. **Tiered compaction**: 4 engines from cheap to expensive, circuit-breaker protected
6. **Lazy tool loading**: CRITICAL+HIGH eager, MEDIUM+LOW+DEFERRED on-demand
7. **AsyncLocalStorage isolation**: Sub-agents get independent contexts without process spawning


## Reserved subsystems (no deep-dive page yet)

- **AGP (`src/agp/`)** — evolution infrastructure (reserved): global registry, trace manager (evidence bundles feeding failure-bridging memory), prompt adapter. The SEPL self-evolution loop was removed in audit round3 T09; a dedicated wiki page will return only if the subsystem is revived.
- **IM (`src/im/`)** — instant-message adapters (feishu etc.). No deep-dive page; treated as an integration periphery until it gains a stable surface worth documenting.
