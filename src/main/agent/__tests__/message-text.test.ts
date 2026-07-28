// Unit tests for the message-persistence helpers (message-text.ts).
//
// These guards the orphan-task bug: a turn whose accumulated text is only
// whitespace (e.g. "\n\n" appended by conclusion-nudge rounds that never
// elicited a real answer) must NOT be persisted as a real assistant message.
// A blank/whitespace message looks like an unfinished turn, so the model
// treats the NEXT user question (even an unrelated one like "用了多少 token")
// as a continuation of the prior pending task and resumes running host commands.

import { describe, it, expect } from 'vitest';
import { hasSubstantiveText, EMPTY_RESPONSE_MARKER } from '../message-text.js';

describe('hasSubstantiveText', () => {
  it('returns false for an empty string', () => {
    expect(hasSubstantiveText('')).toBe(false);
  });

  it('returns false for whitespace-only strings (the orphan-task bug values)', () => {
    // "\n\n" is the exact value the bug produced (nudge appends "\n\n" to
    // fullText, then the model never adds real text).
    expect(hasSubstantiveText('\n\n')).toBe(false);
    expect(hasSubstantiveText('   ')).toBe(false);
    expect(hasSubstantiveText('\t\n \r')).toBe(false);
  });

  it('returns true for strings with visible content', () => {
    expect(hasSubstantiveText('hello')).toBe(true);
    expect(hasSubstantiveText('  done  ')).toBe(true);
    expect(hasSubstantiveText('\n结论\n')).toBe(true);
  });
});

describe('EMPTY_RESPONSE_MARKER', () => {
  it('is itself substantive so it never re-triggers the blank path', () => {
    // The marker replaces a blank turn. If the marker itself were
    // whitespace-only, hasSubstantiveText(marker) would be false and the
    // persistence code would loop / fall through again. It must be real text.
    expect(hasSubstantiveText(EMPTY_RESPONSE_MARKER)).toBe(true);
  });
});
