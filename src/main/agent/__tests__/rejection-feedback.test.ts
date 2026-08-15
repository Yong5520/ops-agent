import { describe, it, expect } from 'vitest';
import { buildRejectionFeedback, WIND_DOWN_DIRECTIVE } from '../rejection-feedback.js';

describe('buildRejectionFeedback', () => {
  it('includes the rejected command', () => {
    const msg = buildRejectionFeedback({ command: 'rm -rf /var/log/nginx' });
    expect(msg).toContain('rm -rf /var/log/nginx');
  });

  it('includes the ask_user directive by default', () => {
    const msg = buildRejectionFeedback({ command: 'ls' });
    expect(msg).toContain('ask_user');
  });

  it('always tells the model not to retry the same/similar command', () => {
    const msg = buildRejectionFeedback({ command: 'ls' });
    expect(msg).toContain('请勿重复尝试');
  });

  it('includes the user-provided reason when given', () => {
    const msg = buildRejectionFeedback({
      command: 'systemctl restart nginx',
      userReason: '不要重启生产服务',
    });
    expect(msg).toContain('不要重启生产服务');
    expect(msg).toContain('用户说明');
  });

  it('does not include the reason line when no reason is provided', () => {
    const msg = buildRejectionFeedback({ command: 'ls' });
    expect(msg).not.toContain('用户说明');
  });

  it('includes the stop directive when stopRequested is true', () => {
    const msg = buildRejectionFeedback({ command: 'ls', stopRequested: true });
    expect(msg).toContain('停止当前任务');
  });

  it('does not include the stop directive when stopRequested is false/absent', () => {
    const msgFalse = buildRejectionFeedback({ command: 'ls', stopRequested: false });
    const msgAbsent = buildRejectionFeedback({ command: 'ls' });
    expect(msgFalse).not.toContain('停止当前任务');
    expect(msgAbsent).not.toContain('停止当前任务');
  });

  it('combines command, reason, and stop directive when all provided', () => {
    const msg = buildRejectionFeedback({
      command: 'dd if=/dev/zero of=/dev/sda',
      userReason: '危险操作',
      stopRequested: true,
    });
    expect(msg).toContain('dd if=/dev/zero of=/dev/sda');
    expect(msg).toContain('危险操作');
    expect(msg).toContain('停止当前任务');
  });

  it('does NOT direct the model to ask_user when stopRequested is true', () => {
    // The user clicked "拒绝并停止" - they want the task to STOP, not be
    // asked another question. Directing the model to ask_user here is what
    // caused the post-rejection hang (wind-down -> ask_user blocks).
    const msg = buildRejectionFeedback({ command: 'ls', stopRequested: true });
    expect(msg).not.toContain('ask_user');
  });

  it('still directs the model to ask_user on a plain (non-stop) reject', () => {
    const msg = buildRejectionFeedback({ command: 'ls' });
    expect(msg).toContain('ask_user');
  });

  it('is non-empty for the minimal case', () => {
    const msg = buildRejectionFeedback({ command: 'ls' });
    expect(msg.length).toBeGreaterThan(20);
  });
});

describe('WIND_DOWN_DIRECTIVE', () => {
  it('is a non-empty string', () => {
    expect(typeof WIND_DOWN_DIRECTIVE).toBe('string');
    expect(WIND_DOWN_DIRECTIVE.length).toBeGreaterThan(20);
  });

  it('tells the model to stop calling execution tools', () => {
    expect(WIND_DOWN_DIRECTIVE).toContain('停止');
    expect(WIND_DOWN_DIRECTIVE).toMatch(/exec|执行/);
  });

  it('tells the model to summarize progress and stop without tools or questions', () => {
    expect(WIND_DOWN_DIRECTIVE).toContain('总结');
    // The wind-down turn must NOT direct the model to call ask_user - that
    // created an unabortable blocking tool call and hung the loop after the
    // user clicked "拒绝并停止".
    expect(WIND_DOWN_DIRECTIVE).not.toContain('ask_user');
    expect(WIND_DOWN_DIRECTIVE).toContain('工具');
  });
});
