import { describe, it, expect } from 'vitest';
import { detectRepetition } from '../loop-repetition-guard.js';

// detectRepetition inspects the tail of the assistant's streamed output for a
// short phrase that repeats consecutively >= N times - the signature of a
// thinking model (e.g. qwen3.5-27b) stuck re-stating the same intention without
// acting. Returns the detected phrase + repeat count, or null.

describe('detectRepetition', () => {
  it('returns null for normal, non-repetitive text', () => {
    expect(detectRepetition('让我先查看主机列表。\n好的，已找到 3 台主机。')).toBeNull();
  });

  it('returns null for a phrase repeated only twice (below threshold)', () => {
    const text = '我来查询。\n我来查询。';
    expect(detectRepetition(text)).toBeNull();
  });

  it('detects the same phrase repeated 3 times consecutively', () => {
    const text = [
      '我来帮你查询主机的 PCIe 代数信息。首先让我列出可用的主机，然后对选中的主机执行命令来查看 PCIe 设备及其代数。',
      '我来帮你查询主机的 PCIe 代数信息。首先让我列出可用的主机，然后对选中的主机执行命令来查看 PCIe 设备及其代数。',
      '我来帮你查询主机的 PCIe 代数信息。首先让我列出可用的主机，然后对选中的主机执行命令来查看 PCIe 设备及其代数。',
    ].join('\n\n');
    const result = detectRepetition(text);
    expect(result).not.toBeNull();
    expect(result?.repeatCount).toBeGreaterThanOrEqual(3);
    expect(result?.phrase.length).toBeGreaterThan(8);
  });

  it('detects repetition separated by stray thinking closers (qwen pattern)', () => {
    // Mirrors the real a721de0d content: reasoning + closer + repeat.
    const block = '用户想要查询主机的 PCIe 代数。我需要先列出可用的主机，然后对选中的主机执行命令来查看 PCIe 设备及其代数。';
    const text = [block, block, block, '我来帮你查询。'].join('\n\n');
    const result = detectRepetition(text);
    expect(result).not.toBeNull();
    expect(result?.repeatCount).toBeGreaterThanOrEqual(3);
  });

  it('ignores very short phrases (under min length)', () => {
    // "嗯" repeated is not a meaningful loop signal.
    expect(detectRepetition('嗯\n嗯\n嗯')).toBeNull();
  });

  it('requires the repeats to be near the tail (recent), not anywhere in history', () => {
    // A phrase repeated early, then a long stretch of different text, should
    // NOT trigger (the model moved on).
    const block = '某段重复的过渡文本内容在这里。';
    const text = [block, block, block, '接下来执行实际命令并输出大量不同的诊断结果内容...' + 'x'.repeat(500)].join('\n');
    // The 500-char tail dominates, so the repeated block is not the recent tail.
    // detectRepetition looks at a bounded tail window, so early repeats are out of scope.
    expect(detectRepetition(text)).toBeNull();
  });

  it('handles empty / short input', () => {
    expect(detectRepetition('')).toBeNull();
    expect(detectRepetition('短')).toBeNull();
  });
});
