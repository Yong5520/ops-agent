// Large tool result persistence (P1-1).
//
// When a tool result exceeds MAX_TOOL_RESULT_CHARS, the full result is
// written to disk and only a preview is returned to the model. This keeps
// the prompt context window manageable while preserving full output for
// on-demand retrieval via the read_tool_result tool.
//
// Storage layout:
//   {userData}/tool-results/{sessionId}/{toolCallId}.json
//
// Each file is a JSON object: { stdout, stderr, exitCode, command, hostName,
// toolName, timestamp }.

import { join, resolve } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { logger } from '../utils/logger.js';

export const MAX_TOOL_RESULT_CHARS = 8000;
export const PREVIEW_CHARS_SUCCESS = 2000;
export const PREVIEW_CHARS_ERROR = 3000;

let _baseDir: string | null = null;

// Allow tests to override the storage directory.
export function setResultsBaseDir(dir: string | null): void {
  _baseDir = dir;
}

function getBaseDir(): string {
  if (_baseDir) return _baseDir;
  // Fallback for environments where setResultsBaseDir was not called
  // (e.g. tests that forgot to call it). Uses OS temp directory.
  return join(tmpdir(), 'ops-agent-tool-results');
}

export interface ToolResultData {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command: string;
  hostName: string;
  toolName: string;
  timestamp: string;
}

export interface PersistedResult {
  preview: string;
  fullResultPath: string;
  totalChars: number;
  truncated: boolean;
  hint: string;
}

export function shouldPersist(stdout: string, stderr: string): boolean {
  return stdout.length + stderr.length > MAX_TOOL_RESULT_CHARS;
}

export function persistToolResult(
  sessionId: string,
  toolCallId: string,
  data: Omit<ToolResultData, 'timestamp'>,
): PersistedResult {
  const dir = join(getBaseDir(), sessionId);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${toolCallId}.json`);
  const fullData: ToolResultData = { ...data, timestamp: new Date().toISOString() };

  // Atomic write: temp file + rename
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(fullData, null, 2), 'utf8');
  renameSync(tmpPath, filePath);

  const totalChars = data.stdout.length + data.stderr.length;
  const isError = data.exitCode !== null && data.exitCode !== 0;
  const previewChars = isError ? PREVIEW_CHARS_ERROR : PREVIEW_CHARS_SUCCESS;

  // Preview prefers stdout; falls back to stderr for error-only outputs
  const sourceText = data.stdout || data.stderr || '';
  const preview = sourceText.slice(0, previewChars);

  logger.info(`[ToolResults] Persisted ${totalChars} chars for ${data.toolName} -> ${filePath}`);

  return {
    preview,
    fullResultPath: filePath,
    totalChars,
    truncated: true,
    hint: '完整结果已保存到文件。可调用 read_tool_result 工具，传入 fullResultPath 读取完整输出。',
  };
}

export function readPersistedResult(path: string): ToolResultData {
  const baseDir = resolve(getBaseDir());
  const resolved = resolve(path);

  // Path traversal protection - the file must be under the results directory
  const relative = resolved.slice(baseDir.length);
  if (
    !resolved.startsWith(baseDir) ||
    (relative.length > 0 && !relative.startsWith('/') && !relative.startsWith('\\'))
  ) {
    throw new Error('Invalid path: result file must be under the tool-results directory');
  }

  const content = readFileSync(resolved, 'utf8');
  return JSON.parse(content) as ToolResultData;
}

export function cleanupSessionResults(sessionId: string): void {
  const dir = join(getBaseDir(), sessionId);
  try {
    rmSync(dir, { recursive: true, force: true });
    logger.info(`[ToolResults] Cleaned up results for session ${sessionId}`);
  } catch (err) {
    logger.warn(`[ToolResults] Failed to cleanup session ${sessionId}: ${(err as Error).message}`);
  }
}

export function cleanupOldResults(maxAgeDays = 7): void {
  const baseDir = getBaseDir();
  try {
    const entries = readdirSync(baseDir);
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      const entryPath = join(baseDir, entry);
      try {
        const stat = statSync(entryPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          rmSync(entryPath, { recursive: true, force: true });
          logger.info(`[ToolResults] GC removed old results: ${entry}`);
        }
      } catch {
        // skip individual entry errors
      }
    }
  } catch {
    // base dir doesn't exist yet - nothing to clean
  }
}
