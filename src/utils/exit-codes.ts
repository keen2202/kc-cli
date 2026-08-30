// Canonical process exit codes (round4 §3-R3).
//
// Before this table existed, permission denials, agent errors and SIGTERM all
// reported 0, so automation could not tell a failed run from a successful one.

export const EXIT = {
  /** Successful run. */
  OK: 0,
  /** Any failure: agent error, tool failure, permission denial, budget exceeded. */
  FAILURE: 1,
  /** SIGINT — the user aborted with Ctrl+C. */
  CANCELLED: 130,
  /** SIGTERM — 128 + 15. Distinguishes "killed" from "cancelled". */
  SIGTERM: 143,
} as const;

/** Accumulates whether a run failed, and why. */
export interface RunOutcome {
  failed: boolean;
  reasons: string[];
}

export function createRunOutcome(): RunOutcome {
  return { failed: false, reasons: [] };
}

/** Record a failure reason and flip the outcome to failed. */
export function markFailed(outcome: RunOutcome, reason: string): void {
  outcome.failed = true;
  outcome.reasons.push(reason);
}

/** The process exit code implied by an outcome. */
export function exitCodeFor(outcome: RunOutcome): number {
  return outcome.failed ? EXIT.FAILURE : EXIT.OK;
}

/**
 * Event types that mean "this run did not succeed". Permission denials and
 * budget exhaustion are included because automation must be able to tell them
 * apart from a clean finish — they previously still exited 0.
 */
export const FAILURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent:error',
  'agent:tool_failed',
  'agent:tool_permission_denied',
  'agent:budget_exceeded',
  'error',
]);

/** True when a streamed event represents a failed run. */
export function isFailureEvent(event: { type: string }): boolean {
  return FAILURE_EVENT_TYPES.has(event.type);
}
