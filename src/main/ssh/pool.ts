import { EventEmitter } from 'node:events';
import { SSHConnectionManager, OpsAgentError } from './connection.js';
import { CircuitBreaker, type CircuitState } from './circuit-breaker.js';
import { buildSshConfig as buildSshConfigPure } from './build-ssh-config.js';
import { hostsStore } from '../storage/hosts.js';
import { hasActiveTerminal } from './active-terminals.js';
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

  // V3-09: `visited` is threaded through jump-host chains for cycle detection.
  // External callers omit it; openJumpStream passes the accumulating set so an
  // A->B->A bastion chain is caught instead of infinite-recursing.
  async get(hostId: string, visited?: Set<string>): Promise<SSHConnectionManager> {
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

    // V3-09: seed cycle detection with the current host's id (and any visited
    // set threaded from a parent jump chain). External callers pass no visited
    // set, so we start one with this host.
    const visitedSet = visited ?? new Set([host.id]);
    if (!visitedSet.has(host.id)) visitedSet.add(host.id);
    const config = this.buildSshConfig(host, visitedSet);
    const snapshot = JSON.stringify({
      host: host.host,
      port: host.port,
      username: host.username,
      authType: host.authType,
      // password/key presence (not value) determines config drift
      hasPassword: !!host.password,
      hasKey: !!host.keyPath,
      timeoutMs: host.timeoutMs,
      // V3-09: bastion/agentForward/hostKey changes also force reconnect.
      jumpHostId: host.jumpHostId,
      agentForward: host.agentForward,
      hostKeyFingerprint: host.hostKeyFingerprint,
    });

    // V3-09.1/M2: in encoded mode the SSH connection terminates at the BASTION,
    // so host-key verification + TOFU capture target the bastion's record (the
    // target's fingerprint is irrelevant - the client never speaks SSH to the
    // target). In direct/forward mode, verification targets the host itself.
    const keyVerificationHost =
      host.jumpMode === 'encoded' && host.jumpHostId ? hostsStore.get(host.jumpHostId) : host;

    mgr = new SSHConnectionManager(host.id, host.name, config);
    mgr.on('stateChange', (event: ConnectionEvent) => {
      this.emit('stateChange', event);
    });

    // V3-09: TOFU host-key capture. When the verification target host has no
    // recorded fingerprint, the connection's hostVerifier captures the server's
    // real fingerprint and hands it here. Persist via setHostKeyFingerprint
    // (NOT update() - update() merges via get() which strips secrets, and would
    // null the password). In encoded mode this captures the BASTION's key under
    // the bastion's record (keyVerificationHost). Guarded so a persistence
    // failure never breaks the connection.
    if (keyVerificationHost && !keyVerificationHost.hostKeyFingerprint) {
      const kvHost = keyVerificationHost;
      mgr.onHostKey = (fingerprint: string) => {
        try {
          hostsStore.setHostKeyFingerprint(kvHost.id, fingerprint);
          logger.info(`[Pool] Recorded host-key fingerprint for ${kvHost.name}: ${fingerprint}`);
        } catch (err) {
          logger.warn(
            `[Pool] Failed to persist host-key fingerprint for ${kvHost.name}: ${(err as Error).message}`,
          );
        }
      };
    }

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

    const config = this.buildSshConfig(host, new Set([host.id]));
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

  // Build an SshClientConfig from a decrypted HostConfig. Delegates to the pure
  // buildSshConfig (testable). Two jump modes:
  //  - 'encoded' (V3-09.1): resolve the bastion host record and pass it in;
  //    buildSshConfig connects straight to the bastion with an encoded username
  //    (no forwardOut). Used for bastions that disable TCP forwarding.
  //  - 'forward' (default, V3-09): inject getJumpStream (openJumpStream +
  //    forwardOut) with cycle detection via `visited`.
  private buildSshConfig(host: HostConfig, visited: Set<string>): SshClientConfig {
    if (host.jumpMode === 'encoded' && host.jumpHostId) {
      // Resolve the bastion WITH secrets (need its password/key to authenticate
      // the single connection to the bastion). The bastion is connected to
      // directly; no recursion / no forwardOut.
      const bastion = hostsStore.getWithSecrets(host.jumpHostId);
      if (!bastion) {
        throw new OpsAgentError(
          `Host "${host.name}" uses encoded jump mode but its bastion ` +
            `(jumpHostId=${host.jumpHostId}) was not found. It may have been deleted.`,
          'SSH_ERROR',
        );
      }
      logger.info(
        `[Pool] Connecting to ${host.name} via encoded bastion ${bastion.name} ` +
          `(${bastion.host}:${bastion.port})`,
      );
      return buildSshConfigPure(host, { bastion });
    }
    const getJumpStream = host.jumpHostId
      ? () => this.openJumpStream(host, host.jumpHostId!, visited)
      : undefined;
    if (host.jumpHostId) {
      logger.info(`[Pool] Connecting to ${host.name} via forward bastion (forwardOut)`);
    } else {
      logger.info(`[Pool] Connecting to ${host.name} (direct)`);
    }
    return buildSshConfigPure(host, { getJumpStream });
  }

  // V3-09: open a cascaded stream from a jump host to the target's host:port.
  // Recursively connects to the jump host via pool.get (which itself may chain
  // through another jump), then uses ssh2 forwardOut to tunnel TCP to the
  // target. Cycle detection: add jumpHostId to `visited` BEFORE recursing so an
  // A->B->A chain is caught (the recursive get()->buildSshConfig sees the
  // growing set). Depth cap = 5.
  private async openJumpStream(
    target: HostConfig,
    jumpHostId: string,
    visited: Set<string>,
  ): Promise<unknown> {
    if (visited.has(jumpHostId)) {
      throw new OpsAgentError(
        `Jump-host cycle detected: host ${target.name} -> ${jumpHostId} (already visited). ` +
          'Circular bastion chains are not allowed.',
        'SSH_ERROR',
      );
    }
    if (visited.size >= 5) {
      throw new OpsAgentError(
        `Jump-host chain too deep (>=5) for host ${target.name}. Max chain depth is 5.`,
        'SSH_ERROR',
      );
    }
    // Add this hop BEFORE recursing so the jump host's own get() (and any
    // further jump it triggers) sees it in the set.
    visited.add(jumpHostId);
    const jumpMgr = await this.get(jumpHostId, visited);
    const conn = jumpMgr.getConnection();
    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new OpsAgentError(
            `[${target.name}] Jump-host stream to ${target.host}:${target.port} timed out`,
            'SSH_TIMEOUT',
          ),
        );
      }, 15_000);
      conn.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
        clearTimeout(timeoutId);
        if (err) {
          reject(
            new OpsAgentError(
              `Jump-host forwardOut to ${target.host}:${target.port} failed: ${err.message}`,
              'SSH_ERROR',
            ),
          );
          return;
        }
        resolve(stream);
      });
    });
  }

  // Force-close and reopen a specific host's connection (e.g., after config edit).
  // Also resets the circuit breaker so the user can retry immediately.
  // Used by exec failure handler to invalidate zombie connections.
  invalidate(hostId: string): void {
    const mgr = this.pool.get(hostId);
    if (mgr) {
      logger.info(`[Pool] Invalidating connection for host ${mgr.hostName}`);
      mgr.forceClose();
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

  // Mark a host as active (reset idle timer). Called during long-running
  // operations like SFTP transfers to prevent the idle checker from closing
  // the connection mid-transfer.
  markActive(hostId: string): void {
    if (this.pool.has(hostId)) {
      this.lastActivity.set(hostId, Date.now());
    }
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
        // Skip hosts with active interactive terminals - the shell stream
        // itself keeps the connection "in use" regardless of command input.
        if (hasActiveTerminal(hostId)) {
          this.lastActivity.set(hostId, now);
          continue;
        }
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
