// Command builders for structured ops tools (#13).
// These are pure functions that construct safe shell commands.
// All commands are READ-only (no system state mutation).
// Paths are single-quoted to prevent injection.

// Quote a path for safe use in shell commands.
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// tail_log: read the last N lines of a file, optionally following.
export function buildTailLogCommand(path: string, lines?: number, follow?: boolean): string {
  const n = lines ?? 200;
  const f = follow ? ' -f' : '';
  return `tail -n ${n}${f} ${quote(path)}`;
}

// search_logs: grep across log files with context.
export function buildSearchLogsCommand(
  pattern: string,
  paths: string[],
  opts: { contextLines?: number; caseInsensitive?: boolean; maxResults?: number },
): string {
  const parts: string[] = ['grep', '-n'];
  if (opts.caseInsensitive) parts.push('-i');
  if (opts.contextLines) parts.push(`-C ${opts.contextLines}`);
  parts.push(quote(pattern));
  for (const p of paths) parts.push(quote(p));
  let cmd = parts.join(' ');
  if (opts.maxResults) {
    cmd += ` | head -n ${opts.maxResults}`;
  }
  return cmd;
}

// journal_query: query systemd journal.
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
  parts.push(`-n ${opts.lines ?? 100}`);
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
