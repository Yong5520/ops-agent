import { connectionPool } from '../ssh/index.js';
import { execCommand } from '../ssh/executor.js';
import { logger } from '../utils/logger.js';

// Host facts gatherer — collects runtime system info (OS, kernel, CPU,
// memory, disk, failed services, recent dmesg errors) via a single SSH
// round-trip. The facts are injected into the system prompt so the AI
// starts a diagnostic session with context, instead of spending 2-3
// tool calls gathering basic info.
//
// Facts are cached per host with a 5-minute TTL. The cache can be
// invalidated on demand (e.g., after a reboot or config change).

export interface HostFacts {
  hostId: string;
  hostName: string;
  os: string;
  kernel: string;
  cpuCores: string;
  memoryTotal: string;
  diskInfo: string;
  failedUnits: string[];
  recentDmesg: string[];
  cachedAt: number;
}

const FACTS_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Per-host cache. Keyed by hostId so switching sessions doesn't invalidate.
const factsCache = new Map<string, HostFacts>();

// Combined command to gather all facts in one SSH round-trip.
// Uses ===MARKER=== delimiters for reliable section parsing.
const GATHER_COMMAND = [
  "echo '===OS==='",
  "(grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release 2>/dev/null | head -2 || lsb_release -d 2>/dev/null || uname -s)",
  "echo '===KERNEL==='",
  'uname -r',
  "echo '===CPU==='",
  '(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)',
  "echo '===MEM==='",
  '(free -h 2>/dev/null | grep ^Mem: || free 2>/dev/null | grep ^Mem:)',
  "echo '===DISK==='",
  'df -h / 2>/dev/null | tail -1',
  "echo '===FAILED==='",
  '(systemctl --failed --no-legend --no-pager 2>/dev/null | head -10 || echo none)',
  "echo '===DMESG==='",
  '(dmesg --level=err --time-format reltime 2>/dev/null | tail -5 || echo none)',
  "echo '===END==='",
].join('; ');

// Gather facts for a host. Returns cached data if fresh, otherwise runs
// the gather command via SSH. Returns null if the host is unreachable or
// the gather command fails — the system prompt gracefully omits facts.
export async function gatherHostFacts(
  hostId: string,
  hostName: string,
): Promise<HostFacts | null> {
  const cached = factsCache.get(hostId);
  if (cached && Date.now() - cached.cachedAt < FACTS_TTL_MS) {
    return cached;
  }

  try {
    const manager = await connectionPool.get(hostId);
    const result = await execCommand(manager, GATHER_COMMAND);
    if (!result.stdout) {
      logger.warn(
        `[Facts] No output from gather command for host ${hostName}: exit=${result.exitCode}, stderr=${result.stderr.slice(0, 200)}`,
      );
      return null;
    }

    const facts = parseFacts(result.stdout, hostId, hostName);
    factsCache.set(hostId, facts);
    logger.info(`[Facts] Gathered facts for ${hostName}: ${facts.os}`);
    return facts;
  } catch (err) {
    logger.warn(`[Facts] Error gathering facts for ${hostName}: ${(err as Error).message}`);
    return null;
  }
}

// Gather facts for multiple hosts in parallel.
export async function gatherMultipleHostFacts(
  hostIds: Array<{ id: string; name: string }>,
): Promise<HostFacts[]> {
  const results = await Promise.allSettled(
    hostIds.map((h) => gatherHostFacts(h.id, h.name)),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<HostFacts | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((f): f is HostFacts => f !== null);
}

// Parse the output of GATHER_COMMAND into structured HostFacts.
function parseFacts(output: string, hostId: string, hostName: string): HostFacts {
  const sections: Record<string, string> = {};
  let currentSection = '';
  let currentLines: string[] = [];

  for (const line of output.split('\n')) {
    const markerMatch = line.match(/^===(\w+)===$/);
    if (markerMatch) {
      if (currentSection) {
        sections[currentSection] = currentLines.join('\n').trim();
      }
      currentSection = markerMatch[1];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // OS: extract PRETTY_NAME value, or fall back to first non-empty line
  const osRaw = sections.OS || '';
  const prettyNameMatch = osRaw.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  const os = prettyNameMatch
    ? prettyNameMatch[1]
    : osRaw.split('\n').find((l) => l.trim())?.trim() || 'unknown';

  // Failed units: first token of each non-"none" line
  const failedUnits = (sections.FAILED || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'none')
    .map((l) => l.split(/\s+/)[0] ?? '')
    .filter(Boolean);

  const recentDmesg = (sections.DMESG || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'none');

  return {
    hostId,
    hostName,
    os: os || 'unknown',
    kernel: sections.KERNEL?.trim() || 'unknown',
    cpuCores: sections.CPU?.trim() || 'unknown',
    memoryTotal: sections.MEM?.trim() || 'unknown',
    diskInfo: sections.DISK?.trim() || 'unknown',
    failedUnits,
    recentDmesg,
    cachedAt: Date.now(),
  };
}

// Clear the facts cache for a specific host (e.g., after config change or reboot).
export function clearFactsCache(hostId?: string): void {
  if (hostId) {
    factsCache.delete(hostId);
  } else {
    factsCache.clear();
  }
}
