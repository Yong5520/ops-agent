// Unit tests for the network-device pager handler (Phase 1 of the
// interactive-paging fix).
//
// Network device CLIs (Huawei VRP, Cisco IOS, H3C, ...) paginate output with a
// `---- More ----` prompt and block waiting for a keypress. pager.ts owns:
//   - detectPagerPrompt: tail-anchored, chunk-safe detection of the prompt
//   - stripPagerArtifacts: remove prompt lines so the model sees clean output
//   - createPagerAdvancer: per-exec state machine that sends an advance key
//     (Space) on each prompt, with a runaway cap and double-send guard
import { describe, it, expect, vi } from 'vitest';
import {
  detectPagerPrompt,
  stripPagerArtifacts,
  stripAnsi,
  createPagerAdvancer,
  PAGER_ADVANCE_KEY,
  MAX_PAGER_ADVANCES,
} from '../pager.js';

describe('detectPagerPrompt', () => {
  it('detects Huawei VRP "  ---- More ----" at the buffer tail', () => {
    expect(detectPagerPrompt('line1\nline2\n  ---- More ----')).toBe(true);
  });

  it('detects Cisco IOS "--More--"', () => {
    expect(detectPagerPrompt('Cisco IOS Software\n--More--')).toBe(true);
  });

  it('detects "-- More --" variant', () => {
    expect(detectPagerPrompt('output\n-- More --')).toBe(true);
  });

  it('detects VRP prompt with a trailing percentage', () => {
    expect(detectPagerPrompt('line\n  ---- More ----  45%')).toBe(true);
  });

  it('detects less/more "(END)" marker', () => {
    expect(detectPagerPrompt('some text\n(END)')).toBe(true);
  });

  it('detects the prompt even with trailing ANSI escapes (PTY mode)', () => {
    // PTY devices redraw the prompt with ANSI clear-to-end-of-line sequences.
    expect(detectPagerPrompt('line\n  ---- More ----\x1b[K')).toBe(true);
  });

  it('detects the prompt when followed by trailing CR/whitespace', () => {
    expect(detectPagerPrompt('line\n  ---- More ----\r')).toBe(true);
    expect(detectPagerPrompt('line\n  ---- More ----   ')).toBe(true);
  });

  it('returns false for normal output that does not end in a prompt', () => {
    expect(detectPagerPrompt('total 0\nfile1\nfile2\n')).toBe(false);
    expect(detectPagerPrompt('FutureMatrix S6735 uptime is 148 weeks\n')).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(detectPagerPrompt('')).toBe(false);
  });

  it('does not match a "More" buried mid-buffer (only the tail matters)', () => {
    // A prompt earlier in the stream that the device already advanced past must
    // not re-trigger: only a prompt at the current tail means "blocked now".
    expect(detectPagerPrompt('  ---- More ----\nthis is the next page, no prompt')).toBe(false);
  });
});

describe('stripPagerArtifacts', () => {
  it('removes a "  ---- More ----" line, joining the surrounding content', () => {
    const out = stripPagerArtifacts('line1\nline2\n  ---- More ----\nline3\nline4\n');
    expect(out).toBe('line1\nline2\nline3\nline4\n');
  });

  it('removes Cisco "--More--" with no surrounding newline', () => {
    expect(stripPagerArtifacts('A--More--B')).toBe('AB');
  });

  it('removes a VRP prompt with a trailing percentage and no newline', () => {
    expect(stripPagerArtifacts('  ---- More ----  45%')).toBe('');
  });

  it('removes "(END)" markers', () => {
    expect(stripPagerArtifacts('text\n(END)\nmore')).toBe('text\nmore');
  });

  it('leaves normal output untouched', () => {
    const normal = 'total 0\ndrwxr-xr-x file1\n-rw-r--r-- file2\n';
    expect(stripPagerArtifacts(normal)).toBe(normal);
  });

  it('strips multiple prompts across a multi-page capture', () => {
    const raw = 'p1\n  ---- More ----\np2\n  ---- More ----\np3\n';
    expect(stripPagerArtifacts(raw)).toBe('p1\np2\np3\n');
  });
});

describe('stripAnsi', () => {
  it('removes CSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m text')).toBe('red text');
  });

  it('removes clear-to-end-of-line sequences emitted by pagers', () => {
    expect(stripAnsi('more\x1b[K')).toBe('more');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text\n')).toBe('plain text\n');
  });
});

describe('constants', () => {
  it('uses Space as the advance key', () => {
    expect(PAGER_ADVANCE_KEY).toBe(' ');
  });

  it('sets a positive runaway cap', () => {
    expect(MAX_PAGER_ADVANCES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_PAGER_ADVANCES)).toBe(true);
  });
});

describe('createPagerAdvancer', () => {
  it('sends one advance when a chunk ends in a prompt', () => {
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance });
    expect(advancer.consumeChunk('line1\n  ---- More ----')).toBe(true);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(advancer.getAdvanceCount()).toBe(1);
  });

  it('does not send when output has no prompt', () => {
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance });
    expect(advancer.consumeChunk('line1\nline2\n')).toBe(false);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(advancer.getAdvanceCount()).toBe(0);
  });

  it('sends one advance per page across multiple pages', () => {
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance });
    advancer.consumeChunk('p1\n  ---- More ----');
    advancer.consumeChunk('p2\n  ---- More ----');
    advancer.consumeChunk('p3\n');
    expect(onAdvance).toHaveBeenCalledTimes(2);
    expect(advancer.getAdvanceCount()).toBe(2);
  });

  it('detects a prompt split across two chunks', () => {
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance });
    // First chunk ends mid-prompt; no advance yet.
    expect(advancer.consumeChunk('line\n  ---- Mor')).toBe(false);
    // Second chunk completes the prompt -> advance fires.
    expect(advancer.consumeChunk('e ----')).toBe(true);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('does not double-send for the same prompt while waiting for a response', () => {
    // After sending Space the device blocks until it processes the key. The next
    // data to arrive is the device's response (the next page); a page with no
    // prompt must not trigger another send.
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance });
    advancer.consumeChunk('line\n  ---- More ----'); // send #1
    advancer.consumeChunk('next page, no prompt\n'); // response, no prompt
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('respects the maxAdvances cap', () => {
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance, maxAdvances: 3 });
    // Three pages ending in a prompt -> three advances (cap not yet hit).
    advancer.consumeChunk('p1\n  ---- More ----');
    advancer.consumeChunk('p2\n  ---- More ----');
    advancer.consumeChunk('p3\n  ---- More ----');
    // Fourth page ending in a prompt -> cap hit, no advance.
    advancer.consumeChunk('p4\n  ---- More ----');
    advancer.consumeChunk('p5\n');
    expect(onAdvance).toHaveBeenCalledTimes(3);
    expect(advancer.getAdvanceCount()).toBe(3);
  });

  it('defaults maxAdvances to MAX_PAGER_ADVANCES (2000)', () => {
    const onAdvance = vi.fn();
    const advancer = createPagerAdvancer({ onAdvance });
    advancer.consumeChunk('p\n  ---- More ----');
    expect(advancer.getAdvanceCount()).toBe(1);
    expect(MAX_PAGER_ADVANCES).toBe(2000);
  });
});
