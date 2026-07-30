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
  /** V3-09.1: the resolved bastion host record, supplied by the pool when
   * host.jumpMode === 'encoded'. The encoded-mode connection goes to the
   * bastion (not the target) using the bastion's credentials. */
  bastion?: HostConfig;
}

const DEFAULT_JUMP_USERNAME_TEMPLATE = '{bastionUser}@{targetUser}@{targetHost}';

/**
 * Render an encoded-username bastion's SSH username from a template.
 * Placeholders: {bastionUser}, {targetUser}, {targetHost}, {targetPort}.
 * Default template: `{bastionUser}@{targetUser}@{targetHost}`.
 * Throws on an unknown placeholder so a typo fails loudly instead of silently
 * producing a malformed username the bastion rejects.
 */
export function renderJumpUsername(
  template: string | undefined,
  bastion: HostConfig,
  target: HostConfig,
): string {
  const tpl = template ?? DEFAULT_JUMP_USERNAME_TEMPLATE;
  const vars: Record<string, string> = {
    bastionUser: bastion.username,
    targetUser: target.username,
    targetHost: target.host,
    targetPort: String(target.port),
  };
  return tpl.replace(/\{(\w+)\}/g, (full, key: string) => {
    if (!(key in vars)) {
      throw new Error(
        `renderJumpUsername: unknown placeholder "${full}" in template "${tpl}". ` +
          `Known: {bastionUser}, {targetUser}, {targetHost}, {targetPort}.`,
      );
    }
    return vars[key];
  });
}

export function buildSshConfig(
  host: HostConfig,
  opts: BuildSshConfigOptions = {},
): SshClientConfig {
  const readKey = opts.readKey ?? ((p: string) => readFileSync(p, 'utf8'));

  // V3-09.1: encoded-username bastion mode. Connect straight to the bastion
  // with an encoded username + the bastion's credentials. No forwardOut, no
  // sock - the bastion routes exec to the target. exec runs on the target.
  if (host.jumpMode === 'encoded') {
    const bastion = opts.bastion;
    if (!bastion) {
      throw new Error(
        `buildSshConfig: host "${host.name}" uses encoded jump mode but no bastion ` +
          'record was provided. The pool must resolve jumpHostId and pass it as opts.bastion.',
      );
    }
    if (bastion.jumpHostId) {
      throw new Error(
        `buildSshConfig: encoded jump mode does not support chaining, but bastion ` +
          `"${bastion.name}" itself has a jumpHostId. Use a directly-reachable bastion.`,
      );
    }
    const encoded: SshClientConfig = {
      host: bastion.host,
      port: bastion.port,
      username: renderJumpUsername(host.jumpUsernameTemplate, bastion, host),
      timeoutMs: host.timeoutMs,
    };
    // V3-09.1/M2: the SSH connection terminates at the BASTION, so host-key
    // verification uses the BASTION's fingerprint. The pool points onHostKey
    // capture at the bastion's record (not the target's).
    if (bastion.hostKeyFingerprint) encoded.hostKeyFingerprint = bastion.hostKeyFingerprint;
    // Use the BASTION's credentials (the target's are not used by the client
    // in encoded mode - the bastion logs into the target itself, unless
    // jumpTargetAuth='password' carries the target password for a 2nd round).
    if (bastion.authType === 'password' && bastion.password) {
      encoded.password = bastion.password;
    } else if (bastion.authType === 'key' && bastion.keyPath) {
      try {
        encoded.privateKey = readKey(bastion.keyPath);
      } catch (err) {
        throw new Error(`Failed to read SSH key at ${bastion.keyPath}: ${(err as Error).message}`);
      }
    }
    // sudo/su elevation runs on the TARGET (exec is routed there by the
    // bastion), so carry the TARGET's elevation passwords - NOT the bastion's.
    if (host.sudoPassword) encoded.sudoPassword = host.sudoPassword;
    if (host.suPassword) encoded.suPassword = host.suPassword;
    // Carry the target password for the keyboard-interactive 2nd round when
    // the user opted into manual target auth.
    if (host.jumpTargetAuth === 'password' && host.password) {
      encoded.targetPassword = host.password;
    }
    return encoded;
  }

  // Default (forward / direct) path.
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
