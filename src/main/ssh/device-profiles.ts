// Device profiles for the executor (Phase 2 of the network-device pager fix).
//
// A profile tells execCommand how to run commands on a host's device type. The
// key switch is `pty`:
//   - Network-device CLIs (Huawei VRP, Cisco IOS, H3C, Juniper, Arista)
//     paginate output and read the advance key (Space) from a terminal. exec
//     must allocate a PTY so the pager receives the Space that createPagerAdvancer
//     sends; without a PTY the device may ignore channel stdin and the command
//     hangs at `---- More ----` until timeout.
//   - Linux/generic hosts keep the no-PTY exec path: the exec channel closes
//     after the command, stderr stays separate, and no ANSI escapes are emitted.
//
// The pager-disable command (e.g. `screen-length 0 temporary`) is intentionally
// NOT applied here: VRP's `temporary` is session/command-scoped, and each SSH
// exec channel is a separate session, so a disable prefix cannot be reliably
// injected over exec. PTY + auto-advance + artifact stripping already yields
// clean, complete output, so the prefix is unnecessary for correctness. (A
// persistent interactive shell - a future phase - could apply it once on
// connect.)
import type { DeviceType } from '../../shared/types.js';

export interface DeviceProfile {
  /** Allocate a PTY for exec so the device's pager reads the advance key. */
  pty: boolean;
}

const PROFILES: Record<DeviceType, DeviceProfile> = {
  linux: { pty: false },
  generic: { pty: false },
  'huawei-vrp': { pty: true },
  'cisco-ios': { pty: true },
  h3c: { pty: true },
  'juniper-junos': { pty: true },
  'arista-eos': { pty: true },
};

/**
 * Resolve the exec profile for a device type. Undefined / unknown falls back to
 * the Linux (no-PTY) profile so a missing deviceType never breaks exec.
 */
export function getDeviceProfile(deviceType: DeviceType | undefined): DeviceProfile {
  if (!deviceType) return PROFILES.linux;
  return PROFILES[deviceType] ?? PROFILES.generic;
}
