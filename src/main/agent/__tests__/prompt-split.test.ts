import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies that access DB or filesystem.
vi.mock('../../storage/hosts.js', () => ({
  hostsStore: {
    get: vi.fn(() => null),
    list: vi.fn(() => []),
  },
}));

vi.mock('../skills/index.js', () => ({
  getEnabledSkills: vi.fn(() => []),
}));

vi.mock('../memory/claudemd.js', () => ({
  buildMemoryPromptSection: vi.fn(() => ''),
}));

vi.mock('../memory/automem.js', () => ({
  loadAutoMemory: vi.fn(() => ''),
}));

import { buildSystemPrompt } from '../system-prompt.js';
import { hostsStore } from '../../storage/hosts.js';
import type { HostFacts } from '../facts.js';
import type { HostConfig } from '../../../shared/types.js';

// Factory for test HostFacts
function makeFacts(overrides: Partial<HostFacts> = {}): HostFacts {
  return {
    hostId: 'host-1',
    hostName: 'test-host',
    os: 'Ubuntu 22.04 LTS',
    kernel: '5.15.0-91-generic',
    cpuCores: '8',
    memoryTotal: 'Mem: 16G',
    diskInfo: '/dev/sda1 100G 50G 50G 50% /',
    failedUnits: [],
    recentDmesg: [],
    cachedAt: Date.now(),
    ...overrides,
  };
}

