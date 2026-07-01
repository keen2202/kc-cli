import chalk from 'chalk';
import type { Theme } from '../theme';

export type NotificationLevel = 'error' | 'warning' | 'success' | 'info';

export interface Notification {
  level: NotificationLevel;
  message: string;
  guidance?: string;
}

const LEVEL_ICONS: Record<NotificationLevel, string> = {
  error: '✗',
  warning: '⚠',
  success: '✓',
  info: 'ℹ',
};

const LEVEL_COLORS: Record<NotificationLevel, (s: string) => string> = {
  error: chalk.red,
  warning: chalk.yellow,
  success: chalk.green,
  info: chalk.cyan,
};

/**
 * Render a single notification line suitable for display above or below the input area.
 */
export function renderNotification(notif: Notification, maxWidth: number, theme?: Theme): string {
  const tokens = theme?.resolve();
  const icon = LEVEL_ICONS[notif.level];
  const colorFn = LEVEL_COLORS[notif.level];

  const prefix = colorFn(` ${icon} `);
  const prefixLen = prefix.replace(/\x1B\[[0-9;]*m/g, '').length;

  let body = notif.message;
  if (notif.guidance) {
    body += ' ' + chalk.gray.dim(notif.guidance);
  }

  const maxBodyLen = maxWidth - prefixLen - 2;
  if (body.length > maxBodyLen) {
    body = body.slice(0, maxBodyLen - 1) + '…';
  }

  return prefix + colorFn(body);
}

/**
 * Build pre-formatted notifications for common failure scenarios.
 */
export function buildKeyInvalidNotification(keyError: string): Notification {
  return {
    level: 'error',
    message: keyError,
    guidance: 'Use /key <your-key> or set KC_API_KEY environment variable.',
  };
}

export function buildSendFailedNotification(errorMessage: string): Notification {
  return {
    level: 'error',
    message: `Message send failed: ${errorMessage}`,
    guidance: 'Check your API key and network connection, then try again.',
  };
}

export function buildInputFormatError(message: string): Notification {
  return {
    level: 'warning',
    message,
    guidance: 'Correct the input format and try again.',
  };
}

export function buildNetworkErrorNotification(): Notification {
  return {
    level: 'error',
    message: 'Network error — unable to reach the API server.',
    guidance: 'Check your internet connection and API base URL.',
  };
}

export function buildRateLimitNotification(retryAfter?: string): Notification {
  return {
    level: 'warning',
    message: 'Rate limit exceeded.' + (retryAfter ? ` Retry after ${retryAfter}.` : ''),
    guidance: 'Wait a moment before sending another message.',
  };
}

export function buildEmptyApiKeyNotification(): Notification {
  return {
    level: 'error',
    message: 'No API key configured.',
    guidance: 'Set it with /key <your-key> or the KC_API_KEY environment variable.',
  };
}
