import type { CoreMessage } from 'ai';
import { estimateTokens } from '../context.js';

// Snip compact - remove old tool result contents when context is large.
//
// When the total token count exceeds SNIP_THRESHOLD_RATIO of the context
// window, replace the content of old tool messages (except the most recent
// ones) with a short snip marker that preserves the command and exit code
// for audit trail.
//
// This is the second tier of compaction (after microcompact, before full
// summary compression). It's cheaper than summarization because it doesn't
// require a model call.

const SNIP_THRESHOLD_RATIO = 0.4;
const RECENT_TOOL_MESSAGES_TO_KEEP = 10;

export interface SnipResult {
  messages: CoreMessage[];
  tokensFreed: number;
  snipCount: number;
}

export function snipCompactIfNeeded(messages: CoreMessage[], contextWindow: number): SnipResult {
  const currentTokens = estimateTokens(messages);
  const threshold = Math.floor(contextWindow * SNIP_THRESHOLD_RATIO);

  if (currentTokens <= threshold) {
    return { messages, tokensFreed: 0, snipCount: 0 };
  }

  // Find tool messages from oldest, snip them (keep recent ones)
  const snipped = [...messages];
  let tokensFreed = 0;
  let snipCount = 0;

  // Count tool messages from the end to know which to keep
  let toolMessageCount = 0;
  for (let i = snipped.length - 1; i >= 0; i--) {
    if (snipped[i].role === 'tool') {
      toolMessageCount++;
    }
  }

  let toolFromEnd = 0;
  for (let i = 0; i < snipped.length; i++) {
    if (currentTokens - tokensFreed <= threshold) break;

    const msg = snipped[i];
    if (msg.role !== 'tool') continue;

    // Track tool messages from the end
    toolFromEnd++;
    const recentToKeep = toolMessageCount - toolFromEnd + 1;
    if (recentToKeep <= RECENT_TOOL_MESSAGES_TO_KEEP) break;

    const originalContent =
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Create a short snip marker preserving key info
    const exitCode = extractExitCode(originalContent);
    const snipMarker = `[snipped: ${originalContent.length} chars${exitCode !== null ? `, exitCode=${exitCode}` : ''}]`;

    tokensFreed += Math.floor((originalContent.length - snipMarker.length) / 3);
    snipped[i] = {
      ...msg,
      content: snipMarker,
    } as unknown as CoreMessage;
    snipCount++;
  }

  return { messages: snipped, tokensFreed, snipCount };
}

function extractExitCode(content: string): number | null {
  const match = content.match(/"exitCode":(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
