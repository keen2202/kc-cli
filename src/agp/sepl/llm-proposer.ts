/**
 * LLM-driven proposer (T6 / M1).
 *
 * Generates bounded candidate edits for a single evolvable instruction
 * surface, replacing the random-perturbation improvers with evidence-driven
 * proposals. Every accepted or rejected candidate carries the mandatory
 * audit quadruple {targetFailurePattern, editedSurface, expectedEffect,
 * regressionRisk}; candidates missing any field are rejected outright.
 *
 * Enablement is a code-level gate, not a convention: `LLMProposer` has a
 * private constructor and can only be created through `createGated`, which
 * requires an enabled T4 acceptance gate AND an injected T5 evaluator
 * backend. Without both, callers get `null` and SEPL keeps its heuristic
 * improvers unchanged.
 *
 * Proposal constraints (spec §3.3.1):
 * - diverse across branches — normalized duplicates are rejected;
 * - minimal within a branch — single surface edit, bounded length;
 * - only evolvable surfaces — editedSurface must match the target resource
 *   (or an explicit allow-list).
 */

import type { AuditLog } from '../audit-log';
import type { BudgetEnforcer } from '../../services/budget';
import type {
  AcceptanceGateConfig,
  EvaluatorBackend,
  EvidenceBundle,
  Modification,
  ProposalAudit,
  ProposalCandidate,
} from './protocol';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BRANCHES = 3;
const DEFAULT_ESTIMATED_TOKENS_PER_PROPOSAL = 2000;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 1024;
/** Minimality bound: proposed value length ≤ max(current × 3, this floor). */
const MINIMALITY_LENGTH_FLOOR = 500;
const AUDIT_FIELDS: ReadonlyArray<keyof ProposalAudit> = [
  'targetFailurePattern',
  'editedSurface',
  'expectedEffect',
  'regressionRisk',
];

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal structural chat interface. Satisfied by any BaseApiClient-shaped
 * client (including MockLLMClient) via method-parameter bivariance — keeps
 * agp free of a runtime dependency on `api/`.
 */
export interface ProposerChatClient {
  chat(config: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; usage?: { totalTokens: number } }>;
}

export interface LLMProposerOptions {
  /** Isolated LLM client used only for proposal generation */
  client: ProposerChatClient;
  /** Audit log for the mandatory proposal trail */
  auditLog?: AuditLog;
  /** Budget enforcer bounding proposal-generation spend */
  budget?: BudgetEnforcer;
  /** Parallel proposal branches (default 3) */
  branches?: number;
  /** Pre-charged token estimate per branch (default 2000) */
  estimatedTokensPerProposal?: number;
  /** Sampling temperature (default 0.8) */
  temperature?: number;
  /** Extra surfaces the proposer may edit beyond the target resource */
  allowedSurfaces?: string[];
}

export interface ProposeInput {
  /** Evidence bundle the proposal must target (T3) */
  evidence: EvidenceBundle;
  /** The modification whose target surface is being rewritten */
  targetMod: Modification;
  /** Current value of the target variable */
  currentValue: string;
  sessionId?: string;
  iteration?: number;
}

