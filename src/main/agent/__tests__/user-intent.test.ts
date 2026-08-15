// Tests for the user-intent classifier (user-intent.ts).
//
// Pins the conservative behavior: a question marker dominates an action verb,
// so "执行以上动作不影响吧" is a question (not a continuation). This was the
// exact phrasing from the 2026-08-11 nginx incident.

import { describe, it, expect } from 'vitest';
import { isQuestion, isContinuationRequest } from '../user-intent.js';

describe('isQuestion', () => {
  it('detects Chinese question particles', () => {
    expect(isQuestion('以上动作不影响 用户的请求吧')).toBe(true);
    expect(isQuestion('会不会影响业务')).toBe(true);
    expect(isQuestion('是否需要重启')).toBe(true);
    expect(isQuestion('能不能先备份')).toBe(true);
    expect(isQuestion('这样没问题吗')).toBe(true);
  });

  it('detects Western and full-width question marks', () => {
    expect(isQuestion('will this affect the request?')).toBe(true);
    expect(isQuestion('这样安全吗？')).toBe(true);
  });

  it('returns false for a plain instruction', () => {
    expect(isQuestion('执行以上安全加固')).toBe(false);
    expect(isQuestion('继续')).toBe(false);
    expect(isQuestion('')).toBe(false);
    expect(isQuestion(undefined)).toBe(false);
  });
});

describe('isContinuationRequest', () => {
  it('returns true for explicit continuation language', () => {
    expect(isContinuationRequest('继续')).toBe(true);
    expect(isContinuationRequest('接着做')).toBe(true);
    expect(isContinuationRequest('下一步')).toBe(true);
    expect(isContinuationRequest('resume the task')).toBe(true);
  });

  it('returns true for an action verb without a question marker', () => {
    expect(isContinuationRequest('执行以上安全加固')).toBe(true);
    expect(isContinuationRequest('开始部署')).toBe(true);
    expect(isContinuationRequest('修复配置')).toBe(true);
  });

  it('returns FALSE for a question even when it contains an action verb', () => {
    // The nginx incident phrasing - must NOT be treated as a continuation.
    expect(isContinuationRequest('以上动作不影响 用户的请求吧')).toBe(false);
    expect(isContinuationRequest('执行以上动作不影响吧')).toBe(false);
    expect(isContinuationRequest('重启会不会影响业务？')).toBe(false);
    expect(isContinuationRequest('是否需要执行加固')).toBe(false);
  });

  it('returns false for empty / undefined / whitespace', () => {
    expect(isContinuationRequest('')).toBe(false);
    expect(isContinuationRequest(undefined)).toBe(false);
    expect(isContinuationRequest('   ')).toBe(false);
  });

  it('returns false for a neutral analysis request (READ-only)', () => {
    // "检查磁盘" is analysis, not a write continuation - the action-verb list
    // intentionally omits READ verbs like 检查/查看/分析.
    expect(isContinuationRequest('检查磁盘使用情况')).toBe(false);
    expect(isContinuationRequest('看一下日志')).toBe(false);
  });
});
