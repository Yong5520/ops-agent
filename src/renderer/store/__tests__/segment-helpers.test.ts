import { describe, it, expect } from 'vitest';
import { appendTextToSegments, retractTextFromSegments } from '../segment-helpers.js';
import type { TurnSegment } from '../agentStore.js';

// Build segments via the public appendTextToSegments helper so the test mirrors
// real usage (text deltas merge into one segment).
function text(content: string): TurnSegment {
  return { kind: 'text', content };
}
function thinking(blockId: string, content: string): TurnSegment {
  return { kind: 'thinking', blockId, content, streaming: true };
}
function tool(toolCallId: string): TurnSegment {
  return { kind: 'tool', toolCallId };
}

describe('appendTextToSegments', () => {
  it('extends the last text segment when it is text', () => {
    const segs = [text('hello')];
    const out = appendTextToSegments(segs, ' world');
    expect(out).toEqual([text('hello world')]);
  });

  it('starts a new text segment after a non-text segment', () => {
    const segs = [tool('t1')];
    const out = appendTextToSegments(segs, 'answer');
    expect(out).toEqual([tool('t1'), text('answer')]);
  });

  it('ignores empty deltas', () => {
    const segs = [text('hello')];
    expect(appendTextToSegments(segs, '')).toBe(segs);
  });
});

describe('retractTextFromSegments', () => {
  it('removes chars from the trailing text segment', () => {
    const segs = [text('answer')];
    expect(retractTextFromSegments(segs, 3)).toEqual([text('ans')]);
  });

  it('drops a segment that fully empties', () => {
    const segs = [tool('t1'), text('reasoning')];
    expect(retractTextFromSegments(segs, 9)).toEqual([tool('t1')]);
  });

  it('stops at a non-text segment (does not eat into tool output)', () => {
    const segs = [text('reasoning'), tool('t1')];
    // Nothing to retract from the trailing tool segment.
    expect(retractTextFromSegments(segs, 5)).toEqual([text('reasoning'), tool('t1')]);
  });

  it('retracts across multiple trailing text segments', () => {
    const segs = [tool('t1'), text('part2'), text('part1')];
    // 6 chars: 'part1' (5) + 1 from 'part2' -> 'part'
    expect(retractTextFromSegments(segs, 6)).toEqual([tool('t1'), text('part')]);
  });

  it('qwen stray-closer flow: reasoning retracts, answer remains', () => {
    // Simulate: reasoning streamed as text, then absorb=10 on thinking-open.
    const segs = appendTextToSegments([], '用户想要查询主机代数'); // 10 chars reasoning
    const retracted = retractTextFromSegments(segs, 10);
    expect(retracted).toEqual([]);
    // After the thinking card is appended (by the store), the answer delta lands
    // in a fresh text segment:
    const withAnswer = appendTextToSegments(
      [...retracted, thinking('think-1', '用户想要查询主机代数')],
      '我来查询',
    );
    expect(withAnswer).toEqual([thinking('think-1', '用户想要查询主机代数'), text('我来查询')]);
  });

  it('is a no-op for count <= 0', () => {
    const segs = [text('hello')];
    expect(retractTextFromSegments(segs, 0)).toBe(segs);
  });

  it('returns input unchanged when there is no trailing text', () => {
    const segs = [thinking('t1', 'x'), tool('t2')];
    expect(retractTextFromSegments(segs, 10)).toEqual(segs);
  });
});
