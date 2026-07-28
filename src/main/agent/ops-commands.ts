// Command builders for structured ops tools (#13).
// These are pure functions that construct safe shell commands.
// All commands are READ-only (no system state mutation).
// Paths are single-quoted to prevent injection.

// V3-06: clamp a count-like param into [min, max]. Prevents the model from
// requesting unbounded reads (e.g. tail -n 999999) that would flood the context
// window with a single tool result. Defaults to `fallback` when value is
// undefined/null.
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// Quote a path for safe use in shell commands.
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// tail_log: read the last N lines of a file, optionally following.
// V3-06: lines clamped to [1, 2000] so the model can't request tail -n 999999.
export function buildTailLogCommand(path: string, lines?: number, follow?: boolean): string {
  const n = clamp(lines, 1, 2000, 200);
  const f = follow ? ' -f' : '';
  return `tail -n ${n}${f} ${quote(path)}`;
}

// search_logs: grep across log files with context.
// V3-06: contextLines clamped to [0, 10], maxResults to [1, 500] - a high
// contextLines or maxResults can explode the grep output just as badly as a
// large tail count.
export function buildSearchLogsCommand(
  pattern: string,
  paths: string[],
  opts: { contextLines?: number; caseInsensitive?: boolean; maxResults?: number },
): string {
  const parts: string[] = ['grep', '-n'];
  if (opts.caseInsensitive) parts.push('-i');
  const contextLines = clamp(opts.contextLines, 0, 10, 0);
  if (contextLines > 0) parts.push(`-C ${contextLines}`);
  parts.push(quote(pattern));
  for (const p of paths) parts.push(quote(p));
  let cmd = parts.join(' ');
  if (opts.maxResults !== undefined) {
    const maxResults = clamp(opts.maxResults, 1, 500, 500);
    cmd += ` | head -n ${maxResults}`;
  }
  return cmd;
}

// journal_query: query systemd journal.
// V3-06: lines clamped to [1, 2000].
export function buildJournalQueryCommand(opts: {
  unit?: string;
  priority?: string;
  since?: string;
  until?: string;
  lines?: number;
}): string {
  const parts: string[] = ['journalctl'];
  if (opts.unit) parts.push(`-u ${opts.unit}`);
  if (opts.priority) parts.push(`-p ${opts.priority}`);
  if (opts.since) parts.push(`--since ${quote(opts.since)}`);
  if (opts.until) parts.push(`--until ${quote(opts.until)}`);
  parts.push('--no-pager');
  parts.push(`-n ${clamp(opts.lines, 1, 2000, 100)}`);
  return parts.join(' ');
}

// process_list: list processes sorted/filtered.
export function buildProcessListCommand(opts: {
  sortBy?: 'cpu' | 'mem' | 'pid';
  filter?: string;
  top?: number;
}): string {
  const sortFlag = opts.sortBy === 'mem' ? '-%mem' : opts.sortBy === 'pid' ? 'pid' : '-%cpu';
  const top = opts.top ?? 20;
  let cmd = `ps aux --sort=${sortFlag}`;
  if (opts.filter) {
    cmd += ` | grep ${quote(opts.filter)}`;
  }
  cmd += ` | head -n ${top}`;
  return cmd;
}

// service_status: check systemd service status.
export function buildServiceStatusCommand(unit?: string): string {
  if (unit) {
    return `systemctl status ${unit} --no-pager`;
  }
  return 'systemctl --failed --no-pager';
}

// disk_analysis: disk usage breakdown.
export function buildDiskAnalysisCommand(path?: string, depth?: number, top?: number): string {
  const p = path ?? '/';
  const d = depth ?? 1;
  const t = top ?? 20;
  return `du -h --max-depth=${d} ${quote(p)} 2>/dev/null | sort -rh | head -n ${t}`;
}

// network_connections: list active network connections.
export function buildNetworkConnectionsCommand(opts: {
  protocol?: 'tcp' | 'udp';
  port?: number;
  state?: string;
}): string {
  let cmd = 'ss -tunap';
  if (opts.port) {
    cmd += ` ${quote(`sport = :${opts.port}`)}`;
  }
  if (opts.state) {
    cmd += ` state ${opts.state}`;
  }
  return cmd;
}
