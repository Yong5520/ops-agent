import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { SSHConnectionManager, OpsAgentError } from './connection.js';
import { CircuitBreaker, type CircuitState } from './circuit-breaker.js';
import { hostsStore } from '../storage/hosts.js';
import { logger } from '../utils/logger.js';
import type { HostConfig } from '../../shared/types.js';
import type { SshClientConfig, ConnectionEvent } from './types.js';

// ConnectionPool manages SSH connections for all configured hosts.
// Extracted from ssh-mcp-multi ConnectionPool (lines 453-490) with:
//   - Host config sourced from SQLite (via hostsStore) instead of YAML
//   - EventEmitter for connection state changes (M3-05)
//   - Decrypted credentials pulled on demand via getWithSecrets()
//   - Lazy connection: only connects when a command is executed
//   - Circuit breaker per host (trips after 3 consecutive failures)

export interface HostStatus {
  hostId: string;
  hostName: string;
  state: string;
  circuit: CircuitState;
  circuitReason?: string;
}

export class ConnectionPool extends EventEmitter {
  private pool = new Map<string, SSHConnectionManager>();
  // Track the last config snapshot per host so we can detect drift
  // (e.g., user edited the host after a connection was established).
  private configSnapshot = new Map<string, string>();
  // Track last activity time per host for idle timeout
  private lastActivity = new Map<string, number>();
  // Circuit breakers per host
  private breakers = new Map<string, CircuitBreaker>();
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs = 10 * 60 * 1000; // 10 minutes

  // Get or create the circuit breaker for a host.
  private getBreaker(hostId: string, hostName: string): CircuitBreaker {
    let breaker = this.breakers.get(hostId);
    if (!breaker) {
      breaker = new CircuitBreaker(hostName);
      this.breakers.set(hostId, breaker);
    }
    return breaker;
  }

