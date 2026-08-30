// Process-wide fatal-error guards (round4 §2-S3).
//
// Kept in its own module (rather than inline in the entry file) so the default
// interactive path can be verified without importing — and thereby executing —
// the CLI entry point.

import chalk from 'chalk';
import { logger } from '../services/logger';
import { getErrorMessage } from './errors';
import { EXIT } from './exit-codes';

/** Persists whatever conversation state is recoverable. Must never throw. */
export type CrashSnapshotSaver = (reason: string) => Promise<void>;

export interface CrashGuardHandle {
  /** Register (or replace) the emergency snapshot callback for the active entry path. */
  setSnapshotSaver(saver: CrashSnapshotSaver): void;
  /** Detach the process listeners. Intended for tests and graceful shutdown. */
  uninstall(): void;
}

const noopSaver: CrashSnapshotSaver = async () => {};

/**
 * Install `uncaughtException` / `unhandledRejection` handlers for the whole
 * process. Without these, a floating promise rejection in the ink UI path
 * terminates Node before the session is written to disk and before the
 * terminal is restored from raw mode.
 *
 * Returns a handle so the active entry path can attach its own session service
 * and so tests can detach the listeners again.
 */
export function installGlobalCrashGuards(): CrashGuardHandle {
  let snapshotSaver: CrashSnapshotSaver = noopSaver;

  const onFatal = (err: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void => {
    const message = getErrorMessage(err);
    logger.main.error(`fatal ${kind}`, {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    console.error(
      chalk.red(`\n\u{1F4A5} Fatal ${kind}: ${message} \u2014 saving session before exit...`),
    );
    void snapshotSaver(kind)
      .catch((saveErr) => logger.main.error('emergency save failed', { error: String(saveErr) }))
      .finally(() => process.exit(EXIT.FAILURE));
  };

  const onUncaughtException = (error: Error): void => onFatal(error, 'uncaughtException');
  const onUnhandledRejection = (reason: unknown): void => onFatal(reason, 'unhandledRejection');

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return {
    setSnapshotSaver(saver: CrashSnapshotSaver): void {
      snapshotSaver = saver;
    },
    uninstall(): void {
      process.off('uncaughtException', onUncaughtException);
      process.off('unhandledRejection', onUnhandledRejection);
      snapshotSaver = noopSaver;
    },
  };
}
