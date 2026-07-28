import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setResultsBaseDir,
  shouldPersist,
  persistToolResult,
  readPersistedResult,
  cleanupSessionResults,
  cleanupOldResults,
  buildPreview,
  MAX_TOOL_RESULT_CHARS,
} from '../tool-results.js';

describe('tool-results', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ops-agent-test-'));
    setResultsBaseDir(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    setResultsBaseDir(null);
  });

  describe('shouldPersist', () => {
    it('returns false for small results', () => {
      expect(shouldPersist('hello', '')).toBe(false);
    });

    it('returns true when stdout + stderr exceeds MAX_TOOL_RESULT_CHARS', () => {
      const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 1);
      expect(shouldPersist(big, '')).toBe(true);
    });

    it('returns true when combined stdout + stderr exceeds limit', () => {
      const half = 'x'.repeat(Math.floor(MAX_TOOL_RESULT_CHARS / 2) + 1);
      expect(shouldPersist(half, half)).toBe(true);
    });
  });

  describe('persistToolResult', () => {
    it('writes a JSON file and returns preview + path', () => {
      const bigStdout = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 100);
      const result = persistToolResult('sess-1', 'exec-123', {
        stdout: bigStdout,
        stderr: '',
        exitCode: 0,
        command: 'cat /var/log/syslog',
        hostName: 'host-A',
        toolName: 'exec',
      });

      expect(result.truncated).toBe(true);
      // V3-06: preview is now head + tail (not head-only), so its length is no
      // longer exactly 2000. It must START with the head and END with the tail.
      expect(result.preview.startsWith('x')).toBe(true);
      expect(result.preview.endsWith('x')).toBe(true);
      expect(result.preview.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
      expect(result.totalChars).toBe(MAX_TOOL_RESULT_CHARS + 100);
      expect(result.fullResultPath).toContain('sess-1');
      expect(result.fullResultPath).toContain('exec-123.json');
      expect(result.hint).toContain('read_tool_result');
      expect(existsSync(result.fullResultPath)).toBe(true);
    });

    it('V3-06: preview preserves the TAIL (where errors/stack traces live)', () => {
      // A 50k-char stdout whose last lines are a distinctive stack trace.
      // The old head-only preview dropped the tail entirely; the new preview
      // must keep it so the model sees the actual error.
      const head = 'A'.repeat(40000);
      const tail = 'STACK-TRACE-MARKER\nat foo (bar.js:1)\nat baz (qux.js:2)';
      const bigStdout = head + '\n' + tail;
      const result = persistToolResult('sess-1', 'exec-tail', {
        stdout: bigStdout,
        stderr: '',
        exitCode: 0,
        command: 'cat /var/log/app.log',
        hostName: 'host-A',
        toolName: 'exec',
      });

      expect(result.preview).toContain('STACK-TRACE-MARKER');
      expect(result.preview).toContain('at baz (qux.js:2)');
    });

    it('uses larger preview budget for error outputs', () => {
      const bigStdout = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 100);
      const result = persistToolResult('sess-1', 'exec-err', {
        stdout: bigStdout,
        stderr: 'error',
        exitCode: 1,
        command: 'fail',
        hostName: 'host-A',
        toolName: 'exec',
      });

      // Error outputs get a larger total preview budget than success. Still
      // head+tail, so no exact length assertion - just that it's bounded and
      // present.
      expect(result.preview.length).toBeGreaterThan(0);
      expect(result.preview.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    });

    it('falls back to stderr when stdout is empty', () => {
      const bigStderr = 'e'.repeat(MAX_TOOL_RESULT_CHARS + 50);
      const result = persistToolResult('sess-1', 'exec-err2', {
        stdout: '',
        stderr: bigStderr,
        exitCode: 1,
        command: 'fail',
        hostName: 'host-A',
        toolName: 'exec',
      });

      // Preview built from stderr; head + tail both come from the same 'e' blob.
      expect(result.preview.startsWith('e')).toBe(true);
      expect(result.preview.endsWith('e')).toBe(true);
    });
  });

  describe('buildPreview (V3-06 head+tail)', () => {
    it('returns the full text unchanged when under the budget', () => {
      const text = 'short output\nsecond line';
      expect(buildPreview(text, 2000)).toBe(text);
    });

    it('returns the full text when exactly at the budget', () => {
      const text = 'x'.repeat(2000);
      expect(buildPreview(text, 2000)).toBe(text);
    });

    it('keeps head + tail with an omitted-marker in the middle when over budget', () => {
      const head = 'H'.repeat(1000);
      const middle = 'M'.repeat(5000);
      const tail = 'T'.repeat(1000);
      const text = head + middle + tail;
      const preview = buildPreview(text, 2000);

      // Preview starts with HEAD chars and ends with TAIL chars (the tail
      // budget may be < 1000 after subtracting marker + head reserves, so we
      // assert the tail region is present, not the full 1000-T string).
      expect(preview.startsWith('H')).toBe(true);
      expect(preview.endsWith('T')).toBe(true);
      // No middle 'M' chars should survive - the middle is fully omitted.
      expect(preview).not.toContain('M');
      expect(preview).toMatch(/omitted|省略/i);
      expect(preview.length).toBeLessThan(text.length);
      expect(preview.length).toBeLessThanOrEqual(2000);
    });

    it('does not duplicate the tail into the head when text is just over budget', () => {
      // Edge case: a text only slightly over budget must not overlap head/tail.
      const text = 'A'.repeat(2001);
      const preview = buildPreview(text, 2000);
      expect(preview.length).toBeLessThanOrEqual(2000);
      expect(preview).toMatch(/omitted|省略/i);
    });

    it('V3-06 regression: never exceeds maxChars even for tiny maxChars (< marker reserve)', () => {
      // When maxChars < markerReserve (~80), budgets clamp to 0 so slice() does
      // not use offset-from-end semantics. The preview must stay within maxChars.
      const text = 'A'.repeat(100);
      for (const tiny of [30, 50, 79, 80]) {
        const preview = buildPreview(text, tiny);
        expect(preview.length).toBeLessThanOrEqual(tiny);
      }
    });
  });

  describe('readPersistedResult', () => {
    it('reads back the persisted data', () => {
      const bigStdout = 'data-' + 'x'.repeat(MAX_TOOL_RESULT_CHARS);
      const result = persistToolResult('sess-1', 'exec-read', {
        stdout: bigStdout,
        stderr: '',
        exitCode: 0,
        command: 'cmd',
        hostName: 'host-A',
        toolName: 'exec',
      });

      const data = readPersistedResult(result.fullResultPath);
      expect(data.stdout).toBe(bigStdout);
      expect(data.exitCode).toBe(0);
      expect(data.command).toBe('cmd');
      expect(data.hostName).toBe('host-A');
      expect(data.toolName).toBe('exec');
      expect(data.timestamp).toBeTruthy();
    });

    it('rejects paths outside the results directory (path traversal)', () => {
      expect(() => readPersistedResult('/etc/passwd')).toThrow(/tool-results directory/);
      expect(() => readPersistedResult(join(testDir, '..', '..', 'etc', 'passwd'))).toThrow(
        /tool-results directory/,
      );
    });
  });

  describe('cleanupSessionResults', () => {
    it('removes the session directory', () => {
      const result = persistToolResult('sess-clean', 'exec-1', {
        stdout: 'x'.repeat(MAX_TOOL_RESULT_CHARS + 10),
        stderr: '',
        exitCode: 0,
        command: 'cmd',
        hostName: 'host-A',
        toolName: 'exec',
      });

      expect(existsSync(result.fullResultPath)).toBe(true);
      cleanupSessionResults('sess-clean');
      expect(existsSync(result.fullResultPath)).toBe(false);
    });

    it('does not throw when session dir does not exist', () => {
      expect(() => cleanupSessionResults('nonexistent')).not.toThrow();
    });
  });

  describe('cleanupOldResults', () => {
    it('removes session directories older than maxAgeDays', () => {
      // Create an old session dir
      const oldDir = join(testDir, 'old-session');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, 'result.json'), '{}');

      // Backdate the directory mtime by writing a file with an old timestamp
      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      utimesSync(oldDir, oldTime, oldTime);

      // Create a recent session dir
      const recentDir = join(testDir, 'recent-session');
      mkdirSync(recentDir, { recursive: true });
      writeFileSync(join(recentDir, 'result.json'), '{}');

      cleanupOldResults(7);

      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(recentDir)).toBe(true);
    });

    it('does not throw when base dir does not exist', () => {
      setResultsBaseDir(join(testDir, 'nonexistent'));
      expect(() => cleanupOldResults(7)).not.toThrow();
    });
  });
});
