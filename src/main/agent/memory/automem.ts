import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../../utils/logger.js';

// Auto-memory (MEMORY.md) - persistent agent memory.
//
// Path: %APPDATA%/ops-agent/memory/MEMORY.md
// Limits: 200 lines / 25KB (truncated if exceeded)
//
// The agent can write to MEMORY.md via the update_memory tool.
// The content is injected into the system prompt as "Auto Memory" section.

const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 25_000;

export function getMemoryDir(): string {
  return path.join(app.getPath('userData'), 'memory');
}

export function getMemoryFilePath(): string {
  return path.join(getMemoryDir(), 'MEMORY.md');
}

// Load auto-memory content, truncated to limits.
export function loadAutoMemory(): string | null {
  const memPath = getMemoryFilePath();
  if (!fs.existsSync(memPath)) return null;

  try {
    let content = fs.readFileSync(memPath, 'utf-8');

    // Truncate to 200 lines
    const lines = content.split('\n');
    if (lines.length > MAX_MEMORY_LINES) {
      content =
        lines.slice(0, MAX_MEMORY_LINES).join('\n') +
        `\n\n[WARNING: MEMORY.md truncated at ${MAX_MEMORY_LINES} lines]`;
    }

    // Truncate to 25KB
    if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_BYTES) {
      content =
        content.slice(0, MAX_MEMORY_BYTES) +
        `\n\n[WARNING: MEMORY.md truncated at ${MAX_MEMORY_BYTES} bytes]`;
    }

    return content;
  } catch (err) {
    logger.error('[Memory] Failed to read MEMORY.md:', err);
    return null;
  }
}

// Append content to MEMORY.md with optional section header.
export function appendToMemory(content: string, section?: string): void {
  const memPath = getMemoryFilePath();
  const dir = path.dirname(memPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const entry = section
    ? `\n\n## ${section} (${timestamp})\n\n${content}`
    : `\n\n(${timestamp})\n${content}`;

  try {
    fs.appendFileSync(memPath, entry, 'utf-8');
    logger.info(`[Memory] Appended ${entry.length} chars to MEMORY.md`);
  } catch (err) {
    logger.error('[Memory] Failed to append to MEMORY.md:', err);
    throw err;
  }
}

// Write full content to MEMORY.md (replaces existing).
export function writeMemory(content: string): void {
  const memPath = getMemoryFilePath();
  const dir = path.dirname(memPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(memPath, content, 'utf-8');
  logger.info(`[Memory] Wrote ${content.length} chars to MEMORY.md`);
}