/** Gate inputs required to construct a proposer at all. */
export interface ProposerGate {
  acceptanceGate?: AcceptanceGateConfig;
  evaluatorBackend?: EvaluatorBackend | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convenience for callers that have no failure evidence yet. */
export function emptyEvidenceBundle(): EvidenceBundle {
  return { clusters: [], totalFailures: 0, generatedAt: Date.now() };
}

/** Collapse whitespace so wording-only variants and no-ops are detectable. */
function normalizeProposal(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Extract the first JSON object from an LLM response (fences tolerated). */
function parseProposal(content: string): { proposedValue?: unknown; audit?: Partial<ProposalAudit> } | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Return the first missing/empty audit field, or null if complete. */
function findMissingAuditField(audit: Partial<ProposalAudit> | undefined): string | null {
  if (!audit || typeof audit !== 'object') return AUDIT_FIELDS[0];
  for (const field of AUDIT_FIELDS) {
    const value = audit[field];
    if (typeof value !== 'string' || value.trim().length === 0) return field;
  }
  return null;
}

// ─── LLM Proposer ────────────────────────────────────────────────────────────

export class LLMProposer {
  readonly name = 'llm-proposer';

  private client: ProposerChatClient;
  private auditLog?: AuditLog;
  private budget?: BudgetEnforcer;
  private branches: number;
  private estimatedTokensPerProposal: number;
  private temperature: number;
  private allowedSurfaces: Set<string>;

  private constructor(options: LLMProposerOptions) {
    this.client = options.client;
    this.auditLog = options.auditLog;
    this.budget = options.budget;
    this.branches = Math.max(1, options.branches ?? DEFAULT_BRANCHES);
    this.estimatedTokensPerProposal =
      options.estimatedTokensPerProposal ?? DEFAULT_ESTIMATED_TOKENS_PER_PROPOSAL;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.allowedSurfaces = new Set(options.allowedSurfaces ?? []);
  }

  /**
   * Code-level enablement gate: an LLM proposer exists only when the T4
   * acceptance gate is enabled AND a T5 evaluator backend is wired in.
   * Otherwise returns null (callers keep heuristic improvers).
   */
  static createGated(
    options: LLMProposerOptions,
    gate: ProposerGate,
    log?: (message: string) => void
  ): LLMProposer | null {
    if (!gate.acceptanceGate?.enabled) {
      log?.('llm-proposer: acceptance gate disabled — staying on heuristic improvers');
      return null;
    }
    if (!gate.evaluatorBackend) {
      log?.('llm-proposer: no evaluator backend injected — staying on heuristic improvers');
      return null;
    }
    return new LLMProposer(options);
  }

  /**
   * Generate up to `branches` diverse candidates for a single surface.
   * Budget is pre-charged per branch; exhaustion stops further launches.
   */
  async propose(input: ProposeInput): Promise<ProposalCandidate[]> {
    const launches: Array<Promise<ProposalCandidate | null>> = [];

    for (let branch = 0; branch < this.branches; branch++) {
      if (this.budget) {
        const check = this.budget.checkSubAgentBudget(this.estimatedTokensPerProposal);
        if (!check.allowed) {
          this.recordRejection(input, branch, `budget: ${check.reason ?? 'sub-agent budget exhausted'}`);
          break;
        }
        this.budget.recordUsage(this.estimatedTokensPerProposal);
      }
      launches.push(this.runBranch(branch, input));
    }

    const settled = await Promise.all(launches);

    // Cross-branch diversity: reject no-ops and normalized duplicates.
    const currentNorm = normalizeProposal(input.currentValue);
    const seen = new Set<string>();
    const accepted: ProposalCandidate[] = [];
    for (const candidate of settled) {
      if (!candidate) continue;
      const norm = normalizeProposal(candidate.proposedValue);
      if (norm === currentNorm) {
        this.recordAuditedRejection(input, candidate.audit, 'no-op: proposal identical to current value');
        continue;
      }
      if (seen.has(norm)) {
        this.recordAuditedRejection(input, candidate.audit, 'duplicate: wording-variant of an earlier branch');
        continue;
      }
      seen.add(norm);
      accepted.push(candidate);
      this.auditLog?.recordProposal(input.sessionId ?? 'unknown', input.iteration ?? 0, {
        targetResource: input.targetMod.targetResource,
        changeType: input.targetMod.changeType,
        proposer: this.name,
        audit: candidate.audit,
        accepted: true,
      });
    }
    return accepted;
  }

  // ─── Branch execution ──────────────────────────────────────────────────────

  private async runBranch(branch: number, input: ProposeInput): Promise<ProposalCandidate | null> {
    let content: string;
    try {
      const response = await this.client.chat({
        messages: [
          { role: 'system', content: this.buildSystemPrompt() },
          { role: 'user', content: this.buildUserPrompt(branch, input) },
        ],
        temperature: this.temperature,
        maxTokens: DEFAULT_MAX_TOKENS,
      });
      content = response.content;
    } catch (error) {
      this.recordRejection(input, branch, `llm error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    const parsed = parseProposal(content);
    if (!parsed || typeof parsed.proposedValue !== 'string' || parsed.proposedValue.length === 0) {
      this.recordRejection(input, branch, 'unparseable proposal: expected JSON with a non-empty proposedValue');
      return null;
    }

    // Mandatory audit quadruple — missing any field is an outright rejection.
    const missing = findMissingAuditField(parsed.audit);
    if (missing) {
      this.recordRejection(input, branch, `audit quadruple incomplete: missing "${missing}"`);
      return null;
    }
    const audit = parsed.audit as ProposalAudit;

    // Only evolvable surfaces: the edited surface must be the target (or allow-listed).
    if (audit.editedSurface !== input.targetMod.targetResource && !this.allowedSurfaces.has(audit.editedSurface)) {
      this.recordAuditedRejection(input, audit, `surface out of bounds: "${audit.editedSurface}" is not the target resource`);
      return null;
    }

    // Within-branch minimality: single-surface edit with a bounded length.
    const bound = Math.max(input.currentValue.length * 3, MINIMALITY_LENGTH_FLOOR);
    if (parsed.proposedValue.length > bound) {
      this.recordAuditedRejection(input, audit, `exceeds minimality bound: ${parsed.proposedValue.length} > ${bound} chars`);
      return null;
    }

    return { proposedValue: parsed.proposedValue, audit };
  }

  // ─── Prompt construction ───────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return [
      'You are a harness-evolution proposer. You edit exactly one instruction surface.',
      'Respond with a single JSON object and nothing else:',
      '{"proposedValue": "<full replacement text>", "audit": {"targetFailurePattern": "...", "editedSurface": "...", "expectedEffect": "...", "regressionRisk": "..."}}',
      'All four audit fields are mandatory. Keep the edit minimal and targeted.',
    ].join('\n');
  }

  private buildUserPrompt(branch: number, input: ProposeInput): string {
    const clusters = input.evidence.clusters.slice(0, 3).map(c => {
      const symptom = c.sharedSymptoms[0] ?? 'no shared symptom recorded';
      return `- ${c.signature.terminalCause}/${c.signature.mechanism} (${c.signature.causalStatus}, ×${c.count}): ${symptom}`;
    });
    return [
      `Target surface: ${input.targetMod.targetResource} (changeType: ${input.targetMod.changeType})`,
      `Failure evidence (${input.evidence.totalFailures} failures total):`,
      clusters.length > 0 ? clusters.join('\n') : '- (no clustered failures — propose a conservative clarification)',
      'Current value:',
      '---',
      input.currentValue,
      '---',
      `Branch ${branch + 1} of ${this.branches}: propose an alternative that is substantively distinct from other branches.`,
      `Set audit.editedSurface to exactly "${input.targetMod.targetResource}".`,
    ].join('\n');
  }

  // ─── Audit recording ───────────────────────────────────────────────────────

  /** Rejection before a complete audit quadruple exists (parse/LLM/budget failures). */
  private recordRejection(input: ProposeInput, branch: number, reason: string): void {
    this.auditLog?.record({
      sessionId: input.sessionId ?? 'unknown',
      iteration: input.iteration ?? 0,
      phase: 'proposal',
      details: {
        proposer: this.name,
        branch,
        target: input.targetMod.targetResource,
        changeType: input.targetMod.changeType,
      },
      resources: [input.targetMod.targetResource],
      success: false,
      error: reason,
    });
  }

  /** Rejection of a candidate that did carry a complete audit quadruple. */
  private recordAuditedRejection(input: ProposeInput, audit: ProposalAudit, reason: string): void {
    this.auditLog?.recordProposal(input.sessionId ?? 'unknown', input.iteration ?? 0, {
      targetResource: input.targetMod.targetResource,
      changeType: input.targetMod.changeType,
      proposer: this.name,
      audit,
      accepted: false,
      reason,
    });
  }
}
