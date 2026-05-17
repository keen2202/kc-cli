// Auto-Reconnect Service - automatic reconnection for LSP and MCP services

export interface ReconnectConfig {
  /** Maximum number of reconnection attempts */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff */
  baseDelayMs: number;
  /** Maximum delay in ms (cap for exponential backoff) */
  maxDelayMs: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
}

const DEFAULT_CONFIG: ReconnectConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

export type ReconnectState = 'idle' | 'reconnecting' | 'connected' | 'failed';

export interface ReconnectStatus {
  service: string;
  state: ReconnectState;
  attempt: number;
  maxAttempts: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  error?: string;
}

type ConnectFn = () => Promise<boolean>;

/**
 * Auto-reconnect service with exponential backoff
 */
export class AutoReconnectService {
  private config: ReconnectConfig;
  private statuses = new Map<string, ReconnectStatus>();
  private connectFunctions = new Map<string, ConnectFn>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: Partial<ReconnectConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a connection function for a service
   */
  registerService(service: string, connectFn: ConnectFn): void {
    this.connectFunctions.set(service, connectFn);
    this.statuses.set(service, {
      service,
      state: 'idle',
      attempt: 0,
      maxAttempts: this.config.maxAttempts,
      lastAttemptAt: 0,
      nextAttemptAt: 0,
    });
  }

  /**
   * Attempt to reconnect to a service
   * Returns true if reconnection succeeded
   */
  async reconnect(service: string): Promise<boolean> {
    const connectFn = this.connectFunctions.get(service);
    if (!connectFn) {
      throw new Error(`No connection function registered for service: ${service}`);
    }

    const status = this.statuses.get(service)!;
    status.state = 'reconnecting';
    status.attempt = 0;

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      status.attempt = attempt + 1;
      status.lastAttemptAt = Date.now();

      try {
        const success = await connectFn();

        if (success) {
          status.state = 'connected';
          status.error = undefined;
          return true;
        }
      } catch (error) {
        status.error = error instanceof Error ? error.message : String(error);
      }

      // Calculate delay with exponential backoff
      if (attempt < this.config.maxAttempts - 1) {
        const delay = Math.min(
          this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt),
          this.config.maxDelayMs
        );
        status.nextAttemptAt = Date.now() + delay;

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    status.state = 'failed';
    return false;
  }

  /**
   * Schedule a reconnection attempt in the background
   */
  scheduleReconnect(service: string): void {
    // Cancel any existing timer
    this.cancelReconnect(service);

    const timer = setTimeout(async () => {
      await this.reconnect(service);
      this.reconnectTimers.delete(service);
    }, 0);

    this.reconnectTimers.set(service, timer);
  }

  /**
   * Cancel a scheduled reconnection
   */
  cancelReconnect(service: string): void {
    const timer = this.reconnectTimers.get(service);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(service);
    }
  }

  /**
   * Get reconnect status for a service
   */
  getStatus(service: string): ReconnectStatus | null {
    return this.statuses.get(service) || null;
  }

  /**
   * Get all service statuses
   */
  getAllStatuses(): ReconnectStatus[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Mark a service as connected (e.g., after successful initial connection)
   */
  markConnected(service: string): void {
    const status = this.statuses.get(service);
    if (status) {
      status.state = 'connected';
      status.attempt = 0;
      status.error = undefined;
    }
  }

  /**
   * Mark a service as disconnected (triggers reconnect on next check)
   */
  markDisconnected(service: string, error?: string): void {
    const status = this.statuses.get(service);
    if (status) {
      status.state = 'idle';
      status.error = error;
    }
  }

  /**
   * Check if a service needs reconnection
   */
  needsReconnect(service: string): boolean {
    const status = this.statuses.get(service);
    return status ? status.state === 'idle' || status.state === 'failed' : false;
  }

  /**
   * Reset all reconnect state
   */
  reset(): void {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.statuses.clear();
    this.connectFunctions.clear();
  }
}
