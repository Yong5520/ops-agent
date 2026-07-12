import type { CoreMessage } from 'ai';

// Microcompact - per-message tool result truncation.
//
// When a single tool result exceeds MAX_TOOL_RESULT_CHARS, replace the middle
// with a placeholder, keeping the head and tail lines. This preserves the
// command + exit code context while releasing the bulk of the output.
//
// Error outputs (exitCode != 0) are NEVER compacted - they contain diagnostic
// information that must be preserved for debugging.

const MAX_TOOL_RESULT_CHARS = 4000;
const HEAD_LINES = 20;
const TAIL_LINES = 20;

export interface MicrocompactResult {
  messages: CoreMessage[];
  compactedCount: number;
  tokensSaved: number;
}

export function microcompactToolResults(messages: CoreMessage[]): MicrocompactResult {
  let compactedCount = 0;
  let tokensSaved = 0;

  const result = messages.map((msg) => {
    // Only compact tool messages (role: 'tool')
    if (msg.role !== 'tool') return msg;

    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.length <= MAX_TOOL_RESULT_CHARS) return msg;

    // Don't compact error outputs - preserve for debugging
    if (isErrorOutput(content)) return msg;

    const lines = content.split('\n');
    if (lines.length <= HEAD_LINES + TAIL_LINES) return msg;

    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(-TAIL_LINES);
    const omitted = lines.length - HEAD_LINES - TAIL_LINES;
    const compacted = [...head, `... (omitted ${omitted} lines) ...`, ...tail].join('\n');

    compactedCount++;
    tokensSaved += Math.floor((content.length - compacted.length) / 3);

    return {
      ...msg,
      content: compacted,
    } as unknown as CoreMessage;
  });

  return { messages: result, compactedCount, tokensSaved };
}

// Check if the output contains an error indicator (exit code != 0)
function isErrorOutput(content: string): boolean {
  // Look for common error patterns in tool output
  if (content.includes('"exitCode":0') || content.includes('"exit_code":0')) return false;
  if (content.includes('"exitCode":') && !content.includes('"exitCode":0')) return true;
  if (content.includes('"exit_code":') && !content.includes('"exit_code":0')) return true;
  return false;
}
