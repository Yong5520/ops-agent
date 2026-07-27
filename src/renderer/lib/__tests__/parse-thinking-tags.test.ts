import { describe, it, expect } from 'vitest';
import { parseThinkingTags } from '../parse-thinking-tags.js';

describe('parseThinkingTags', () => {
  it('returns empty for empty content', () => {
    expect(parseThinkingTags('')).toEqual([]);
  });

  it('returns a single text segment when there are no tags', () => {
    expect(parseThinkingTags('just an answer')).toEqual([
      { kind: 'text', content: 'just an answer' },
    ]);
  });

  it('splits a single think block from surrounding text', () => {
    const segs = parseThinkingTags('<think>reasoning</think>the answer');
    expect(segs).toEqual([
      { kind: 'thinking', content: 'reasoning' },
      { kind: 'text', content: 'the answer' },
    ]);
  });

  it('splits multiple think blocks', () => {
    const segs = parseThinkingTags('<think>a</think>mid<think>b</think>end');
    expect(segs).toEqual([
      { kind: 'thinking', content: 'a' },
      { kind: 'text', content: 'mid' },
      { kind: 'thinking', content: 'b' },
      { kind: 'text', content: 'end' },
    ]);
  });

  it('handles a leading think block with no preceding text', () => {
    const segs = parseThinkingTags('<think>only thinking</think>');
    expect(segs).toEqual([{ kind: 'thinking', content: 'only thinking' }]);
  });

  it('treats an unclosed <think> as a trailing thinking block', () => {
    const segs = parseThinkingTags('answer <think>unfinished');
    expect(segs).toEqual([
      { kind: 'text', content: 'answer ' },
      { kind: 'thinking', content: 'unfinished' },
    ]);
  });

  it('preserves newlines and whitespace in thinking content', () => {
    const segs = parseThinkingTags('<think>line1\nline2</think>done');
    expect(segs[0]).toEqual({ kind: 'thinking', content: 'line1\nline2' });
  });

  it('handles multi-line think blocks', () => {
    const content = '<think>\n我需要排查\n这两个问题\n</think>\n实际回答';
    const segs = parseThinkingTags(content);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.kind).toBe('thinking');
    expect(segs[1]).toEqual({ kind: 'text', content: '\n实际回答' });
  });
  it('treats a stray </think> (no opener) as a preceding thinking block (qwen)', () => {
    const segs = parseThinkingTags('用户想要查询主机代数</think>我来查询');
    expect(segs).toEqual([
      { kind: 'thinking', content: '用户想要查询主机代数' },
      { kind: 'text', content: '我来查询' },
    ]);
  });

  it('creates separate thinking blocks for repeated stray closers (qwen loop)', () => {
    const segs = parseThinkingTags('b1</think>b2</think>answer');
    expect(segs).toEqual([
      { kind: 'thinking', content: 'b1' },
      { kind: 'thinking', content: 'b2' },
      { kind: 'text', content: 'answer' },
    ]);
  });

  it('drops an empty stray closer (nothing preceding)', () => {
    const segs = parseThinkingTags('</think>answer');
    expect(segs).toEqual([{ kind: 'text', content: 'answer' }]);
  });

  it('mixes a proper block with a following stray closer', () => {
    const segs = parseThinkingTags('<think>r1</think>text</think>after');
    expect(segs).toEqual([
      { kind: 'thinking', content: 'r1' },
      { kind: 'thinking', content: 'text' },
      { kind: 'text', content: 'after' },
    ]);
  });

  it('does not mis-treat plain text as thinking when no closer is present', () => {
    const segs = parseThinkingTags('answer with a stray </thin reference but no real closer');
    expect(segs).toEqual([{ kind: 'text', content: 'answer with a stray </thin reference but no real closer' }]);
  });
});
