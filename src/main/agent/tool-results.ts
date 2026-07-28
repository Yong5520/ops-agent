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

/**
 * Build a head + tail preview of `text` that fits within `maxChars`.
 *
 * V3-06: the previous preview was head-only (`slice(0, N)`), which dropped the
 * tail of command output - exactly where error messages and stack traces live.
 * This keeps a head chunk, an omitted-marker, and a tail chunk so the model
 * sees both the start (command context) and the end (errors) of a large result.
 *
 * When the text fits within `maxChars`, it is returned unchanged. When it does
 * not, the result is `head + marker + tail` where the marker reports how many
 * chars were omitted, and the whole is capped at `maxChars`. Head and tail are
 * split roughly equally; the tail is capped at 1500 chars and the head takes
 * the remainder (both errors at the tail and command context at the head are
 * preserved).
 *
 * NOTE: callers pass 2000/3000 in practice. For tiny `maxChars` (< ~80, less
 * than the marker reserve), the budgets clamp to 0 and the preview collapses
 * to just the marker - still within the maxChars contract.
 */
export function buildPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Marker reserved space; leave room for head + marker + tail.
  const MARKER = (omitted: number): string => `\n... (省略 ${omitted} 字符，完整结果已落盘) ...\n`;
  // Worst-case marker length (omitted up to text.length digits). Overestimate
  // is safe; we recompute the real marker after splitting.
  const markerReserve = 80;
  // Clamp budgets to >= 0: if maxChars < markerReserve, both would go negative
  // and `slice(0, negative)` uses offset-from-end semantics (returns nearly the
  // whole text), violating the maxChars contract. Math.max(0, ...) collapses
  // them to empty slices instead, keeping the preview within bounds.
  const tailBudget = Math.max(0, Math.min(Math.floor((maxChars - markerReserve) / 2), 1500));
  const headBudget = Math.max(0, maxChars - tailBudget - markerReserve);

  const tail = text.slice(text.length - tailBudget);
  const head = text.slice(0, headBudget);

  // Recompute the real marker with the actual omitted count, then re-fit. The
  // real marker may be shorter than the reserve, so the final string may be
  // under maxChars - that's fine. We cap the tail a final time to guarantee the
  // total never exceeds maxChars regardless of marker length variance.
  const omitted = text.length - head.length - tail.length;
  const marker = MARKER(omitted);
  let preview = head + marker + tail;
  if (preview.length > maxChars) {
    // Trim the tail to absorb any marker-length overshoot.
    const overshoot = preview.length - maxChars;
    preview = head + marker + tail.slice(overshoot);
  }
  return preview;
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

  // Preview prefers stdout; falls back to stderr for error-only outputs.
  // V3-06: buildPreview keeps head + tail (errors live at the tail), replacing
  // the old head-only slice(0, N) that dropped stack traces.
  const sourceText = data.stdout || data.stderr || '';
  const preview = buildPreview(sourceText, previewChars);

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
