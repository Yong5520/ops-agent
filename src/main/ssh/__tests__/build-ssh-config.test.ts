// Unit tests for buildSshConfig (V3-09 Cycle B).
//
// buildSshConfig turns a decrypted HostConfig into an SshClientConfig for
// ssh2.Client.connect(). V3-09 adds passthrough of agentForward /
// hostKeyFingerprint, and a getJumpStream callback when the host uses a
// jump/bastion host (the actual stream creation happens in connection.ts at
// connect time - buildSshConfig just wires the callback so the pool can inject
// the recursive jump connection). Pure function (the key file read is stubbed
// via a passed-in reader) so it unit-tests directly.
import { describe, it, expect, vi } from 'vitest';
import { buildSshConfig } from '../build-ssh-config.js';
import type { HostConfig } from '../../../shared/types.js';

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'h1',
    name: 'web-1',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'secret',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('buildSshConfig', () => {
  it('builds a basic config from a password-auth host', () => {
    const cfg = buildSshConfig(makeHost());
    expect(cfg.host).toBe('10.0.0.1');
    expect(cfg.port).toBe(22);
    expect(cfg.username).toBe('root');
    expect(cfg.password).toBe('secret');
    expect(cfg.timeoutMs).toBe(60000);
  });

  it('reads a private key for key-auth hosts via the provided reader', () => {
    const reader = vi.fn(() => 'KEY-CONTENTS');
    const cfg = buildSshConfig(
      makeHost({ authType: 'key', keyPath: '/home/user/.ssh/id_rsa', password: undefined }),
      { readKey: reader },
    );
    expect(reader).toHaveBeenCalledWith('/home/user/.ssh/id_rsa');
    expect(cfg.privateKey).toBe('KEY-CONTENTS');
    expect(cfg.password).toBeUndefined();
  });

  it('throws a clear error when the key file cannot be read', () => {
    const reader = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(() =>
      buildSshConfig(makeHost({ authType: 'key', keyPath: '/bad/path', password: undefined }), {
        readKey: reader,
      }),
    ).toThrow(/Failed to read SSH key/);
  });

  it('passes through sudoPassword / suPassword', () => {
    const cfg = buildSshConfig(makeHost({ sudoPassword: 'sudo-pw', suPassword: 'su-pw' }));
    expect(cfg.sudoPassword).toBe('sudo-pw');
    expect(cfg.suPassword).toBe('su-pw');
  });

  it('V3-09: passes through agentForward when true', () => {
    const cfg = buildSshConfig(makeHost({ agentForward: true }));
    expect(cfg.agentForward).toBe(true);
  });

  it('V3-09: omits agentForward when false (ssh2 treats absent as false)', () => {
    const cfg = buildSshConfig(makeHost({ agentForward: false }));
    expect(cfg.agentForward).toBeUndefined();
  });

  it('V3-09: passes through hostKeyFingerprint when set', () => {
    const cfg = buildSshConfig(makeHost({ hostKeyFingerprint: 'sha256-abc' }));
    expect(cfg.hostKeyFingerprint).toBe('sha256-abc');
  });

  it('V3-09: wires a getJumpStream callback when jumpHostId is set', () => {
    const getJumpStream = vi.fn();
    const cfg = buildSshConfig(makeHost({ jumpHostId: 'bastion-1' }), { getJumpStream });
    expect(cfg.getJumpStream).toBe(getJumpStream);
  });

  it('V3-09: omits getJumpStream when no jumpHostId', () => {
    const cfg = buildSshConfig(makeHost());
    expect(cfg.getJumpStream).toBeUndefined();
  });
});
