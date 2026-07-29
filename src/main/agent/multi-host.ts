// Multi-host execution aggregation (V3-08).
//
// exec_multi fans a single command out to multiple hosts (Promise.allSettled)
// and collects per-host results. aggregateMultiHostResults turns that raw
// collection into a compact, model-friendly summary: a per-host keyed table,
// success/failed counts, and a divergence check (the whole point of running
// the same command on many hosts is to spot where they differ).
//
// Pure functions - no SSH, no IPC - so they unit-test directly.

/** One host's exec_multi result (resolved or rejected). */
export interface MultiHostExecResult {
  hostName: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Per-host entry in the aggregated map (stdout previewed, not full). */
export interface MultiHostSummaryEntry {
  hostName: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  durationMs: number;
}

export interface MultiHostSummary {
  totalCount: number;
  successCount: number;
  failedCount: number;
  /** True iff >=2 succeeding hosts returned different (trimmed) stdout. */
  divergent: boolean;
  /** Number of distinct trimmed-stdout values among succeeding hosts. */
  distinctOutputCount: number;
  byHost: Record<string, MultiHostSummaryEntry>;
  /** Plain-text summary the model reads as the tool result. */
  summaryText: string;
}

const STDOUT_PREVIEW_CHARS = 500;

function trimTrailing(s: string): string {
  return s.replace(/\s+$/, '');
}

/**
 * Aggregate per-host exec results into a model-friendly summary.
 *
 * - Counts successes (ok=true) and failures.
 * - Previews each host's stdout to STDOUT_PREVIEW_CHARS (flagged truncated).
 * - Divergence check: among SUCCEEDING hosts only (failures excluded), are
 *   there >=2 distinct trimmed-stdout values? Trailing whitespace is ignored
 *   so hosts that differ only in padding are not flagged.
 * - Builds a plain-text summary string with per-host lines.
 */
export function aggregateMultiHostResults(results: MultiHostExecResult[]): MultiHostSummary {
  const totalCount = results.length;
  const succeeding = results.filter((r) => r.ok);
  const successCount = succeeding.length;
  const failedCount = totalCount - successCount;

  const byHost: Record<string, MultiHostSummaryEntry> = {};
  for (const r of results) {
    const truncated = r.stdout.length > STDOUT_PREVIEW_CHARS;
    byHost[r.hostName] = {
      hostName: r.hostName,
      ok: r.ok,
      exitCode: r.exitCode,
      stdout: truncated ? r.stdout.slice(0, STDOUT_PREVIEW_CHARS) : r.stdout,
      stdoutTruncated: truncated,
      stderr: r.stderr,
      durationMs: r.durationMs,
    };
  }

  // Divergence: distinct trimmed stdouts among succeeding hosts.
  const distinct = new Set(succeeding.map((r) => trimTrailing(r.stdout)));
  const distinctOutputCount = distinct.size;
  const divergent = distinctOutputCount >= 2;

  const lines: string[] = [];
  lines.push(
    `共 ${totalCount} 台主机：${successCount} 成功，${failedCount} 失败` +
      (divergent ? `，输出存在差异（${distinctOutputCount} 种）` : ''),
  );
  for (const r of results) {
    const status = r.ok ? `✓ exit=${r.exitCode}` : `✗ ${r.stderr || 'failed'}`;
    const preview = r.ok ? trimTrailing(r.stdout).slice(0, 120) : '';
    lines.push(`- ${r.hostName}: ${status}${preview ? ` | ${preview}` : ''}`);
  }
  const summaryText = lines.join('\n');

  return {
    totalCount,
    successCount,
    failedCount,
    divergent,
    distinctOutputCount,
    byHost,
    summaryText,
  };
}
