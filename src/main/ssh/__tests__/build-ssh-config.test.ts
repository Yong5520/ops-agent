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
import { buildSshConfig, renderJumpUsername } from '../build-ssh-config.js';
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

// ── V3-09.1: encoded-username bastion mode ──────────────────────────────
// Some bastions (e.g. jump.iluvatar.com:2222) disable TCP forwarding and
// instead route via an encoded username: a single SSH connection to the
// bastion with username `{bastionUser}@{targetUser}@{targetHost}` drops the
// caller into a shell on the target. No forwardOut, no second SSH hop from
// the client. buildSshConfig in encoded mode connects straight to the bastion
// using the bastion's credentials.
describe('renderJumpUsername', () => {
  const bastion: HostConfig = {
    id: 'b1',
    name: 'bastion',
    host: 'jump.iluvatar.com',
    port: 2222,
    username: 'yong.cao',
    authType: 'password',
    password: 'bpw',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const target: HostConfig = {
    id: 't1',
    name: 'chip-18-10',
    host: '10.150.18.10',
    port: 22,
    username: 'powerone',
    authType: 'password',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  it('renders the default template {bastionUser}@{targetUser}@{targetHost}', () => {
    expect(renderJumpUsername(undefined, bastion, target)).toBe('yong.cao@powerone@10.150.18.10');
  });

  it('renders a custom template with all placeholders', () => {
    expect(
      renderJumpUsername('{bastionUser}/{targetUser}/{targetHost}:{targetPort}', bastion, target),
    ).toBe('yong.cao/powerone/10.150.18.10:22');
  });

  it('throws on an unknown placeholder', () => {
    expect(() => renderJumpUsername('{bastionUser}@{unknown}', bastion, target)).toThrow(
      /unknown placeholder/i,
    );
  });
});

describe('buildSshConfig encoded mode', () => {
  const bastion: HostConfig = {
    id: 'b1',
    name: 'bastion',
    host: 'jump.iluvatar.com',
    port: 2222,
    username: 'yong.cao',
    authType: 'password',
    password: 'bpw',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const target = (overrides: Partial<HostConfig> = {}): HostConfig => ({
    id: 't1',
    name: 'chip-18-10',
    host: '10.150.18.10',
    port: 22,
    username: 'powerone',
    authType: 'password',
    password: 'target-pw',
    groupName: 'default',
    timeoutMs: 60000,
    agentForward: false,
    jumpHostId: 'b1',
    jumpMode: 'encoded',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  });

  it('connects to the BASTION (not the target) with the encoded username', () => {
    const cfg = buildSshConfig(target(), { bastion });
    expect(cfg.host).toBe('jump.iluvatar.com'); // bastion host, not 10.150.18.10
    expect(cfg.port).toBe(2222); // bastion port, not 22
    expect(cfg.username).toBe('yong.cao@powerone@10.150.18.10'); // encoded
  });

  it('uses the BASTION credentials (not the target password)', () => {
    const cfg = buildSshConfig(target(), { bastion });
    expect(cfg.password).toBe('bpw'); // bastion password
    expect(cfg.password).not.toBe('target-pw');
  });

  it('does NOT wire getJumpStream (single connection, no forwardOut)', () => {
    const getJumpStream = vi.fn();
    const cfg = buildSshConfig(target(), { bastion, getJumpStream });
    expect(cfg.getJumpStream).toBeUndefined();
  });

  it('uses a custom username template when provided', () => {
    const cfg = buildSshConfig(
      target({ jumpUsernameTemplate: '{targetUser}@{targetHost}@{bastionUser}' }),
      { bastion },
    );
    expect(cfg.username).toBe('powerone@10.150.18.10@yong.cao');
  });

  it('passes through targetPassword when jumpTargetAuth is "password"', () => {
    const cfg = buildSshConfig(target({ jumpTargetAuth: 'password' }), { bastion });
    // The bastion password still authenticates the connection; targetPassword
    // is carried for the second keyboard-interactive round (target prompt).
    expect(cfg.password).toBe('bpw');
    expect(cfg.targetPassword).toBe('target-pw');
  });

  it('omits targetPassword when jumpTargetAuth is "bastion-managed" (default)', () => {
    const cfg = buildSshConfig(target(), { bastion });
    expect(cfg.targetPassword).toBeUndefined();
  });

  it('throws when encoded mode is set but no bastion record is provided', () => {
    expect(() => buildSshConfig(target())).toThrow(/bastion/i);
  });

  it('throws when the bastion itself has a jumpHostId (encoded mode does not chain)', () => {
    const chainingBastion: HostConfig = { ...bastion, jumpHostId: 'b2' };
    expect(() => buildSshConfig(target(), { bastion: chainingBastion })).toThrow(/chain/i);
  });

  it('V3-09.1 H1: carries the TARGET sudo/su password (exec runs on target), not bastion', () => {
    const cfg = buildSshConfig(target({ sudoPassword: 'target-sudo', suPassword: 'target-su' }), {
      bastion: { ...bastion, sudoPassword: 'bastion-sudo', suPassword: 'bastion-su' },
    });
    expect(cfg.sudoPassword).toBe('target-sudo');
    expect(cfg.suPassword).toBe('target-su');
    expect(cfg.sudoPassword).not.toBe('bastion-sudo');
  });

  it('V3-09.1 M2: carries the BASTION hostKeyFingerprint (connection terminates at bastion)', () => {
    const cfg = buildSshConfig(target(), {
      bastion: { ...bastion, hostKeyFingerprint: 'SHA256:bastion-fp' },
    });
    expect(cfg.hostKeyFingerprint).toBe('SHA256:bastion-fp');
  });

  it('V3-09.1 M2: omits hostKeyFingerprint when the bastion has none (TOFU will capture it)', () => {
    const cfg = buildSshConfig(target(), { bastion });
    expect(cfg.hostKeyFingerprint).toBeUndefined();
  });
});
