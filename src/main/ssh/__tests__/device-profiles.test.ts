// Tests for device-profiles (Phase 2 of the network-device pager fix).
//
// A device profile tells the executor how to run commands on a given host
// device type. The key switch is `pty`: network-device CLIs paginate and read
// the advance key from a terminal, so exec must allocate a PTY for the pager to
// receive the Space we send. Linux/generic hosts keep the no-PTY exec path
// (channels close after the command; no ANSI/merged-stderr).
import { describe, it, expect } from 'vitest';
import { getDeviceProfile } from '../device-profiles.js';
import type { DeviceType } from '../../../shared/types.js';

describe('getDeviceProfile', () => {
  it('allocates a PTY for Huawei VRP switches', () => {
    expect(getDeviceProfile('huawei-vrp').pty).toBe(true);
  });

  it('allocates a PTY for Cisco IOS', () => {
    expect(getDeviceProfile('cisco-ios').pty).toBe(true);
  });

  it('allocates a PTY for H3C', () => {
    expect(getDeviceProfile('h3c').pty).toBe(true);
  });

  it('allocates a PTY for Juniper Junos', () => {
    expect(getDeviceProfile('juniper-junos').pty).toBe(true);
  });

  it('allocates a PTY for Arista EOS', () => {
    expect(getDeviceProfile('arista-eos').pty).toBe(true);
  });

  it('does NOT allocate a PTY for Linux hosts (regression guard)', () => {
    expect(getDeviceProfile('linux').pty).toBe(false);
  });

  it('does NOT allocate a PTY for generic hosts', () => {
    expect(getDeviceProfile('generic').pty).toBe(false);
  });

  it('defaults to the Linux (no-PTY) profile when deviceType is undefined', () => {
    expect(getDeviceProfile(undefined).pty).toBe(false);
  });

  it('every DeviceType has a profile (no undefined lookup)', () => {
    const all: DeviceType[] = [
      'linux',
      'huawei-vrp',
      'cisco-ios',
      'h3c',
      'juniper-junos',
      'arista-eos',
      'generic',
    ];
    for (const t of all) {
      const p = getDeviceProfile(t);
      expect(p).toBeDefined();
      expect(typeof p.pty).toBe('boolean');
    }
  });
});
