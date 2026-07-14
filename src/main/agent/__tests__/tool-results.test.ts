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
      expect(result.preview).toHaveLength(2000);
      expect(result.totalChars).toBe(MAX_TOOL_RESULT_CHARS + 100);
      expect(result.fullResultPath).toContain('sess-1');
      expect(result.fullResultPath).toContain('exec-123.json');
      expect(result.hint).toContain('read_tool_result');
      expect(existsSync(result.fullResultPath)).toBe(true);
    });

    it('uses larger preview for error outputs', () => {
      const bigStdout = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 100);
      const result = persistToolResult('sess-1', 'exec-err', {
        stdout: bigStdout,
        stderr: 'error',
        exitCode: 1,
        command: 'fail',
        hostName: 'host-A',
        toolName: 'exec',
      });

      expect(result.preview).toHaveLength(3000);
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

      expect(result.preview).toHaveLength(3000);
      expect(result.preview).toMatch(/^e+$/);
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
