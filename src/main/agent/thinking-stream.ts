// Thinking-stream parser.
//
// Splits reasoning/thinking content out of the model's text stream so the UI
// can render each thinking block as a separate collapsible "思考 Xm Xs" card
// instead of cramming it inline with the answer.
//
// Three input paths feed the same block state machine:
//   - feedTextDelta: text deltas that may contain <think>...</think> tags
//     (glm-5.2 and other OpenAI-compatible reasoning models embed thinking
//      in the content field this way).
//   - feedReasoningDelta: SDK reasoning_content deltas (providers that return
//      reasoning as a separate field). No tag parsing - appended directly.
//
// Tags may be split across deltas ("<thi" + "nk>"), so a carry buffer holds
// a trailing partial tag until the rest arrives. The parser is O(n) in total
// input size.
//
// Stray closers (qwen3.5-27b pattern): some thinking models emit the OPENING
// <think> delimiter as a special token that never reaches the content stream,
// but emit the CLOSING </think> as ordinary content text. When a </think> arrives in
// text mode with no preceding <think> opener, the text accumulated since the last
// boundary is reasoning - it was already streamed as answer text via onText,
// so we emit absorbPrecedingText (its length) on the new thinking block so the
// renderer retracts it from the text stream into the thinking card. Plain-text
// and proper open/close-tag models never trigger this (no retract, no flicker).

export interface ThinkingStreamCallbacks {
  /** Non-thinking text delta (the model's actual answer). */
  onText: (delta: string) => void;
  /** A new thinking block started. absorbPrecedingText, when > 0, means that
   *  many chars of previously-emitted onText text were actually reasoning and
   *  must be retracted from the visible text stream (moved into this block). */
  onThinkingOpen: (blockId: string, absorbPrecedingText?: number) => void;
  /** Thinking content delta for an open block. */
  onThinkingDelta: (blockId: string, delta: string) => void;
  /** A thinking block closed. durationMs = end - start. */
  onThinkingClose: (blockId: string, durationMs: number) => void;
}

export interface ThinkingStream {
  /** Feed a text delta that may contain <think>...</think> tags. */
  feedTextDelta(delta: string): void;
  /** Feed a reasoning-delta (no tag parsing). Opens a block if needed. */
  feedReasoningDelta(delta: string): void;
  /** Close any open thinking block and flush partial-tag buffers.
   *  Call before a tool call (so the tool attaches to the right thought)
   *  and at end of stream. */
  closeCurrent(): void;
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

export function createThinkingStream(
  callbacks: ThinkingStreamCallbacks,
  now: () => number = () => Date.now(),
): ThinkingStream {
  let mode: 'text' | 'think' = 'text';
  // Leftover from a previous delta that might be the start of a tag.
  let carry = '';
  let currentBlockId: string | null = null;
  let blockStartMs = 0;
  let counter = 0;
  // Text emitted via onText since the last tag boundary, retained so a stray
  // closer can retroactively move it into a thinking block (absorb). Reset on
  // every boundary (opener, closer, closeCurrent). Only meaningful in text mode.
  let pendingText = '';

  function emitText(delta: string): void {
    if (!delta) return;
    callbacks.onText(delta);
    pendingText += delta;
  }

  function openBlock(absorbPrecedingText?: number): string {
    counter++;
    const id = 'think-' + counter;
    currentBlockId = id;
    blockStartMs = now();
    callbacks.onThinkingOpen(id, absorbPrecedingText);
    return id;
  }

  function closeBlock(): void {
    if (currentBlockId === null) return;
    const durationMs = Math.max(0, now() - blockStartMs);
    callbacks.onThinkingClose(currentBlockId, durationMs);
    currentBlockId = null;
  }

  // Longest k (0 < k < tag.length) such that text ends with tag[0..k].
  // The tail of the buffer might be the beginning of a tag that hasn't
  // fully arrived yet - hold it back so it never leaks into visible text.
  function trailingPartial(text: string, tag: string): number {
    const max = Math.min(text.length, tag.length - 1);
    for (let k = max; k > 0; k--) {
      if (text.endsWith(tag.slice(0, k))) return k;
    }
    return 0;
  }

  // In text mode, a trailing substring could be the start of EITHER the open
  // or the close tag (a stray closer also reclassifies preceding text as
  // thinking), so we must hold back the longest prefix of either.
  function trailingPartialAny(text: string): number {
    return Math.max(
      trailingPartial(text, OPEN_TAG),
      trailingPartial(text, CLOSE_TAG),
    );
  }

  function feedTextDelta(delta: string): void {
    let input = carry + delta;
    carry = '';

    while (input.length > 0) {
      if (mode === 'text') {
        const idxOpen = input.indexOf(OPEN_TAG);
        const idxClose = input.indexOf(CLOSE_TAG);
        const useOpen = idxOpen !== -1 && (idxClose === -1 || idxOpen < idxClose);

        if (useOpen) {
          // Opening tag: text before it is real answer text. Emit + commit.
          emitText(input.slice(0, idxOpen));
          pendingText = '';
          input = input.slice(idxOpen + OPEN_TAG.length);
          if (currentBlockId === null) openBlock();
          mode = 'think';
        } else if (idxClose !== -1) {
          // Stray closer (no opener, or closer precedes a later opener):
          // text accumulated since the last boundary is reasoning. It was
          // already streamed as answer text - retract it into a thinking block.
          emitText(input.slice(0, idxClose));
          if (pendingText) {
            const id = openBlock(pendingText.length);
            callbacks.onThinkingDelta(id, pendingText);
            closeBlock();
          }
          pendingText = '';
          input = input.slice(idxClose + CLOSE_TAG.length);
          // Stay in text mode.
        } else {
          // No tag in this chunk - emit text, holding back any partial-tag tail.
          const p = trailingPartialAny(input);
          if (p > 0) {
            emitText(input.slice(0, input.length - p));
            carry = input.slice(input.length - p);
          } else {
            emitText(input);
          }
          input = '';
        }
      } else {
        const idx = input.indexOf(CLOSE_TAG);
        if (idx === -1) {
          const p = trailingPartial(input, CLOSE_TAG);
          if (p > 0) {
            const thinkDelta = input.slice(0, input.length - p);
            if (thinkDelta) callbacks.onThinkingDelta(currentBlockId!, thinkDelta);
            carry = input.slice(input.length - p);
          } else if (input) {
            callbacks.onThinkingDelta(currentBlockId!, input);
          }
          input = '';
        } else {
          const thinkDelta = input.slice(0, idx);
          if (thinkDelta) callbacks.onThinkingDelta(currentBlockId!, thinkDelta);
          input = input.slice(idx + CLOSE_TAG.length);
          closeBlock();
          mode = 'text';
        }
      }
    }
  }

  function feedReasoningDelta(delta: string): void {
    if (currentBlockId === null) openBlock();
    if (delta) callbacks.onThinkingDelta(currentBlockId!, delta);
  }

  function closeCurrent(): void {
    // Flush a buffered partial tag. In text mode it's just text; in think
    // mode it's thinking content (a partial closer is not a real closer).
    if (carry) {
      if (mode === 'think' && currentBlockId !== null) {
        callbacks.onThinkingDelta(currentBlockId, carry);
      } else {
        emitText(carry);
      }
      carry = '';
    }
    // Any pending text in text mode is committed answer text (already emitted
    // via onText). No closer arrived, so it is NOT reasoning.
    pendingText = '';
    closeBlock();
    mode = 'text';
  }

  return { feedTextDelta, feedReasoningDelta, closeCurrent };
}
