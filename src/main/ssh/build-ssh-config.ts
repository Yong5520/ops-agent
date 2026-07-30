// Build an SshClientConfig from a decrypted HostConfig (V3-09 extracted from
// pool.ts so it is unit-testable).
//
// V3-09 additions:
//  - agentForward passthrough (omitted when false so ssh2 treats it as off).
//  - hostKeyFingerprint passthrough (connection.ts turns it into a hostVerifier).
//  - getJumpStream callback wiring when host.jumpHostId is set. The pool
//    supplies the callback; connection.ts awaits it at connect time to obtain
//    the ssh2 stream from the jump host and passes it as `sock`. buildSshConfig
//    itself does NOT create the stream (that needs a live jump-host connection).
import { readFileSync } from 'node:fs';
import type { HostConfig } from '../../shared/types.js';
import type { SshClientConfig } from './types.js';

export interface BuildSshConfigOptions {
  /** Override the SSH key file reader (for testing). Defaults to readFileSync. */
  readKey?: (path: string) => string;
  /** Supplied by the pool when host.jumpHostId is set - returns a stream from
   * the jump host to use as `sock` for the target connection. */
  getJumpStream?: () => Promise<unknown>;
}

export function buildSshConfig(
  host: HostConfig,
  opts: BuildSshConfigOptions = {},
): SshClientConfig {
  const readKey = opts.readKey ?? ((p: string) => readFileSync(p, 'utf8'));

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
      config.privateKey = readKey(host.keyPath);
    } catch (err) {
      throw new Error(`Failed to read SSH key at ${host.keyPath}: ${(err as Error).message}`);
    }
  }

  if (host.sudoPassword) config.sudoPassword = host.sudoPassword;
  if (host.suPassword) config.suPassword = host.suPassword;

  // V3-09: agent forwarding (omitted when false).
  if (host.agentForward) config.agentForward = true;
  // V3-09: host-key fingerprint (TOFU - connection.ts builds the hostVerifier).
  if (host.hostKeyFingerprint) config.hostKeyFingerprint = host.hostKeyFingerprint;
  // V3-09: jump/bastion host - wire the stream provider (pool supplies it).
  if (host.jumpHostId && opts.getJumpStream) {
    config.getJumpStream = opts.getJumpStream;
  }

  return config;
}
