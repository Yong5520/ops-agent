// Unit tests for exec_multi aggregation (V3-08).
//
// exec_multi fans a command out to multiple hosts (Promise.allSettled) and
// collects per-host results. aggregateMultiHostResults turns that raw
// allSettled-shaped collection into a compact, model-friendly summary: a
// per-host keyed table + success/failed counts + a divergence hint when hosts
// returned different outputs. Pure function - no SSH, no IPC.
import { describe, it, expect } from 'vitest';
import { aggregateMultiHostResults, type MultiHostExecResult } from '../multi-host.js';

describe('aggregateMultiHostResults', () => {
  const ok = (hostName: string, stdout: string, exitCode = 0): MultiHostExecResult => ({
    hostName,
    ok: true,
    exitCode,
    stdout,
    stderr: '',
    durationMs: 10,
  });
  const fail = (hostName: string, error: string): MultiHostExecResult => ({
    hostName,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: error,
    durationMs: 0,
  });

  it('counts successes and failures across hosts', () => {
    const summary = aggregateMultiHostResults([
      ok('web-1', '80%'),
      ok('web-2', '90%'),
      fail('web-3', 'SSH connection lost'),
    ]);
    expect(summary.successCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.totalCount).toBe(3);
  });

  it('builds a per-host keyed result map', () => {
    const summary = aggregateMultiHostResults([ok('web-1', 'disk: 80%'), fail('web-2', 'timeout')]);
    expect(summary.byHost['web-1']).toMatchObject({ ok: true, exitCode: 0, stdout: 'disk: 80%' });
    expect(summary.byHost['web-2']).toMatchObject({ ok: false, stderr: 'timeout' });
  });

  it('truncates long per-host stdout to a preview in the keyed map', () => {
    const big = 'x'.repeat(5000);
    const summary = aggregateMultiHostResults([ok('web-1', big)]);
    expect(summary.byHost['web-1'].stdout.length).toBeLessThan(big.length);
    expect(summary.byHost['web-1'].stdoutTruncated).toBe(true);
  });

  it('does not mark short output as truncated', () => {
    const summary = aggregateMultiHostResults([ok('web-1', 'short')]);
    expect(summary.byHost['web-1'].stdoutTruncated).toBe(false);
  });

  it('detects divergent outputs across succeeding hosts', () => {
    // The whole point of exec_multi is comparing hosts. When successes differ,
    // the summary must flag it so the model knows to investigate.
    const summary = aggregateMultiHostResults([
      ok('web-1', 'active'),
      ok('web-2', 'inactive'),
      ok('web-3', 'active'),
    ]);
    expect(summary.divergent).toBe(true);
    expect(summary.distinctOutputCount).toBe(2); // "active" and "inactive"
  });

  it('reports non-divergent when all succeeding hosts agree', () => {
    const summary = aggregateMultiHostResults([
      ok('web-1', 'active'),
      ok('web-2', 'active'),
      fail('web-3', 'down'), // failures excluded from divergence check
    ]);
    expect(summary.divergent).toBe(false);
    expect(summary.distinctOutputCount).toBe(1);
  });

  it('handles an empty result list (no hosts)', () => {
    const summary = aggregateMultiHostResults([]);
    expect(summary.totalCount).toBe(0);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(0);
    expect(summary.divergent).toBe(false);
    expect(summary.byHost).toEqual({});
  });

  it('builds a plain-text summary string the model can read', () => {
    const summary = aggregateMultiHostResults([ok('web-1', '80%'), fail('web-2', 'timeout')]);
    expect(summary.summaryText).toContain('web-1');
    expect(summary.summaryText).toContain('web-2');
    expect(summary.summaryText).toContain('2 台主机'); // total count
    expect(summary.summaryText).toMatch(/成功/);
    expect(summary.summaryText).toMatch(/失败/);
  });

  it('dedupes trailing whitespace when comparing outputs for divergence', () => {
    // Hosts that differ only in trailing whitespace should NOT be flagged
    // divergent - common with shell output padding.
    const summary = aggregateMultiHostResults([ok('web-1', 'active\n'), ok('web-2', 'active')]);
    expect(summary.divergent).toBe(false);
  });
});
