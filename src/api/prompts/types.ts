// Prompt template types for provider-specific system prompts

export type TaskType = 'code-gen' | 'debugging' | 'refactoring' | 'documentation' | 'creative' | 'general';

export interface PromptTemplate {
  /** Base system prompt for this provider */
  system: string;
  /** Tool use instructions */
  toolUse: string;
  /** Code generation instructions */
  codeGen: string;
  /** Debugging instructions */
  debugging: string;
  /** Refactoring instructions */
  refactoring: string;
  /** Documentation instructions */
  documentation: string;
  /** Creative content generation instructions */
  creative: string;
  /** Reasoning instructions */
  reasoning: string;
  /** Planning phase instructions (3-phase workflow) */
  planning?: string;
  /** Build/test command hints for language-specific projects */
  build?: string;
}

// ── Instruction surfaces (harness-evolution T1 / H1) ─────────────────────────
// Declarative manifest of prompt instruction segments. Static surfaces are
// composed byte-equivalently by PromptBuilder; conditional surfaces carry a
// runtime predicate and are injected per-turn by QueryEngine (opt-in).

export type InstructionSurfaceCategory =
  | 'bootstrap'
  | 'execution'
  | 'verification'
  | 'failureRecovery';

/** Runtime state evaluated by conditional surface predicates each turn. */
export interface InstructionSurfaceRuntime {
  /** True until the conversation contains a tool message (Self-Harness bootstrap rule). */
  isFirstTurn: boolean;
  /** True when the most recent tool message contains an errored tool result. */
  lastToolResultHadError: boolean;
}

export interface InstructionSurface {
  /** Unique surface name (stable identifier for AGP registration) */
  name: string;
  category: InstructionSurfaceCategory;
  /** Produce the surface text. Runtime is only supplied for conditional surfaces. */
  build: (runtime?: InstructionSurfaceRuntime) => string;
  /** When present, the surface is conditional: injected only when the predicate holds. */
  predicate?: (runtime: InstructionSurfaceRuntime) => boolean;
  /** Whether SEPL may evolve this surface's text (AGP evolvability flag) */
  evolvable: boolean;
}
