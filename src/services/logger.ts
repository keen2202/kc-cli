// Structured Logging Framework
// Provides level-filtered, structured logging with correlation IDs

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
  correlationId?: string;
}

export type LogFormatter = (entry: LogEntry) => string;

// Global configuration
let globalMinLevel: LogLevel = 'info';
let globalCorrelationId: string | undefined;
let globalFormatter: LogFormatter = defaultFormatter;
let globalOutput: (message: string) => void = console.error;

/**
 * Configure global logging settings
 */
export function configureLogger(options: {
  minLevel?: LogLevel;
  correlationId?: string;
  formatter?: LogFormatter;
  output?: (message: string) => void;
}): void {
  if (options.minLevel !== undefined) globalMinLevel = options.minLevel;
  if (options.correlationId !== undefined) globalCorrelationId = options.correlationId;
  if (options.formatter !== undefined) globalFormatter = options.formatter;
  if (options.output !== undefined) globalOutput = options.output;
}

/**
 * Set the global correlation ID (e.g., for session tracking)
 */
export function setCorrelationId(id: string): void {
  globalCorrelationId = id;
}

/**
 * Set the minimum log level
 */
export function setLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

/**
 * Logger class for structured logging
 */
export class Logger {
  private module: string;
  private minLevel: LogLevel;

  constructor(module: string, minLevel?: LogLevel) {
    this.module = module;
    this.minLevel = minLevel ?? globalMinLevel;
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  /**
   * Log an error message
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /**
   * Create a child logger with additional context
   */
  child(subModule: string): Logger {
    return new Logger(`${this.module}:${subModule}`, this.minLevel);
  }

  /**
   * Check if a level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // Check if this level is enabled
    if (!this.isLevelEnabled(level)) return;

    const entry: LogEntry = {
      level,
      module: this.module,
      message,
      data,
      timestamp: Date.now(),
      correlationId: globalCorrelationId,
    };

    const formatted = globalFormatter(entry);
    globalOutput(formatted);
  }
}

/**
 * Default log formatter - JSON structured output
 */
function defaultFormatter(entry: LogEntry): string {
  const { level, module, message, data, timestamp, correlationId } = entry;

  const logObject: Record<string, unknown> = {
    timestamp: new Date(timestamp).toISOString(),
    level,
    module,
    message,
  };

  if (correlationId) {
    logObject.correlationId = correlationId;
  }

  if (data && Object.keys(data).length > 0) {
    logObject.data = data;
  }

  return JSON.stringify(logObject);
}

/**
 * Human-readable formatter for development
 */
export function devFormatter(entry: LogEntry): string {
  const { level, module, message, data, timestamp } = entry;
  const time = new Date(timestamp).toISOString().substring(11, 23);
  const levelStr = level.toUpperCase().padEnd(5);
  const dataStr = data ? ' ' + JSON.stringify(data) : '';

  return `${time} ${levelStr} [${module}] ${message}${dataStr}`;
}

/**
 * Create a logger for a specific module
 */
export function createLogger(module: string, minLevel?: LogLevel): Logger {
  return new Logger(module, minLevel);
}

// Pre-configured loggers for common modules
export const logger = {
  api: createLogger('api'),
  cache: createLogger('cache'),
  lsp: createLogger('lsp'),
  mcp: createLogger('mcp'),
  memory: createLogger('memory'),
  orchestrator: createLogger('orchestrator'),
  permissions: createLogger('permissions'),
  plugins: createLogger('plugins'),
  query: createLogger('query'),
  services: createLogger('services'),
  tools: createLogger('tools'),
};

// Register with DI container for consumers
import { getServiceContainer } from './ServiceContainer';
getServiceContainer().register('logger', () => logger, 'singleton');
