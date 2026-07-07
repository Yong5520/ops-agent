// Circuit breaker for SSH connections.
//
// Tracks consecutive connection/command failures per host. After a threshold
// of consecutive failures, the circuit "trips" and blocks further connection
// attempts for a cooldown period. This prevents the agent loop from wasting
// time (30s timeout per attempt) on hosts that are clearly down.
//
// States:
//   - closed: normal operation, failures are counted
//   - open:   tripped — pool.get() throws immediately without attempting SSH
//   - half-open: cooldown expired — next attempt is allowed; success resets,
//                failure re-trips

import { logger } from '../utils/logger.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failureCount = 0;
  private trippedUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly hostName: string,
    opts?: { threshold?: number; cooldownMs?: number },
  ) {
    this.threshold = opts?.threshold ?? 3;
    this.cooldownMs = opts?.cooldownMs ?? 60_000; // 60 seconds
  }

  // Record a failure. If the threshold is reached, the circuit trips.
  recordFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.trippedUntil = Date.now() + this.cooldownMs;
      logger.warn(
        `[CircuitBreaker] ${this.hostName}: tripped after ${this.failureCount} consecutive failures (cooldown ${this.cooldownMs}ms)`,
      );
    }
  }

  // Record a success — resets the failure count and closes the circuit.
  recordSuccess(): void {
    if (this.failureCount > 0 || this.isOpen()) {
      logger.info(
        `[CircuitBreaker] ${this.hostName}: reset (was ${this.getState()})`,
      );
    }
    this.failureCount = 0;
    this.trippedUntil = 0;
  }

  // Check if the circuit is currently open (blocking).
  isOpen(): boolean {
    if (this.trippedUntil === 0) return false;
    if (Date.now() < this.trippedUntil) return true;
    // Cooldown expired — move to half-open (allow one attempt)
    return false;
  }

  // Get the current state for UI display.
  getState(): CircuitState {
    if (this.trippedUntil === 0) return 'closed';
    if (Date.now() < this.trippedUntil) return 'open';
    return 'half-open';
  }

  // Human-readable reason when blocked.
  getBlockReason(): string | null {
    if (!this.isOpen()) return null;
    const remainingMs = this.trippedUntil - Date.now();
    if (remainingMs <= 0) return null;
    const remainingSec = Math.ceil(remainingMs / 1000);
    return `主机 ${this.hostName} 断路器已触发（连续 ${this.failureCount} 次失败），${remainingSec}s 后重试`;
  }
}