  async get(hostId: string): Promise<SSHConnectionManager> {
    let mgr = this.pool.get(hostId);
    if (mgr && mgr.isConnected()) {
      this.lastActivity.set(hostId, Date.now());
      return mgr;
    }

    // Check circuit breaker before attempting a new connection.
    // If open, fail immediately instead of waiting for a 30s SSH timeout.
    const hostName = hostsStore.get(hostId)?.name ?? hostId;
    const breaker = this.getBreaker(hostId, hostName);
    if (breaker.isOpen()) {
      const reason = breaker.getBlockReason();
      logger.warn(`[Pool] Circuit open for ${hostName}: ${reason}`);
      throw new OpsAgentError(reason ?? `主机 ${hostName} 断路器已触发`, 'SSH_NOT_CONNECTED');
    }

    // Reconnect or create new — discard stale manager
    if (mgr) {
      mgr.close();
      this.pool.delete(hostId);
    }

    const host = hostsStore.getWithSecrets(hostId);
    if (!host) {
      throw new Error(
        `Unknown host id "${hostId}". Available: ${hostsStore
          .list()
          .map((h) => h.name)
          .join(', ')}`,
      );
    }

    const config = this.buildSshConfig(host);
    const snapshot = JSON.stringify({
      host: host.host,
      port: host.port,
      username: host.username,
      authType: host.authType,
      // password/key presence (not value) determines config drift
      hasPassword: !!host.password,
      hasKey: !!host.keyPath,
      timeoutMs: host.timeoutMs,
    });

    mgr = new SSHConnectionManager(host.id, host.name, config);
    mgr.on('stateChange', (event: ConnectionEvent) => {
      this.emit('stateChange', event);
    });

    try {
      await mgr.connect();
      breaker.recordSuccess();
      this.pool.set(hostId, mgr);
      this.configSnapshot.set(hostId, snapshot);
      this.lastActivity.set(hostId, Date.now());
      this.ensureIdleCheck();
      return mgr;
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  // Test connectivity to a host without keeping the connection.
  // Used by the Settings UI "Test connection" button.
  // Returns latency in ms on success, or throws on failure.
  async testConnection(hostId: string): Promise<{ latencyMs: number }> {
    const host = hostsStore.getWithSecrets(hostId);
    if (!host) {
      throw new Error(`Unknown host id "${hostId}"`);
    }

    // Check circuit breaker
    const breaker = this.getBreaker(hostId, host.name);
    if (breaker.isOpen()) {
      throw new Error(breaker.getBlockReason() ?? `主机 ${host.name} 断路器已触发`);
    }

    const config = this.buildSshConfig(host);
    // Use a short timeout for the test — don't make the user wait 60s.
    const testConfig = { ...config, timeoutMs: Math.min(config.timeoutMs, 10_000) };
    const testMgr = new SSHConnectionManager(host.id, host.name, testConfig);

    const start = Date.now();
    try {
      await testMgr.connect();
      const latencyMs = Date.now() - start;
      // Close immediately — this was just a probe.
      testMgr.close();
      breaker.recordSuccess();
      return { latencyMs };
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  // Build an SshClientConfig from a decrypted HostConfig.
  private buildSshConfig(host: HostConfig): SshClientConfig {
    const config: SshClientConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      timeoutMs: host.timeoutMs,
    };
    if (host.authType === 'password' && host.password) {
      config.password = host.password;
    } else if (host.authType === 'key' && host.keyPath) {
      try {
        config.privateKey = readFileSync(host.keyPath, 'utf8');
      } catch (err) {
        throw new Error(`Failed to read SSH key at ${host.keyPath}: ${(err as Error).message}`);
      }
    }
    if (host.sudoPassword) config.sudoPassword = host.sudoPassword;
    if (host.suPassword) config.suPassword = host.suPassword;
    return config;
  }

  // Force-close and reopen a specific host's connection (e.g., after config edit).
  // Also resets the circuit breaker so the user can retry immediately.
  invalidate(hostId: string): void {
    const mgr = this.pool.get(hostId);
    if (mgr) {
      mgr.close();
      this.pool.delete(hostId);
      this.configSnapshot.delete(hostId);
    }
    const breaker = this.breakers.get(hostId);
    if (breaker) {
      breaker.recordSuccess();
    }
  }

  // Return cached manager without connecting. Useful for status display.
  peek(hostId: string): SSHConnectionManager | undefined {
    return this.pool.get(hostId);
  }

  // Snapshot of all known hosts' connection + circuit state for UI rendering.
  listStatus(): HostStatus[] {
    return hostsStore.list().map((host) => {
      const mgr = this.pool.get(host.id);
      const breaker = this.breakers.get(host.id);
      const circuit = breaker?.getState() ?? 'closed';
      const circuitReason = breaker?.getBlockReason() ?? undefined;
      return {
        hostId: host.id,
        hostName: host.name,
        state: mgr?.getState() ?? 'disconnected',
        circuit,
        circuitReason,
      };
    });
  }

  closeAll(): void {
    for (const mgr of this.pool.values()) mgr.close();
    this.pool.clear();
    this.configSnapshot.clear();
    this.lastActivity.clear();
    this.breakers.clear();
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
    logger.info('All SSH connections closed');
  }

  // Start a periodic check that closes idle connections. Called once on
  // first connection; runs every 60 seconds afterwards.
  private ensureIdleCheck(): void {
    if (this.idleCheckInterval) return;
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [hostId, lastTime] of this.lastActivity.entries()) {
        if (now - lastTime > this.idleTimeoutMs) {
          const mgr = this.pool.get(hostId);
          if (mgr) {
            logger.info(
              `[Pool] Closing idle connection to ${hostId} (${Math.round((now - lastTime) / 1000)}s idle)`,
            );
            mgr.close();
            this.pool.delete(hostId);
          }
          this.lastActivity.delete(hostId);
        }
      }
    }, 60_000);
  }
}

// Singleton pool for the app lifetime.
export const connectionPool = new ConnectionPool();
