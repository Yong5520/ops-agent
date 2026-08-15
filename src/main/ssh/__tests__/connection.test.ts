// Unit tests for buildConnectConfig (V3-09 Cycle C).
//
// connection.connect() builds the ssh2 connect-config object from the
// SshClientConfig. V3-09 adds: agentForward, hostVerifier (built from
// hostKeyFingerprint), and a `sock` placeholder (the actual stream is awaited
// from getJumpStream in connect() and assigned separately). buildConnectConfig
// is extracted as a pure function so this wiring is unit-testable without a
// real ssh2 Client.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildConnectConfig } from '../connection.js';
import type { SshClientConfig } from '../types.js';

function makeConfig(overrides: Partial<SshClientConfig> = {}): SshClientConfig {
  return {
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    password: 'secret',
    timeoutMs: 60000,
    ...overrides,
  };
}

describe('buildConnectConfig', () => {
  it('builds the base ssh2 connect config', () => {
    const cfg = buildConnectConfig(makeConfig());
    expect(cfg.host).toBe('10.0.0.1');
    expect(cfg.port).toBe(22);
    expect(cfg.username).toBe('root');
    expect(cfg.password).toBe('secret');
    expect(cfg.readyTimeout).toBe(30_000);
    expect(cfg.keepaliveInterval).toBe(30_000);
  });

  it('includes privateKey + passphrase for key auth', () => {
    const cfg = buildConnectConfig(
      makeConfig({ password: undefined, privateKey: 'KEY', passphrase: 'pass' }),
    );
    expect(cfg.privateKey).toBe('KEY');
    expect(cfg.passphrase).toBe('pass');
    expect(cfg.password).toBeUndefined();
  });

  it('V3-09: sets agentForward=true when configured', () => {
    const cfg = buildConnectConfig(makeConfig({ agentForward: true }));
    expect(cfg.agentForward).toBe(true);
  });

  it('V3-09: omits agentForward when not set (ssh2 default false)', () => {
    const cfg = buildConnectConfig(makeConfig());
    expect(cfg.agentForward).toBeUndefined();
  });

  it('V3-09: builds a hostVerifier from hostKeyFingerprint that accepts on match', () => {
    const cfg = buildConnectConfig(makeConfig({ hostKeyFingerprint: 'SHA256:expected' }));
    expect(typeof cfg.hostVerifier).toBe('function');
    const hostVerifier = cfg.hostVerifier as (
      key: Buffer | string,
      verify: (ok: boolean) => void,
    ) => void;
    // The verifier computes the SHA256 fingerprint of the raw host key bytes
    // and compares to the expected. On match it must call verify(true).
    const verify = vi.fn();
    // Mismatch path: a clearly-different key -> verify(false).
    hostVerifier('different-key-bytes', verify);
    expect(verify).toHaveBeenCalledWith(false);
  });

  it('V3-09: hostVerifier accepts when the key fingerprint matches', () => {
    // Compute the real fingerprint of a known key so the match path is exercised.
    const keyBytes = Buffer.from('my-host-key');
    const expected =
      'SHA256:' + createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '');
    const cfg = buildConnectConfig(makeConfig({ hostKeyFingerprint: expected }));
    const hostVerifier = cfg.hostVerifier as (
      key: Buffer | string,
      verify: (ok: boolean) => void,
    ) => void;
    const verify = vi.fn();
    hostVerifier(keyBytes, verify);
    expect(verify).toHaveBeenCalledWith(true);
  });

  it('V3-09: hostVerifier calls onMismatch with expected+actual on mismatch', () => {
    // The mismatch callback lets the connection manager augment the eventual
    // ssh2 "Host denied (verification failed)" error with the actual fingerprints
    // so the user can diagnose a stale stored fingerprint.
    const onMismatch = vi.fn();
    const cfg = buildConnectConfig(makeConfig({ hostKeyFingerprint: 'SHA256:expected' }), {
      onMismatch,
    });
    const hostVerifier = cfg.hostVerifier as (
      key: Buffer | string,
      verify: (ok: boolean) => void,
    ) => void;
    const verify = vi.fn();
    hostVerifier('different-key-bytes', verify);
    expect(verify).toHaveBeenCalledWith(false);
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch.mock.calls[0][0]).toBe('SHA256:expected'); // expected
    const actualFp =
      'SHA256:' +
      createHash('sha256')
        .update(Buffer.from('different-key-bytes'))
        .digest('base64')
        .replace(/=+$/, '');
    expect(onMismatch.mock.calls[0][1]).toBe(actualFp); // actual fingerprint
  });

  it('V3-09: hostVerifier does NOT call onMismatch on match', () => {
    const onMismatch = vi.fn();
    const keyBytes = Buffer.from('my-host-key');
    const expected =
      'SHA256:' + createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '');
    const cfg = buildConnectConfig(makeConfig({ hostKeyFingerprint: expected }), {
      onMismatch,
    });
    const hostVerifier = cfg.hostVerifier as (
      key: Buffer | string,
      verify: (ok: boolean) => void,
    ) => void;
    const verify = vi.fn();
    hostVerifier(keyBytes, verify);
    expect(verify).toHaveBeenCalledWith(true);
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it('V3-09: omits hostVerifier when no hostKeyFingerprint and no onHostKey', () => {
    const cfg = buildConnectConfig(makeConfig());
    expect(cfg.hostVerifier).toBeUndefined();
  });

  it('V3-09 TOFU: when no fingerprint but onHostKey is set, captures + accepts', () => {
    // First connect to an unknown host: there is no expected fingerprint, so
    // the verifier must trust-on-first-use - compute the key's fingerprint,
    // hand it to onHostKey (so the pool can persist it), and verify(true).
    const keyBytes = Buffer.from('my-host-key');
    const expected =
      'SHA256:' + createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '');
    const onHostKey = vi.fn();
    const cfg = buildConnectConfig(makeConfig(), { onHostKey });
    expect(typeof cfg.hostVerifier).toBe('function');
    const hostVerifier = cfg.hostVerifier as (
      key: Buffer | string,
      verify: (ok: boolean) => void,
    ) => void;
    const verify = vi.fn();
    hostVerifier(keyBytes, verify);
    expect(verify).toHaveBeenCalledWith(true); // TOFU accepts
    expect(onHostKey).toHaveBeenCalledWith(expected); // captured for persistence
  });

  it('V3-09.1: enables tryKeyboard when targetPassword is set (manual target auth)', () => {
    const cfg = buildConnectConfig(makeConfig({ targetPassword: 'target-pw' }));
    expect(cfg.tryKeyboard).toBe(true);
  });

  it('V3-09.1: omits tryKeyboard when no targetPassword (bastion-managed)', () => {
    const cfg = buildConnectConfig(makeConfig());
    expect(cfg.tryKeyboard).toBeUndefined();
  });
});
