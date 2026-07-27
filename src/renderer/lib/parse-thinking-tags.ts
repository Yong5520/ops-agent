// Splits a message content string that may contain <think>...</think> tags
// into ordered thinking/text segments. Used for legacy messages saved before
// thinking was captured separately (they have <think> tags inline in content
// and no thinkingBlocks field), and as a render-time fallback.
//
// Non-streaming counterpart of the backend thinking-stream parser.
//
// Stray closers (qwen3.5-27b pattern): the opening <think> delimiter is emitted
// as a special token that never reaches the content stream, but </think> appears
// as ordinary text. When a </think> arrives with no preceding <think> opener, the
// text accumulated since the last boundary is treated as a thinking block.
// This mirrors the streaming parser's absorb behavior.

export type ContentSegment =
  | { kind: 'thinking'; content: string }
  | { kind: 'text'; content: string };

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export function parseThinkingTags(content: string): ContentSegment[] {
  if (!content) return [];

  const segments: ContentSegment[] = [];
  let buffer = '';
  let mode: 'text' | 'think' = 'text';
  let pos = 0;

  while (pos < content.length) {
    const openIdx = content.indexOf(OPEN_TAG, pos);
    const closeIdx = content.indexOf(CLOSE_TAG, pos);

    // Pick the nearest tag (either kind).
    let nextIdx: number;
    let nextIsOpen: boolean;
    if (openIdx === -1 && closeIdx === -1) {
      buffer += content.slice(pos);
      break;
    } else if (openIdx === -1) {
      nextIdx = closeIdx;
      nextIsOpen = false;
    } else if (closeIdx === -1) {
      nextIdx = openIdx;
      nextIsOpen = true;
    } else if (openIdx < closeIdx) {
      nextIdx = openIdx;
      nextIsOpen = true;
    } else {
      nextIdx = closeIdx;
      nextIsOpen = false;
    }

    buffer += content.slice(pos, nextIdx);
    pos = nextIdx;

    if (nextIsOpen) {
      if (mode === 'text') {
        // Opener: buffered text is real answer text.
        if (buffer) segments.push({ kind: 'text', content: buffer });
        buffer = '';
        mode = 'think';
      } else {
        // Already thinking (nested opener) - treat the opener as literal content.
        buffer += OPEN_TAG;
      }
      pos += OPEN_TAG.length;
    } else {
      // Closer.
      if (mode === 'think') {
        // Normal close: buffered text is reasoning.
        segments.push({ kind: 'thinking', content: buffer });
        buffer = '';
        mode = 'text';
      } else {
        // Stray closer (no opener): buffered text is reasoning (qwen pattern).
        if (buffer) {
          segments.push({ kind: 'thinking', content: buffer });
          buffer = '';
        }
        // Empty stray closer (nothing preceding) is dropped.
      }
      pos += CLOSE_TAG.length;
    }
  }

  // Flush remaining buffer.
  if (buffer) {
    if (mode === 'think') {
      segments.push({ kind: 'thinking', content: buffer });
    } else {
      segments.push({ kind: 'text', content: buffer });
    }
  }

  return segments;
}
