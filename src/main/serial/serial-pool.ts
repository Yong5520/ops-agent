// SerialConnectionPool - caches one SerialConnectionManager per serial host.
//
// A serial port cannot be opened twice, so the terminal and AI exec MUST share
// a single manager per host; this pool is that single source. Mirrors the SSH
// ConnectionPool's essentials (config-drift detection, invalidate) but without
// circuit breaking / jump chains, which don't apply to a local COM port.
//
// Managers are created via an injectable factory (tests inject fakes; the
// default constructs a real SerialConnectionManager).

import { SerialConnectionManager } from './serial-connection.js';
import { hostsStore } from '../storage/hosts.js';
import type { HostConfig } from '../../shared/types.js';
import { logger } from '../utils/logger.js';

export type SerialManagerFactory = (host: HostConfig) => SerialConnectionManager;

export interface SerialPoolOptions {
  createManager?: SerialManagerFactory;
  /** Idle sweep interval for closing unused ports. Default 60s. */
  sweepIntervalMs?: number;
  /** Close a port after this much inactivity. Default 10 minutes. */
  idleTimeoutMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export class SerialConnectionPool {
  private managers = new Map<string, SerialConnectionManager>();
  private snapshots = new Map<string, string>();
  private lastActivity = new Map<string, number>();
  private readonly createManager: SerialManagerFactory;
  private readonly sweepIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(opts: SerialPoolOptions = {}) {
    this.createManager =
      opts.createManager ?? ((host) => new SerialConnectionManager(host));
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /** Config snapshot for drift detection: any serial-relevant change forces a
   * reconnect (close + reopen with the new settings). */
  private snapshotOf(host: HostConfig): string {
    return JSON.stringify({
      serialPort: host.serialPort,
      baudRate: host.baudRate,
      dataBits: host.dataBits,
      stopBits: host.stopBits,
      parity: host.parity,
      flowControl: host.flowControl,
      loginRequired: host.loginRequired,
      username: host.username,
      // password presence (not value) - a rotated password changes behavior
      hasPassword: !!host.password,
      timeoutMs: host.timeoutMs,
    });
  }

  /**
   * Get (or create) the shared manager for a serial host. Rejects for unknown
   * hosts and hosts not configured as serial connections.
   */
  async get(hostId: string): Promise<SerialConnectionManager> {
    const host = hostsStore.getWithSecrets(hostId);
    if (!host) {
      throw new Error(`未知主机: ${hostId}`);
    }
    if (host.connectionType !== 'serial') {
      throw new Error(`主机 ${host.name} 不是串口连接（connectionType=${host.connectionType ?? 'ssh'}）`);
    }
    const snapshot = this.snapshotOf(host);
    const existing = this.managers.get(hostId);
    if (existing && existing.isConnected() && this.snapshots.get(hostId) === snapshot) {
      this.lastActivity.set(hostId, Date.now());
      return existing;
    }
    // Stale or disconnected: close and recreate with the current config.
    if (existing) {
      existing.close();
      this.managers.delete(hostId);
    }
    const mgr = this.createManager(host);
    this.managers.set(hostId, mgr);
    this.snapshots.set(hostId, snapshot);
    this.lastActivity.set(hostId, Date.now());
    this.ensureSweep();
    await mgr.connect();
    return mgr;
  }

  /** Close and forget the manager for a host (config deleted / user request). */
  invalidate(hostId: string): void {
    const mgr = this.managers.get(hostId);
    if (mgr) {
      mgr.close();
      this.managers.delete(hostId);
    }
    this.snapshots.delete(hostId);
    this.lastActivity.delete(hostId);
  }

  /** Mark a host as active without connecting (e.g. a terminal is attached). */
  touch(hostId: string): void {
    this.lastActivity.set(hostId, Date.now());
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
    // Don't keep the process alive just for the sweeper.
    this.sweepTimer.unref?.();
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [hostId, last] of this.lastActivity) {
      if (now - last < this.idleTimeoutMs) continue;
      const mgr = this.managers.get(hostId);
      logger.info(`[SerialPool] Idle timeout for ${mgr?.hostName ?? hostId}, closing port`);
      this.invalidate(hostId);
    }
  }

  /** Close everything (app shutdown). */
  closeAll(): void {
    for (const [hostId, mgr] of this.managers) {
      try {
        mgr.close();
      } catch {
        // ignore
      }
      this.managers.delete(hostId);
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

/** Process-wide shared pool: one port per serial host across terminal + AI. */
export const serialPool = new SerialConnectionPool();
