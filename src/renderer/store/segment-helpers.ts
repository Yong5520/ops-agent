// Pure helpers for manipulating the agent turn's ordered segments array.
// Extracted from agentStore so they can be unit-tested without mocking the
// IPC-backed Zustand store. All functions are immutable (return new arrays).

import type { TurnSegment } from './agentStore.js';

// Append a text delta to the turn segments: extends the last segment if it's
// already text, otherwise starts a new text segment.
export function appendTextToSegments(segments: TurnSegment[], delta: string): TurnSegment[] {
  if (!delta) return segments;
  const last = segments[segments.length - 1];
  if (last && last.kind === 'text') {
    return [...segments.slice(0, -1), { ...last, content: last.content + delta }];
  }
  return [...segments, { kind: 'text', content: delta }];
}

// Retract the last `count` chars from the visible text stream (the reasoning
// that a stray closer revealed was thinking, not answer). Removes chars from
// the trailing text segment(s) only; stops at a non-text segment (tool/thinking)
// so a stray closer never eats into earlier tool output or thinking cards.
// Drops a segment if it empties. Returns a new array.
//
// Used by the thinking-open absorb signal (qwen3.5-27b pattern, where the
// opening delimiter never reaches the content stream): reasoning streamed as
// answer text first, then retracted into a thinking card on the closing tag.
export function retractTextFromSegments(segments: TurnSegment[], count: number): TurnSegment[] {
  if (count <= 0) return segments;
  let remaining = count;
  const out = [...segments];
  while (remaining > 0 && out.length > 0) {
    const last = out[out.length - 1];
    if (last.kind !== 'text') break;
    if (last.content.length <= remaining) {
      remaining -= last.content.length;
      out.pop();
    } else {
      out[out.length - 1] = { ...last, content: last.content.slice(0, -remaining) };
      remaining = 0;
    }
  }
  return out;
}
