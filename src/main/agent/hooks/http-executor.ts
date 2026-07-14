// HTTP hook executor: sends a POST/GET request with hook input as JSON body,
// parses the response body as JSON (HookOutput). Fail open: returns null on
// any error (non-2xx, timeout, invalid JSON, network error).

import type { HookConfig, HookInput } from '../../../shared/types.js';
import type { HookOutput } from './engine.js';
import { logger } from '../../utils/logger.js';

export async function execHttpHook(
  config: HookConfig,
  input: HookInput,
): Promise<HookOutput | null> {
  const timeoutMs = config.timeoutMs ?? 30000;
  const method = config.method ?? 'POST';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.headers ?? {}),
  };

  try {
    const response = await fetch(config.url!, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(input) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      logger.warn(`[Hook] HTTP hook returned status ${response.status} ${response.statusText}`);
      return null;
    }

    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed) as HookOutput;
    } catch {
      logger.warn(`[Hook] HTTP hook response was not valid JSON: ${trimmed.slice(0, 200)}`);
      return null;
    }
  } catch (err) {
    const errName = (err as Error).name;
    if (errName === 'TimeoutError' || errName === 'AbortError') {
      logger.warn(`[Hook] HTTP hook timed out after ${timeoutMs}ms`);
    } else {
      logger.error(`[Hook] HTTP hook error: ${(err as Error).message}`);
    }
    return null;
  }
}
