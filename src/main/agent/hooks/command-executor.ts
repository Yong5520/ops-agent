// Command hook executor: runs a shell command, writes hook input JSON to stdin,
// parses stdout as JSON (HookOutput). Fail open: returns null on any error.

import { exec } from 'node:child_process';
import type { HookInput } from '../../../shared/types.js';
import type { HookOutput } from './engine.js';
import { logger } from '../../utils/logger.js';

export async function execCommandHook(
  command: string,
  input: HookInput,
  timeoutMs: number,
): Promise<HookOutput | null> {
  return new Promise((resolve) => {
    const child = exec(command, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      windowsHide: true,
    });

    let stdout = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.on('error', (err) => {
      logger.error(`[Hook] Command hook failed to start: ${err.message}`);
      resolve(null);
    });

    child.on('close', (_code, signal) => {
      // Timeout kills the process with SIGTERM
      if (signal === 'SIGTERM') {
        logger.warn(`[Hook] Command hook timed out after ${timeoutMs}ms`);
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(parsed as HookOutput);
      } catch {
        logger.warn(`[Hook] Command hook output was not valid JSON: ${trimmed.slice(0, 200)}`);
        resolve(null);
      }
    });

    // Write hook input JSON to stdin
    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch {
      // stdin write failure is non-fatal - some commands don't read stdin
    }
  });
}
