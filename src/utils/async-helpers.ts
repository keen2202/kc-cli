// Shared async helpers — extracted to avoid repeated Promise.race / retry
// boilerplate across the codebase (QUAL-05).

/**
 * Race a promise against a timeout.
 * Rejects with a TimeoutError if the timeout fires before the promise settles.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wrap a promise with a timeout.  If the timeout fires first the returned
 * promise is rejected with a {@link TimeoutError}.
 *
 * @param promise - The operation to protect.
 * @param ms      - Timeout in milliseconds.
 * @param message - Optional error message (defaults to "Timeout after Nms").
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new TimeoutError(message ?? `Timeout after ${ms}ms`));
    }, ms);
    // Allow the process to exit even if this timer is still pending.
    if (typeof id === 'object' && typeof id.unref === 'function') {
      id.unref();
    }
    promise.then(
      (val) => { clearTimeout(id); resolve(val); },
      (err) => { clearTimeout(id); reject(err); },
    );
  });
}

/**
 * Options for {@link withRetry}.
 */
export interface WithRetryOptions {
  /** Maximum number of attempts (including the first). */
  maxRetries: number;
  /** Base delay between retries in ms (doubled after each attempt). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default 30 s). */
  maxDelayMs?: number;
  /**
   * Optional predicate that controls whether a failed attempt should be
   * retried.  When omitted every error is considered retryable.
   */
  canRetry?: (error: unknown, attempt: number) => boolean;
  /**
   * Optional callback invoked before each retry delay (useful for logging).
   */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Retry a function with exponential backoff.
 *
 * @example
 * const data = await withRetry(() => api.fetchData(), { maxRetries: 3 });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const {
    maxRetries,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    canRetry,
    onRetry,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) break;
      if (canRetry && !canRetry(error, attempt)) break;

      onRetry?.(error, attempt);

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
