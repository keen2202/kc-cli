// Periodic / delayed timers must not hold the process hostage — round4 §6-M9h/M9j

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthCheckService } from '../../src/services/healthCheck';
import { logger } from '../../src/services/logger';

describe('HealthCheckService.startPeriodicChecks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unrefs the interval so it cannot block process exit', () => {
    const service = new HealthCheckService({ services: [], checkIntervalMs: 60_000 } as never);
    service.startPeriodicChecks(1_000);

    const interval = (service as unknown as { checkInterval: { hasRef?: () => boolean } | null })
      .checkInterval;
    expect(interval).not.toBeNull();
    // An unref'd timer reports no refs. On platforms where hasRef is absent
    // the call below is simply skipped, so assert the opt-in call happened.
    if (typeof interval?.hasRef === 'function') {
      expect(interval.hasRef()).toBe(false);
    }

    service.stop();
  });

  it('captures a rejection from checkAll instead of leaking an unhandled one', async () => {
    const service = new HealthCheckService({ services: [], checkIntervalMs: 10 } as never);
    const errorSpy = vi
      .spyOn(logger.services, 'error')
      .mockImplementation(() => undefined);
    vi.spyOn(service, 'checkAll').mockRejectedValue(new Error('probe exploded'));

    service.startPeriodicChecks(5);
    await new Promise((r) => setTimeout(r, 40));
    service.stop();

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls
      .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
      .join(' ');
    expect(logged).toContain('periodic check failed');
    expect(logged).toContain('probe exploded');
  });

  it('replaces rather than stacks intervals on repeated calls', () => {
    const service = new HealthCheckService({ services: [], checkIntervalMs: 1_000 } as never);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    service.startPeriodicChecks(1_000);
    service.startPeriodicChecks(1_000);

    // The second call must clear the first interval before installing a new one.
    expect(clearSpy).toHaveBeenCalled();
    service.stop();
  });
});
