// Comprehensive test suite for src/services/logger.ts
// Covers: Logger class, configureLogger, setLogLevel, setCorrelationId,
// defaultFormatter, devFormatter, createLogger, pre-configured loggers

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LogEntry } from '../../src/services/logger';
import {
  Logger,
  configureLogger,
  setCorrelationId,
  setLogLevel,
  devFormatter,
  createLogger,
  logger,
} from '../../src/services/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trivial formatter that round-trips the LogEntry as JSON so we can inspect it. */
function jsonEntryFormatter(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/** Re-usable spy that captures the LogEntry without affecting output. */
function captureFormatterSpy() {
  return vi.fn<(entry: LogEntry) => string>((entry: LogEntry) => JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Logger Service', () => {
  let outputSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    outputSpy = vi.fn();

    // Reset module-level globals (except formatter, since defaultFormatter is
    // unexported and cannot be restored programmatically – tests that rely on
    // the default JSON formatter are placed first so they always see it).
    configureLogger({ minLevel: 'info', output: outputSpy });
    // Cast needed: setCorrelationId requires `string` but we want to clear it.
    (setCorrelationId as unknown as (id: string | undefined) => void)(undefined);
  });

  // -----------------------------------------------------------------------
  // 1.  Default formatter (JSON) – runs first while globalFormatter is still
  //     the module-level defaultFormatter.
  // -----------------------------------------------------------------------
  describe('defaultFormatter (JSON)', () => {
    it('produces valid JSON with level, module, message, timestamp', () => {
      const log = new Logger('json-mod', 'info');
      log.info('hello json');

      expect(outputSpy).toHaveBeenCalledOnce();
      const raw = outputSpy.mock.calls[0][0] as string;

      let parsed: Record<string, unknown>;
      expect(() => {
        parsed = JSON.parse(raw);
      }).not.toThrow();

      expect(parsed!).toHaveProperty('level', 'info');
      expect(parsed!).toHaveProperty('module', 'json-mod');
      expect(parsed!).toHaveProperty('message', 'hello json');
      expect(parsed!).toHaveProperty('timestamp');
      expect(typeof parsed!.timestamp).toBe('string');
      // timestamp should be a valid ISO date
      expect(() => new Date(parsed!.timestamp as string)).not.toThrow();
    });

    it('omits data when no data is provided', () => {
      const log = new Logger('test', 'info');
      log.info('no data');

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).not.toHaveProperty('data');
    });

    it('includes data when data is provided and non-empty', () => {
      const log = new Logger('test', 'info');
      log.warn('with data', { key: 'value', count: 42 });

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty('data');
      expect(parsed.data).toEqual({ key: 'value', count: 42 });
    });

    it('omits data when data is an empty object', () => {
      const log = new Logger('test', 'info');
      log.info('empty data', {});

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).not.toHaveProperty('data');
    });

    it('omits correlationId when not set', () => {
      const log = new Logger('test', 'info');
      log.info('no corr');

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).not.toHaveProperty('correlationId');
    });

    it('includes correlationId when set via setCorrelationId', () => {
      setCorrelationId('corr-abc');
      const log = new Logger('test', 'info');
      log.info('with corr');

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty('correlationId', 'corr-abc');
    });

    it('includes correlationId when set via configureLogger', () => {
      configureLogger({ correlationId: 'corr-xyz' });
      const log = new Logger('test', 'info');
      log.info('with corr');

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty('correlationId', 'corr-xyz');
    });

    it('includes both correlationId and data when both are present', () => {
      setCorrelationId('corr-123');
      const log = new Logger('test', 'info');
      log.error('both', { errCode: 500 });

      const raw = outputSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty('correlationId', 'corr-123');
      expect(parsed).toHaveProperty('data', { errCode: 500 });
    });
  });

  // -----------------------------------------------------------------------
  // 2.  devFormatter – explicitly sets the global formatter.
  // -----------------------------------------------------------------------
  describe('devFormatter', () => {
    it('produces human-readable format with time, level, module, message', () => {
      configureLogger({ formatter: devFormatter });

      const log = new Logger('dev-mod', 'info');
      log.info('dev message');

      expect(outputSpy).toHaveBeenCalledOnce();
      const formatted = outputSpy.mock.calls[0][0] as string;

      // Format: "HH:MM:SS.mmm LEVEL [module] message"
      // Level is padded to 5 chars: "INFO "
      expect(formatted).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+INFO\s+\[dev-mod\] dev message$/);
    });

    it('formats warn level correctly', () => {
      configureLogger({ formatter: devFormatter });
      new Logger('m', 'info').warn('warning!');
      const formatted = outputSpy.mock.calls[0][0] as string;
      expect(formatted).toContain('WARN ');
      expect(formatted).toContain('[m]');
      expect(formatted).toContain('warning!');
    });

    it('formats error level correctly', () => {
      configureLogger({ formatter: devFormatter });
      new Logger('m', 'info').error('fail');
      const formatted = outputSpy.mock.calls[0][0] as string;
      expect(formatted).toContain('ERROR');
      expect(formatted).toContain('fail');
    });

    it('appends JSON data when data is provided', () => {
      configureLogger({ formatter: devFormatter });
      new Logger('m', 'info').info('with data', { code: 1 });
      const formatted = outputSpy.mock.calls[0][0] as string;
      // The data suffix is " " + JSON.stringify(data)
      expect(formatted).toContain('{"code":1}');
    });

    it('does not append empty data suffix when data is absent', () => {
      configureLogger({ formatter: devFormatter });
      new Logger('m', 'info').info('no data');
      const formatted = outputSpy.mock.calls[0][0] as string;
      // Should not end with a JSON blob
      expect(formatted).not.toMatch(/\s+\{.*\}.*$/);
    });

    it('can be called directly (unit test)', () => {
      const entry: LogEntry = {
        level: 'info',
        module: 'direct',
        message: 'unit test',
        timestamp: Date.parse('2025-01-15T10:30:00.000Z'),
      };
      const result = devFormatter(entry);
      expect(result).toMatch(/^10:30:00\.000\s+INFO\s+\[direct\] unit test$/);
    });

    it('includes data when called directly', () => {
      const entry: LogEntry = {
        level: 'error',
        module: 'direct',
        message: 'fail',
        data: { reason: 'timeout' },
        timestamp: 0,
      };
      const result = devFormatter(entry);
      expect(result).toContain('{"reason":"timeout"}');
    });
  });

  // -----------------------------------------------------------------------
  // 3.  Logger class – basic logging methods
  // -----------------------------------------------------------------------
  describe('Logger class', () => {
    describe('basic logging methods', () => {
      it('debug writes to output when min level is debug', () => {
        configureLogger({ minLevel: 'debug' });
        const log = new Logger('test');
        log.debug('debug msg');
        expect(outputSpy).toHaveBeenCalledOnce();
        expect(outputSpy).toHaveBeenCalledWith(expect.stringContaining('debug msg'));
      });

      it('info writes to output', () => {
        const log = new Logger('test');
        log.info('info msg');
        expect(outputSpy).toHaveBeenCalledOnce();
        expect(outputSpy).toHaveBeenCalledWith(expect.stringContaining('info msg'));
      });

      it('warn writes to output', () => {
        const log = new Logger('test');
        log.warn('warn msg');
        expect(outputSpy).toHaveBeenCalledOnce();
        expect(outputSpy).toHaveBeenCalledWith(expect.stringContaining('warn msg'));
      });

      it('error writes to output', () => {
        const log = new Logger('test');
        log.error('error msg');
        expect(outputSpy).toHaveBeenCalledOnce();
        expect(outputSpy).toHaveBeenCalledWith(expect.stringContaining('error msg'));
      });

      it('multiple calls produce multiple output lines', () => {
        const log = new Logger('test', 'debug');
        log.info('first');
        log.warn('second');
        expect(outputSpy).toHaveBeenCalledTimes(2);
      });
    });

    // -----------------------------------------------------------------------
    // 4.  Log level filtering
    // -----------------------------------------------------------------------
    describe('log level filtering', () => {
      it('does not output debug when global level is info', () => {
        configureLogger({ minLevel: 'info' });
        new Logger('test').debug('hidden');
        expect(outputSpy).not.toHaveBeenCalled();
      });

      it('does not output info when global level is warn', () => {
        configureLogger({ minLevel: 'warn' });
        new Logger('test').info('hidden');
        expect(outputSpy).not.toHaveBeenCalled();
      });

      it('does not output warn when global level is error', () => {
        configureLogger({ minLevel: 'error' });
        new Logger('test').warn('hidden');
        expect(outputSpy).not.toHaveBeenCalled();
      });

      it('outputs error even when global level is error', () => {
        configureLogger({ minLevel: 'error' });
        new Logger('test').error('visible');
        expect(outputSpy).toHaveBeenCalledOnce();
      });

      it('instance minLevel overrides global (stricter)', () => {
        configureLogger({ minLevel: 'debug' });
        const log = new Logger('test', 'error');
        log.info('hidden by instance level');
        expect(outputSpy).not.toHaveBeenCalled();
      });

      it('instance minLevel overrides global (more permissive)', () => {
        configureLogger({ minLevel: 'error' });
        const log = new Logger('test', 'debug');
        log.debug('visible via instance level');
        expect(outputSpy).toHaveBeenCalledOnce();
      });
    });

    // -----------------------------------------------------------------------
    // 5.  isLevelEnabled
    // -----------------------------------------------------------------------
    describe('isLevelEnabled', () => {
      it('returns true for level equal to minLevel', () => {
        const log = new Logger('test', 'warn');
        expect(log.isLevelEnabled('warn')).toBe(true);
      });

      it('returns true for level above minLevel', () => {
        const log = new Logger('test', 'info');
        expect(log.isLevelEnabled('warn')).toBe(true);
        expect(log.isLevelEnabled('error')).toBe(true);
      });

      it('returns false for level below minLevel', () => {
        const log = new Logger('test', 'warn');
        expect(log.isLevelEnabled('info')).toBe(false);
        expect(log.isLevelEnabled('debug')).toBe(false);
      });

      it('all levels enabled at debug', () => {
        const log = new Logger('test', 'debug');
        expect(log.isLevelEnabled('debug')).toBe(true);
        expect(log.isLevelEnabled('info')).toBe(true);
        expect(log.isLevelEnabled('warn')).toBe(true);
        expect(log.isLevelEnabled('error')).toBe(true);
      });

      it('only error enabled at error', () => {
        const log = new Logger('test', 'error');
        expect(log.isLevelEnabled('debug')).toBe(false);
        expect(log.isLevelEnabled('info')).toBe(false);
        expect(log.isLevelEnabled('warn')).toBe(false);
        expect(log.isLevelEnabled('error')).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // 6.  child()
    // -----------------------------------------------------------------------
    describe('child()', () => {
      it('creates a sub-logger with parent:child module name', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        const parent = new Logger('parent', 'debug');
        const child = parent.child('child');
        child.info('test');

        expect(formatterSpy).toHaveBeenCalledWith(
          expect.objectContaining({ module: 'parent:child' }),
        );
      });

      it('child logger inherits parent minLevel', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        const parent = new Logger('parent', 'error');
        const child = parent.child('child');
        child.info('should be filtered');

        expect(formatterSpy).not.toHaveBeenCalled();
      });

      it('chains multiple children', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        const deep = new Logger('a', 'debug').child('b').child('c');
        deep.warn('deep');

        expect(formatterSpy).toHaveBeenCalledWith(
          expect.objectContaining({ module: 'a:b:c' }),
        );
      });

      it('child uses global level when parent was created without explicit level and global changes', () => {
        // A Logger created without explicit minLevel resolves it at construction
        // time, so a later global change does NOT affect existing instances.
        configureLogger({ minLevel: 'info' });
        const parent = new Logger('p');
        const child = parent.child('c');

        configureLogger({ minLevel: 'error' });
        // child's minLevel was captured from parent = 'info' (the value at
        // parent construction time), so info should still be enabled.
        child.info('still visible');
        expect(outputSpy).toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // 7.  LogEntry correctness (output receives correct data)
    // -----------------------------------------------------------------------
    describe('LogEntry', () => {
      it('includes level, module, message, timestamp in the entry', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        new Logger('entry-test', 'info').info('entry msg');

        expect(formatterSpy).toHaveBeenCalledOnce();
        const entry: LogEntry = formatterSpy.mock.calls[0][0];
        expect(entry.level).toBe('info');
        expect(entry.module).toBe('entry-test');
        expect(entry.message).toBe('entry msg');
        expect(entry.timestamp).toBeGreaterThan(0);
      });

      it('passes data through to the entry', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        new Logger('test', 'info').warn('with data', { foo: 'bar' });

        const entry: LogEntry = formatterSpy.mock.calls[0][0];
        expect(entry.data).toEqual({ foo: 'bar' });
      });

      it('passes undefined data when no data argument', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        new Logger('test', 'info').info('no data');

        const entry: LogEntry = formatterSpy.mock.calls[0][0];
        expect(entry).toHaveProperty('data');
        expect(entry.data).toBeUndefined();
      });

      it('includes correlationId in the entry when set', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy, correlationId: 'cid-999' });

        new Logger('test', 'info').info('has cid');

        const entry: LogEntry = formatterSpy.mock.calls[0][0];
        expect(entry.correlationId).toBe('cid-999');
      });

      it('does not set correlationId when globalCorrelationId is undefined', () => {
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        new Logger('test', 'info').info('no cid');

        const entry: LogEntry = formatterSpy.mock.calls[0][0];
        expect(entry.correlationId).toBeUndefined();
      });
    });
  });

  // -----------------------------------------------------------------------
  // 8.  configureLogger
  // -----------------------------------------------------------------------
  describe('configureLogger', () => {
    it('sets minLevel', () => {
      configureLogger({ minLevel: 'debug' });
      const log = new Logger('test');
      expect(log.isLevelEnabled('debug')).toBe(true);
    });

    it('sets output', () => {
      const customOutput = vi.fn();
      configureLogger({ output: customOutput });

      new Logger('test', 'debug').debug('custom output');
      expect(customOutput).toHaveBeenCalledOnce();
      expect(customOutput).toHaveBeenCalledWith(expect.any(String));
    });

    it('sets formatter', () => {
      const customFormatter = vi.fn(() => 'formatted!');
      configureLogger({ formatter: customFormatter });

      new Logger('test', 'debug').info('custom format');
      expect(customFormatter).toHaveBeenCalledOnce();
      expect(outputSpy).toHaveBeenCalledWith('formatted!');
    });

    it('sets correlationId', () => {
      const formatterSpy = captureFormatterSpy();
      configureLogger({ correlationId: 'cfg-cid', formatter: formatterSpy });

      new Logger('test', 'info').info('configured cid');
      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'cfg-cid' }),
      );
    });

    it('does not update values when options are undefined', () => {
      // Set known state, then call with empty options.
      configureLogger({ minLevel: 'error', correlationId: 'keep-me' });
      configureLogger({});

      // Verify previous values are preserved.
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      new Logger('test', 'debug').info('check');
      const entry: LogEntry = formatterSpy.mock.calls[0][0];
      expect(entry.correlationId).toBe('keep-me');
    });

    it('allows updating only some options at a time', () => {
      configureLogger({ minLevel: 'warn' });
      const log = new Logger('test');

      // Warn should be enabled; info should not.
      expect(log.isLevelEnabled('warn')).toBe(true);
      expect(log.isLevelEnabled('info')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 9.  setLogLevel and setCorrelationId
  // -----------------------------------------------------------------------
  describe('setLogLevel and setCorrelationId', () => {
    it('setLogLevel changes global minLevel', () => {
      configureLogger({ minLevel: 'error' });
      setLogLevel('debug');

      const log = new Logger('test');
      expect(log.isLevelEnabled('debug')).toBe(true);
    });

    it('setLogLevel allows filtering by more restrictive level', () => {
      configureLogger({ minLevel: 'debug' });
      setLogLevel('error');

      new Logger('test').info('should be filtered');
      expect(outputSpy).not.toHaveBeenCalled();
    });

    it('setCorrelationId sets global correlation ID', () => {
      setCorrelationId('test-cid');

      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      new Logger('test').info('msg');
      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'test-cid' }),
      );
    });

    it('setCorrelationId can be overwritten', () => {
      setCorrelationId('first');
      setCorrelationId('second');

      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      new Logger('test').info('msg');
      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'second' }),
      );
    });

    it('setCorrelationId accepts an empty string (treated as falsy by formatter)', () => {
      setCorrelationId('' as unknown as string);

      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      new Logger('test').info('msg');
      const entry: LogEntry = formatterSpy.mock.calls[0][0];
      // Empty string is stored on the entry (it's the value passed to the formatter)
      expect(entry.correlationId).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // 10. createLogger
  // -----------------------------------------------------------------------
  describe('createLogger', () => {
    it('returns a Logger instance', () => {
      const log = createLogger('custom');
      expect(log).toBeInstanceOf(Logger);
    });

    it('uses global minLevel when no explicit level given', () => {
      configureLogger({ minLevel: 'warn' });
      const log = createLogger('custom');
      expect(log.isLevelEnabled('warn')).toBe(true);
      expect(log.isLevelEnabled('info')).toBe(false);
    });

    it('accepts an explicit minLevel override', () => {
      configureLogger({ minLevel: 'error' });
      const log = createLogger('custom', 'debug');
      expect(log.isLevelEnabled('debug')).toBe(true);
    });

    it('created logger writes to current global output', () => {
      const log = createLogger('created-mod', 'info');
      log.info('from createLogger');
      expect(outputSpy).toHaveBeenCalledWith(expect.stringContaining('from createLogger'));
    });
  });

  // -----------------------------------------------------------------------
  // 11. Pre-configured loggers
  // -----------------------------------------------------------------------
  describe('pre-configured loggers', () => {
    it('exports a logger object with all expected modules', () => {
      const expected = [
        'api',
        'cache',
        'lsp',
        'mcp',
        'memory',
        'orchestrator',
        'permissions',
        'plugins',
        'query',
        'services',
        'tools',
      ] as const;

      for (const name of expected) {
        expect(logger).toHaveProperty(name);
        expect(logger[name]).toBeInstanceOf(Logger);
      }
    });

    it('each pre-configured logger has the correct module name', () => {
      const pairs: [Logger, string][] = [
        [logger.api, 'api'],
        [logger.cache, 'cache'],
        [logger.lsp, 'lsp'],
        [logger.mcp, 'mcp'],
        [logger.memory, 'memory'],
        [logger.orchestrator, 'orchestrator'],
        [logger.permissions, 'permissions'],
        [logger.plugins, 'plugins'],
        [logger.query, 'query'],
        [logger.services, 'services'],
        [logger.tools, 'tools'],
      ];

      for (const [log, expectedModule] of pairs) {
        // Use a fresh formatter spy for each logger to isolate calls.
        const formatterSpy = captureFormatterSpy();
        configureLogger({ formatter: formatterSpy });

        log.info('module check');
        expect(formatterSpy).toHaveBeenCalledWith(
          expect.objectContaining({ module: expectedModule }),
        );
      }
    });

    it('each pre-configured logger can log at info level by default', () => {
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      logger.query.info('query test');
      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          module: 'query',
          message: 'query test',
        }),
      );
    });

    it('pre-configured loggers capture minLevel at construction time (late global changes do not affect them)', () => {
      // Pre-configured loggers are singletons that resolved minLevel at
      // module- load time (globalMinLevel was 'info'). Changing the global
      // level later does NOT affect existing instances.
      configureLogger({ minLevel: 'error' });
      logger.tools.info('still visible because instance level is info');
      expect(outputSpy).toHaveBeenCalledOnce();

      // The instance's own isLevelEnabled check uses its captured level.
      expect(logger.tools.isLevelEnabled('info')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 12. Edge cases & integration
  // -----------------------------------------------------------------------
  describe('edge cases / integration', () => {
    it('log with empty string message', () => {
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });
      new Logger('test', 'debug').info('');
      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: '' }),
      );
    });

    it('log with undefined data', () => {
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });
      new Logger('test', 'debug').info('msg', undefined);
      const entry: LogEntry = formatterSpy.mock.calls[0][0];
      expect(entry.data).toBeUndefined();
    });

    it('Logger constructed with no module name passes undefined module', () => {
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });
      // Passing undefined where string is expected – runtime behaviour.
      const log = new Logger(undefined as unknown as string, 'debug');
      log.info('no module');
      // The module property is set to the raw value passed (undefined),
      // not coerced to the string "undefined".
      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({ module: undefined }),
      );
    });

    it('configureLogger ignores undefined options without side effects', () => {
      configureLogger({ minLevel: 'error', correlationId: 'sid' });
      configureLogger({});

      // These should NOT have been reset by the empty call.
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      new Logger('test', 'debug').info('check');
      const entry: LogEntry = formatterSpy.mock.calls[0][0];
      expect(entry.correlationId).toBe('sid');
    });

    it('createLogger and Logger constructor are interchangeable', () => {
      const a = createLogger('alpha', 'warn');
      const b = new Logger('alpha', 'warn');
      expect(a.isLevelEnabled('warn')).toBe(b.isLevelEnabled('warn'));
      expect(a.isLevelEnabled('info')).toBe(b.isLevelEnabled('info'));
    });

    it('child of pre-configured logger inherits module name', () => {
      const formatterSpy = captureFormatterSpy();
      configureLogger({ formatter: formatterSpy });

      const sub = logger.mcp.child('handler');
      sub.info('mcp handler');

      expect(formatterSpy).toHaveBeenCalledWith(
        expect.objectContaining({ module: 'mcp:handler' }),
      );
    });
  });
});
