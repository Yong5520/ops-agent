// Unit tests for SerialConnectionPool. hostsStore is mocked; the pool creates
// managers via an injectable factory so no real port is opened.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  hosts: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../storage/hosts.js', () => ({
  hostsStore: {
    getWithSecrets: (id: string) => state.hosts.get(id) ?? null,
    get: (id: string) => state.hosts.get(id) ?? null,
  },
}));

import { SerialConnectionPool } from '../serial-pool.js';
import type { HostConfig } from '../../../shared/types.js';
import type { SerialConnectionManager } from '../serial-connection.js';

function serialHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'h1',
    name: 'switch-init',
    host: 'COM3',
    port: 22,
    username: '',
    authType: 'password',
    groupName: 'default',
    timeoutMs: 10_000,
    agentForward: false,
    deviceType: 'generic',
    connectionType: 'serial',
    serialPort: 'COM3',
    baudRate: 9600,
    loginRequired: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

function fakeManager(id: string): SerialConnectionManager {
  return {
    id,
    isConnected: () => true,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as SerialConnectionManager;
}

describe('SerialConnectionPool', () => {
  let created: HostConfig[];

  beforeEach(() => {
    state.hosts.clear();
    created = [];
  });

  function makePool(): SerialConnectionPool {
    return new SerialConnectionPool({
      createManager: (host) => {
        created.push(host);
        return fakeManager(host.id);
      },
    });
  }

  it('rejects an unknown host', async () => {
    const pool = makePool();
    await expect(pool.get('missing')).rejects.toThrow(/未知|unknown/i);
  });

  it('rejects a non-serial host', async () => {
    state.hosts.set('h1', serialHost({ connectionType: 'ssh', serialPort: undefined }));
    const pool = makePool();
    await expect(pool.get('h1')).rejects.toThrow(/串口|serial/i);
  });

  it('creates and caches one manager per host', async () => {
    state.hosts.set('h1', serialHost());
    const pool = makePool();
    const m1 = await pool.get('h1');
    const m2 = await pool.get('h1');
    expect(m1).toBe(m2);
    expect(created).toHaveLength(1);
  });

  it('recreates the manager when the serial config changes (drift)', async () => {
    state.hosts.set('h1', serialHost());
    const pool = makePool();
    const m1 = await pool.get('h1');
    state.hosts.set('h1', serialHost({ baudRate: 115200 }));
    const m2 = await pool.get('h1');
    expect(m2).not.toBe(m1);
    expect(m1.close).toHaveBeenCalled();
    expect(created).toHaveLength(2);
  });

  it('recreates the manager when the existing one is disconnected', async () => {
    state.hosts.set('h1', serialHost());
    const createdMgrs: SerialConnectionManager[] = [];
    const pool = new SerialConnectionPool({
      createManager: () => {
        const mgr = fakeManager('h1');
        createdMgrs.push(mgr);
        return mgr;
      },
    });
    const m1 = await pool.get('h1');
    // Simulate the port going away.
    (m1 as unknown as { isConnected: () => boolean }).isConnected = () => false;
    const m2 = await pool.get('h1');
    expect(m2).not.toBe(m1);
    expect(createdMgrs).toHaveLength(2);
  });

  it('invalidate() closes and forgets the manager', async () => {
    state.hosts.set('h1', serialHost());
    const pool = makePool();
    const m1 = await pool.get('h1');
    pool.invalidate('h1');
    expect(m1.close).toHaveBeenCalled();
    const m2 = await pool.get('h1');
    expect(m2).not.toBe(m1);
  });
});
