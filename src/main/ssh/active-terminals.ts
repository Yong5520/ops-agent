// Active terminal host tracker.
//
// When an interactive SSH terminal session is open on a host, that host's
// connection must NOT be closed by the ConnectionPool's idle-timeout checker,
// even if no commands have been typed for a while. The terminal shell itself
// is a long-lived stream that counts as "active" regardless of user input.
//
// This module is a simple shared Set that terminal.ts updates (on start/kill)
// and pool.ts consults during its idle sweep.

const activeTerminalHosts = new Set<string>();

export function markTerminalActive(hostId: string): void {
  activeTerminalHosts.add(hostId);
}

export function unmarkTerminalActive(hostId: string): void {
  activeTerminalHosts.delete(hostId);
}

export function hasActiveTerminal(hostId: string): boolean {
  return activeTerminalHosts.has(hostId);
}

export function getActiveTerminalHosts(): Set<string> {
  return activeTerminalHosts;
}
