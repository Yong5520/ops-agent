import { describe, it, expect } from 'vitest';
import { evaluateStallDecision } from '../stall-detection.js';
import type { StallDecisionInput } from '../stall-detection.js';

// Same constants as loop.ts
const TRANSITION_PATTERN = /让我|我来|继续|我先|接下来|下一步/;
const TEXT_THRESHOLD = 150;
const MAX_NUDGE_ROUNDS = 2;

function makeInput(overrides: Partial<StallDecisionInput> = {}): StallDecisionInput {
  return {
    finishReason: 'stop',
    toolCallCount: 3,
    roundText: '',
    nudgeCount: 0,
    maxNudgeRounds: MAX_NUDGE_ROUNDS,
    transitionPattern: TRANSITION_PATTERN,
    textThreshold: TEXT_THRESHOLD,
    ...overrides,
  };
}

describe('evaluateStallDecision', () => {
  describe('substantive stop (the fix - no over-action)', () => {
    it('does NOT nudge when model produced substantive text (>150 chars) after tool calls', () => {
      const substantiveText =
        '## 诊断结论\n\n问题已明确定位：CUDA 安装包文件下载不完整（被截断）。' +
        '文件大小为 1.5 GB，而 NVIDIA 官方应为 ~4.3 GB，当前仅约 35%。' +
        'MD5 校验不符，/tmp 空间充足（1.6 TB），排除磁盘不足。' +
        '文件头正常但文件末尾无正常终止，说明在传输中被截断。' +
        '建议重新下载完整的安装包并验证文件大小后再执行安装。';
      // Verify this is > 150 chars
      expect(substantiveText.length).toBeGreaterThan(150);

      const result = evaluateStallDecision(makeInput({ roundText: substantiveText }));
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('substantive_stop');
    });

    it('does NOT nudge for long text that happens to contain a transition word', () => {
      // >150 chars with a transition word still = substantive (not a stall)
      const longTextWithTransition =
        '让我检查一下磁盘空间。根分区使用 50%，共 100G，剩余 50G 可用。' +
        '内存使用正常，8 核 CPU 负载较低。systemd 无失败服务。' +
        '内核日志无近期错误。综合来看，系统资源充足，问题不在磁盘空间。' +
        '建议检查安装包完整性，确认文件大小和 MD5 校验值是否匹配官方发布版本。' +
        '如果文件不完整，需要重新下载完整的安装包后再执行安装操作。';
      expect(longTextWithTransition.length).toBeGreaterThan(150);

      const result = evaluateStallDecision(makeInput({ roundText: longTextWithTransition }));
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('substantive_stop');
    });
  });

  describe('transition stall (still nudges for conclusion)', () => {
    it('nudges when text is short (<150 chars) with transition words', () => {
      const shortTransition = '让我继续检查磁盘使用情况。';
      expect(shortTransition.length).toBeLessThan(150);

      const result = evaluateStallDecision(makeInput({ roundText: shortTransition }));
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toBe('transition_stall');
    });

    it('nudges for "我来收集信息" transition phrase', () => {
      const result = evaluateStallDecision(makeInput({ roundText: '我来收集更多信息。' }));
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toBe('transition_stall');
    });

    it('nudges for "下一步" transition phrase', () => {
      const result = evaluateStallDecision(makeInput({ roundText: '下一步检查网络配置。' }));
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toBe('transition_stall');
    });
  });

  describe('empty stall (still nudges for conclusion)', () => {
    it('nudges when model produced 0 chars after tool calls', () => {
      const result = evaluateStallDecision(makeInput({ roundText: '' }));
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toBe('empty_stall');
    });
  });

  describe('nudge exhaustion', () => {
    it('does NOT nudge when transition stall but max rounds reached', () => {
      const result = evaluateStallDecision(
        makeInput({
          roundText: '让我继续检查。',
          nudgeCount: MAX_NUDGE_ROUNDS,
        }),
      );
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('nudge_exhausted');
    });

    it('does NOT nudge when empty stall but max rounds reached', () => {
      const result = evaluateStallDecision(
        makeInput({
          roundText: '',
          nudgeCount: MAX_NUDGE_ROUNDS,
        }),
      );
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('nudge_exhausted');
    });
  });

  describe('non-stall conditions (no nudge)', () => {
    it('does NOT nudge when finishReason is not stop', () => {
      const result = evaluateStallDecision(makeInput({ finishReason: 'length' }));
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('not_stop');
    });

    it('does NOT nudge when no tool calls were made', () => {
      const result = evaluateStallDecision(
        makeInput({ toolCallCount: 0, roundText: '分析完成，一切正常。' }),
      );
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('no_tools');
    });

    it('does NOT nudge on finishReason=tool-calls', () => {
      const result = evaluateStallDecision(makeInput({ finishReason: 'tool-calls' }));
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('not_stop');
    });
  });

  describe('boundary cases', () => {
    it('nudges for text just under threshold with transition word', () => {
      const text = '让我' + 'x'.repeat(147); // 149 chars total
      expect(text.length).toBe(149);
      const result = evaluateStallDecision(makeInput({ roundText: text }));
      expect(result.shouldNudge).toBe(true);
      expect(result.reason).toBe('transition_stall');
    });

    it('does NOT nudge for text at exactly threshold without transition word', () => {
      const text = 'x'.repeat(150); // exactly 150 chars, no transition
      expect(text.length).toBe(150);
      const result = evaluateStallDecision(makeInput({ roundText: text }));
      // 150 is NOT < 150, so isTransitionStall is false
      // 150 is NOT === 0, so isEmptyStall is false
      // -> substantive_stop
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('substantive_stop');
    });

    it('does NOT nudge for 1-char text without transition word', () => {
      // 1 char, < 150, but no transition word -> NOT a transition stall
      // Not empty either -> substantive_stop
      const result = evaluateStallDecision(makeInput({ roundText: '!' }));
      expect(result.shouldNudge).toBe(false);
      expect(result.reason).toBe('substantive_stop');
    });
  });
});
