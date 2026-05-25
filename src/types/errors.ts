/**
 * Error interface for command execution errors.
 * Extends the standard Error with properties from child_process errors.
 */
export interface ExecError extends Error {
  /** Exit code from the process */
  code?: number;
  /** Signal that killed the process */
  signal?: string;
  /** Standard error output */
  stderr?: string;
  /** Standard output */
  stdout?: string;
  /** The command that was executed */
  cmd?: string;
  /** Whether the process was killed by timeout */
  killed?: boolean;
}

/**
 * Type guard to check if an error is an ExecError.
 */
export function isExecError(error: unknown): error is ExecError {
  return (
    error instanceof Error &&
    (
      'code' in error ||
      'signal' in error ||
      'stderr' in error ||
      'stdout' in error
    )
  );
}

/**
 * Safely extract error message from unknown error type.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * Safely extract error stack from unknown error type.
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}
