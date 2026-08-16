import type { HostConfig } from '../../shared/types.js';

/**
 * Resolve the host a quick command (> / $ prefix) should run on (v24).
 *
 * Explicit @host wins. Without one, the command runs on the session's first
 * selected host - NOT the first host in the DB, which was the old silent
 * fallback and executed commands on an arbitrary machine. With no selection
 * at all, returns null so the caller reports a clear error.
 */
export function resolveQuickCommandHost(
  hostName: string | undefined,
  sessionHostIds: string[] | undefined,
  allHosts: HostConfig[],
): HostConfig | null {
  if (hostName) {
    return allHosts.find((h) => h.name === hostName) ?? null;
  }
  const selected = sessionHostIds ?? [];
  if (selected.length === 0) return null;
  // The session's first selected host (mirrors sessions.host_id = hostIds[0])
  return allHosts.find((h) => h.id === selected[0]) ?? null;
}
