// Helpers for deciding whether an accumulated assistant turn has real content.
//
// The agent loop accumulates the model's text into `fullText` across sub-rounds
// (tool-call rounds + conclusion nudges). A nudge round appends "\n\n" to
// fullText (see loop.ts) before re-running; if the model then finishes without
// adding any real text, fullText ends up whitespace-only like "\n\n".
//
// Persisting that whitespace as a real assistant message is a subtle but
// serious bug: the blank turn reads as unfinished work, so on the NEXT user
// question the model treats the prior (still-"pending") task as in-progress
// and resumes running host commands - even when the new question is entirely
// unrelated (e.g. "当前使用了多少的 token了"). See the gpu-16-36 incident.
//
// hasSubstantiveText lets the persistence path treat whitespace-only turns as
// empty, so they fall through to a marker that properly closes the turn.

/**
 * True iff `text` contains at least one non-whitespace character.
 * Whitespace-only strings ("\n", "   ", "\n\n") return false - they must not
 * be persisted as real assistant messages.
 */
export function hasSubstantiveText(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * Marker persisted in place of a turn that produced only whitespace, so the
 * turn is explicitly closed in conversation history (preventing orphan-task
 * resumption on the next question). It is itself substantive so it never
 * re-triggers the blank path.
 */
export const EMPTY_RESPONSE_MARKER = '（本轮未生成有效回复，已结束本轮）';