// Factory for test host configs
function makeHost(id: string, name: string): HostConfig {
  return {
    id,
    name,
    host: '192.168.1.1',
    port: 22,
    username: 'root',
    authType: 'password' as const,
    groupName: 'default',
    timeoutMs: 120000,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('buildSystemPrompt - prompt split', () => {
  beforeEach(() => {
    vi.mocked(hostsStore.get).mockReturnValue(null);
    vi.mocked(hostsStore.list).mockReturnValue([]);
  });

  describe('return type', () => {
    it('returns an object with staticPrefix and dynamicSuffix strings', () => {
      const result = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(result).toHaveProperty('staticPrefix');
      expect(result).toHaveProperty('dynamicSuffix');
      expect(typeof result.staticPrefix).toBe('string');
      expect(typeof result.dynamicSuffix).toBe('string');
    });
  });

  describe('static prefix content', () => {
    it('contains Role definition', () => {
      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(staticPrefix).toContain('OpsAgent');
      expect(staticPrefix).toContain('运维助手');
    });

    it('contains Security rules', () => {
      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(staticPrefix).toContain('安全规则');
      expect(staticPrefix).toContain('不可绕过');
    });

    it('contains Operating guidelines', () => {
      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(staticPrefix).toContain('操作规范');
      expect(staticPrefix).toContain('先诊断后操作');
    });

    it('contains stable host facts (OS/kernel/CPU/mem) when hostFacts provided', () => {
      const facts = makeFacts();
      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: ['host-1'],
        safetyMode: 'operator',
        hostFacts: [facts],
      });
      expect(staticPrefix).toContain('Ubuntu 22.04 LTS');
      expect(staticPrefix).toContain('5.15.0-91-generic');
      expect(staticPrefix).toContain('8');
      expect(staticPrefix).toContain('Mem: 16G');
    });

    it('does NOT contain dynamic facts (disk/failed/dmesg) in static prefix', () => {
      const facts = makeFacts({
        diskInfo: '/dev/sda1 100G 50G 50G 50% /',
        failedUnits: ['nginx.service'],
        recentDmesg: ['[ 1.234] CPU stall'],
      });
      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: ['host-1'],
        safetyMode: 'operator',
        hostFacts: [facts],
      });
      // Disk info should NOT be in the static prefix
      expect(staticPrefix).not.toContain('/dev/sda1 100G 50G 50G 50% /');
      // Failed units should NOT be in the static prefix
      expect(staticPrefix).not.toContain('nginx.service');
      // Dmesg errors should NOT be in the static prefix
      expect(staticPrefix).not.toContain('CPU stall');
    });
  });

  describe('dynamic suffix content', () => {
    it('contains Safety mode', () => {
      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'sentinel',
      });
      expect(dynamicSuffix).toContain('当前安全模式');
      expect(dynamicSuffix).toContain('Sentinel');
    });

    it('contains Safety mode for operator', () => {
      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(dynamicSuffix).toContain('Operator');
    });

    it('contains dynamic facts (disk/failed/dmesg) when hostFacts provided', () => {
      const facts = makeFacts({
        diskInfo: '/dev/sda1 100G 50G 50G 50% /',
        failedUnits: ['nginx.service', 'mysql.service'],
        recentDmesg: ['[ 1.234] CPU stall', '[ 2.345] I/O error'],
      });
      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: ['host-1'],
        safetyMode: 'operator',
        hostFacts: [facts],
      });
      expect(dynamicSuffix).toContain('/dev/sda1 100G 50G 50G 50% /');
      expect(dynamicSuffix).toContain('nginx.service');
      expect(dynamicSuffix).toContain('mysql.service');
      expect(dynamicSuffix).toContain('CPU stall');
      expect(dynamicSuffix).toContain('I/O error');
    });

    it('does NOT contain stable facts in dynamic suffix', () => {
      const facts = makeFacts();
      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: ['host-1'],
        safetyMode: 'operator',
        hostFacts: [facts],
      });
      // OS/kernel/CPU/mem should NOT be in the dynamic suffix
      expect(dynamicSuffix).not.toContain('Ubuntu 22.04 LTS');
      expect(dynamicSuffix).not.toContain('5.15.0-91-generic');
    });

    it('does NOT contain Role/Security rules/Operating guidelines', () => {
      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(dynamicSuffix).not.toContain('OpsAgent');
      expect(dynamicSuffix).not.toContain('安全规则');
      expect(dynamicSuffix).not.toContain('操作规范');
    });
  });

  describe('no hostFacts', () => {
    it('dynamic suffix contains only safety mode when no facts provided', () => {
      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(dynamicSuffix).toContain('当前安全模式');
      // Should NOT contain any runtime state section
      expect(dynamicSuffix).not.toContain('主机运行时状态');
    });

    it('static prefix does not contain host facts section when no facts', () => {
      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'operator',
      });
      expect(staticPrefix).not.toContain('主机基础信息');
    });
  });

  describe('cross-call stability (cache-friendliness)', () => {
    it('produces identical staticPrefix for same selectedHostIds + safetyMode', () => {
      vi.mocked(hostsStore.get).mockReturnValue(makeHost('h1', 'host-a'));
      vi.mocked(hostsStore.list).mockReturnValue([makeHost('h1', 'host-a')]);

      const facts1 = makeFacts({
        diskInfo: '/dev/sda1 50G 25G 25G 50% /',
        failedUnits: ['nginx.service'],
        recentDmesg: ['[ 1.0] error A'],
      });

      const facts2 = makeFacts({
        // Dynamic fields changed - should NOT affect static prefix
        diskInfo: '/dev/sda1 50G 40G 10G 80% /',
        failedUnits: ['mysql.service', 'redis.service'],
        recentDmesg: ['[ 2.0] error B', '[ 3.0] error C'],
      });

      const r1 = buildSystemPrompt({
        selectedHostIds: ['h1'],
        safetyMode: 'operator',
        hostFacts: [facts1],
      });
      const r2 = buildSystemPrompt({
        selectedHostIds: ['h1'],
        safetyMode: 'operator',
        hostFacts: [facts2],
      });

      expect(r1.staticPrefix).toBe(r2.staticPrefix);
    });

    it('produces different dynamicSuffix when dynamic facts change', () => {
      vi.mocked(hostsStore.get).mockReturnValue(makeHost('h1', 'host-a'));
      vi.mocked(hostsStore.list).mockReturnValue([makeHost('h1', 'host-a')]);

      const facts1 = makeFacts({ diskInfo: 'disk-A' });
      const facts2 = makeFacts({ diskInfo: 'disk-B' });

      const r1 = buildSystemPrompt({
        selectedHostIds: ['h1'],
        safetyMode: 'operator',
        hostFacts: [facts1],
      });
      const r2 = buildSystemPrompt({
        selectedHostIds: ['h1'],
        safetyMode: 'operator',
        hostFacts: [facts2],
      });

      expect(r1.dynamicSuffix).not.toBe(r2.dynamicSuffix);
    });

    it('produces different staticPrefix when safetyMode changes (safetyMode is dynamic, but it does not affect staticPrefix)', () => {
      // safetyMode is in dynamicSuffix, so staticPrefix should be the same
      // regardless of safetyMode
      const r1 = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'sentinel',
      });
      const r2 = buildSystemPrompt({
        selectedHostIds: [],
        safetyMode: 'autopilot',
      });

      expect(r1.staticPrefix).toBe(r2.staticPrefix);
    });
  });

  describe('multiple hosts', () => {
    it('includes all hosts in static prefix stable facts', () => {
      vi.mocked(hostsStore.get).mockImplementation((id: string) =>
        id === 'h1' ? makeHost('h1', 'host-a') : makeHost('h2', 'host-b'),
      );
      vi.mocked(hostsStore.list).mockReturnValue([
        makeHost('h1', 'host-a'),
        makeHost('h2', 'host-b'),
      ]);

      const facts1 = makeFacts({
        hostId: 'h1',
        hostName: 'host-a',
        os: 'CentOS 7',
      });
      const facts2 = makeFacts({
        hostId: 'h2',
        hostName: 'host-b',
        os: 'Debian 12',
      });

      const { staticPrefix } = buildSystemPrompt({
        selectedHostIds: ['h1', 'h2'],
        safetyMode: 'operator',
        hostFacts: [facts1, facts2],
      });

      expect(staticPrefix).toContain('CentOS 7');
      expect(staticPrefix).toContain('Debian 12');
    });

    it('includes all hosts in dynamic suffix dynamic facts', () => {
      vi.mocked(hostsStore.get).mockImplementation((id: string) =>
        id === 'h1' ? makeHost('h1', 'host-a') : makeHost('h2', 'host-b'),
      );
      vi.mocked(hostsStore.list).mockReturnValue([
        makeHost('h1', 'host-a'),
        makeHost('h2', 'host-b'),
      ]);

      const facts1 = makeFacts({
        hostId: 'h1',
        hostName: 'host-a',
        diskInfo: 'disk-A-90%',
        failedUnits: ['svc-a'],
      });
      const facts2 = makeFacts({
        hostId: 'h2',
        hostName: 'host-b',
        diskInfo: 'disk-B-30%',
        failedUnits: [],
      });

      const { dynamicSuffix } = buildSystemPrompt({
        selectedHostIds: ['h1', 'h2'],
        safetyMode: 'operator',
        hostFacts: [facts1, facts2],
      });

      expect(dynamicSuffix).toContain('disk-A-90%');
      expect(dynamicSuffix).toContain('disk-B-30%');
      expect(dynamicSuffix).toContain('svc-a');
    });
  });
});
