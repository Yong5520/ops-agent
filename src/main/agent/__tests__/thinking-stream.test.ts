import { describe, it, expect } from 'vitest';
import { createThinkingStream } from '../thinking-stream.js';

// Collects callback events into arrays for assertions. Also models the
// renderer's text-segment behavior: onText appends to netText, and an
// absorbPrecedingText on a thinking-open retracts that many chars from
// netText (the reasoning moves from the text stream into a thinking card).
function makeCollector() {
  const events: Array<
    | { type: 'text'; delta: string }
    | { type: 'open'; id: string; absorb?: number }
    | { type: 'think'; id: string; delta: string }
    | { type: 'close'; id: string; durationMs: number }
  > = [];
  let clock = 1000;
  let netText = '';
  const stream = createThinkingStream(
    {
      onText: (delta) => {
        netText += delta;
        events.push({ type: 'text', delta });
      },
      onThinkingOpen: (id, absorbPrecedingText) => {
        if (absorbPrecedingText && absorbPrecedingText > 0) {
          netText = netText.slice(0, -absorbPrecedingText);
        }
        events.push({ type: 'open', id, absorb: absorbPrecedingText });
      },
      onThinkingDelta: (id, delta) => events.push({ type: 'think', id, delta }),
      onThinkingClose: (id, durationMs) => events.push({ type: 'close', id, durationMs }),
    },
    () => clock,
  );
  return {
    stream,
    events,
    netText: () => netText,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// Net visible text after absorbs are applied: sums text deltas, then retracts
// any chars that a thinking-open's absorbPrecedingText pulled out of the text
// stream (the reasoning moved into a thinking card). For tests with no absorb
// this is identical to the raw text join.
function netTextOf(events: Array<{ type: string; delta?: string; absorb?: number }>): string {
  let text = '';
  for (const e of events) {
    if (e.type === 'text' && e.delta !== undefined) {
      text += e.delta;
    } else if (e.type === 'open' && e.absorb && e.absorb > 0) {
      text = text.slice(0, -e.absorb);
    }
  }
  return text;
}

describe('thinking-stream parser', () => {
  it('passes plain text through as text with no thinking events', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('hello world');
    stream.closeCurrent();

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('hello world');
    expect(events.some((e) => e.type === 'open')).toBe(false);
  });

  it('splits a single <think> block from surrounding text', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('<think>reasoning here</think>the answer');

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('the answer');
    expect(think).toBe('reasoning here');

    const opens = events.filter((e) => e.type === 'open');
    const closes = events.filter((e) => e.type === 'close');
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect(opens[0]!.id).toBe(closes[0]!.id);
  });

  it('handles tags split across multiple deltas', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('before<thi');
    stream.feedTextDelta('nk>hello</thi');
    stream.feedTextDelta('nk>after');

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('beforeafter');
    expect(think).toBe('hello');
  });

  it('handles the opening tag split right at the angle bracket', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('x');
    stream.feedTextDelta('<');
    stream.feedTextDelta('think>');
    stream.feedTextDelta('thought');
    stream.feedTextDelta('</think>');
    stream.feedTextDelta('y');

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('xy');
    expect(think).toBe('thought');
  });

  it('emits multiple thinking blocks separately', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('<think>a</think>mid<think>b</think>end');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('ab');
    const opens = events.filter((e) => e.type === 'open');
    const closes = events.filter((e) => e.type === 'close');
    expect(opens).toHaveLength(2);
    expect(closes).toHaveLength(2);
    expect(opens[0]!.id).not.toBe(opens[1]!.id);
    // text between/around blocks preserved
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('midend');
  });

  it('closes an unclosed thinking block on closeCurrent', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('<think>unfinished');
    // no </think> yet
    expect(events.some((e) => e.type === 'close')).toBe(false);

    stream.closeCurrent();
    const closes = events.filter((e) => e.type === 'close');
    expect(closes).toHaveLength(1);
    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('unfinished');
  });

  it('closeCurrent before a tool call flushes partial closer as thinking content', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('<think>thinking</thi'); // partial closer at end
    stream.closeCurrent();
    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    // The partial "</thi" is NOT a real closer, so it must be preserved as thinking
    expect(think).toBe('thinking</thi');
  });

  it('closeCurrent flushes a partial opener in text mode as text', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('hello <thi'); // partial opener at end
    stream.closeCurrent();
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('hello <thi');
    expect(events.some((e) => e.type === 'open')).toBe(false);
  });

  it('reports duration as end minus start time', () => {
    const { stream, events, advance } = makeCollector();
    stream.feedTextDelta('<think>thinking');
    advance(2500);
    stream.feedTextDelta('</think>');

    const close = events.find((e) => e.type === 'close');
    expect(close).toBeDefined();
    expect((close as { durationMs: number }).durationMs).toBe(2500);
  });

  it('feedReasoningDelta appends to a thinking block without tag parsing', () => {
    const { stream, events } = makeCollector();
    stream.feedReasoningDelta('reason part 1 ');
    stream.feedReasoningDelta('reason part 2');
    stream.closeCurrent();

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('reason part 1 reason part 2');
    expect(events.filter((e) => e.type === 'open')).toHaveLength(1);
  });

  it('mixes reasoning-delta and <think> text deltas into separate blocks', () => {
    const { stream, events } = makeCollector();
    stream.feedReasoningDelta('via reasoning_content');
    stream.closeCurrent();
    stream.feedTextDelta('<think>via tag</think>answer');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('via reasoning_contentvia tag');
    expect(text).toBe('answer');
    expect(events.filter((e) => e.type === 'open')).toHaveLength(2);
  });

  it('does not emit a tag fragment as visible text when opener arrives late', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('text <think'); // looks like opener start
    stream.feedTextDelta('>now thinking</think> done');
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    // "<think" must never leak into visible text
    expect(text).not.toContain('think');
    expect(text).toBe('text  done');
    expect(think).toBe('now thinking');
  });

  // qwen3.5-27b and similar thinking models emit the opening <think> delimiter as a
  // special token that never reaches the content stream, but emit </think> as
  // regular content text. The parser must treat a </think> that arrives with no
  // preceding <think> opener as the end of a reasoning block: the text accumulated
  // since the last boundary is reasoning, and must be moved out of the visible
  // text stream into a thinking block (signalled via absorbPrecedingText on open).
  it('treats a stray </think> (no opener) as the end of a reasoning block', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('用户想要查询主机代数</think>');
    stream.feedTextDelta('我来查询');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    // Reasoning moved into a thinking block; visible text is only the answer.
    expect(think).toBe('用户想要查询主机代数');
    expect(netTextOf(events)).toBe('我来查询');

    const opens = events.filter((e) => e.type === 'open');
    expect(opens).toHaveLength(1);
    // The reasoning (10 chars) was emitted as text first, then absorbed.
    expect((opens[0] as { absorb?: number }).absorb).toBe(10);
  });

  it('plain text with no tags is unaffected (no absorb, no thinking)', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('just a normal answer with no tags');
    stream.closeCurrent();

    expect(netTextOf(events)).toBe('just a normal answer with no tags');
    expect(events.some((e) => e.type === 'open')).toBe(false);
    // No thinking-open carried an absorb (no text was ever retracted).
    expect(events.some((e) => e.type === 'open' && e.absorb)).toBe(false);
  });

  it('proper <think> open-close tags do not trigger absorb (glm-style)', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('<think>reasoning</think>answer');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('reasoning');
    expect(netTextOf(events)).toBe('answer');
    // Proper opener => no absorb (text before opener was real answer text).
    const opens = events.filter((e) => e.type === 'open');
    expect(opens).toHaveLength(1);
    expect((opens[0] as { absorb?: number }).absorb).toBeUndefined();
  });

  it('handles a stray closer split across deltas', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('rea');
    stream.feedTextDelta('soning</thi'); // partial closer tail
    stream.feedTextDelta('nk>answer'); // closer completion + answer

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('reasoning');
    expect(netTextOf(events)).toBe('answer');
    const opens = events.filter((e) => e.type === 'open');
    expect((opens[0] as { absorb?: number }).absorb).toBe(9);
  });

  it('drops an empty stray closer (nothing preceding) with no thinking block', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('</think>answer');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('');
    expect(netTextOf(events)).toBe('answer');
    expect(events.some((e) => e.type === 'open')).toBe(false);
  });

  it('creates separate thinking blocks for repeated stray closers (qwen loop)', () => {
    const { stream, events } = makeCollector();
    stream.feedTextDelta('b1</think>');
    stream.feedTextDelta('b2</think>');
    stream.feedTextDelta('answer');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('b1b2');
    expect(netTextOf(events)).toBe('answer');
    expect(events.filter((e) => e.type === 'open')).toHaveLength(2);
  });

  it('absorbs a stray closer that follows a proper thinking block', () => {
    const { stream, events } = makeCollector();
    // proper block, then stray closer converts the following text to thinking
    stream.feedTextDelta('<think>r1</think>text</think>after');

    const think = events
      .filter((e) => e.type === 'think')
      .map((e) => e.delta)
      .join('');
    expect(think).toBe('r1text');
    expect(netTextOf(events)).toBe('after');
    expect(events.filter((e) => e.type === 'open')).toHaveLength(2);
    // First block: proper opener, no absorb. Second block: stray, absorbs "text".
    const opens = events.filter((e) => e.type === 'open');
    expect((opens[0] as { absorb?: number }).absorb).toBeUndefined();
    expect((opens[1] as { absorb?: number }).absorb).toBe(4);
  });
});
