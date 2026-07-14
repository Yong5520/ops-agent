import { describe, it, expect } from 'vitest';
import { matchCondition } from '../condition.js';

describe('matchCondition', () => {
  it('matches all tools when condition is "*"', () => {
    expect(matchCondition('exec', { command: 'ls -la' }, '*')).toBe(true);
    expect(matchCondition('sudo_exec', { command: 'reboot' }, '*')).toBe(true);
    expect(matchCondition('write_file', { path: '/etc/nginx.conf' }, '*')).toBe(true);
  });

  it('matches exact tool name without parentheses', () => {
    expect(matchCondition('exec', { command: 'ls -la' }, 'exec')).toBe(true);
    expect(matchCondition('exec', { command: 'rm -rf /' }, 'exec')).toBe(true);
  });

  it('does not match different tool name (exact)', () => {
    expect(matchCondition('sudo_exec', { command: 'reboot' }, 'exec')).toBe(false);
    expect(matchCondition('read_file', { command: 'cat /etc/passwd' }, 'exec')).toBe(false);
  });

  it('matches tool name with (*) wildcard - any command', () => {
    expect(matchCondition('exec', { command: 'ls -la' }, 'exec(*)')).toBe(true);
    expect(matchCondition('exec', { command: 'rm -rf /' }, 'exec(*)')).toBe(true);
    expect(matchCondition('write_file', { path: '/etc/nginx.conf' }, 'write_file(*)')).toBe(true);
  });

  it('does not match different tool name with (*) wildcard', () => {
    expect(matchCondition('sudo_exec', { command: 'reboot' }, 'exec(*)')).toBe(false);
    expect(matchCondition('read_file', { path: '/etc/hosts' }, 'write_file(*)')).toBe(false);
  });

  it('matches tool name with command pattern (rm *)', () => {
    expect(matchCondition('exec', { command: 'rm -rf /' }, 'exec(rm *)')).toBe(true);
    expect(matchCondition('exec', { command: 'rm /tmp/file' }, 'exec(rm *)')).toBe(true);
  });

  it('does not match when command does not match pattern', () => {
    expect(matchCondition('exec', { command: 'ls' }, 'exec(rm *)')).toBe(false);
    expect(matchCondition('exec', { command: 'cat /etc/passwd' }, 'exec(rm *)')).toBe(false);
  });

  it('treats pattern inside parens as regex', () => {
    expect(matchCondition('exec', { command: 'systemctl restart nginx' }, 'exec(systemctl .*)')).toBe(true);
    expect(matchCondition('exec', { command: 'ls -la' }, 'exec(systemctl .*)')).toBe(false);
  });

  it('matches when input has no command but pattern is wildcard', () => {
    expect(matchCondition('write_file', { path: '/etc/nginx.conf' }, 'write_file(*)')).toBe(true);
  });

  it('returns false for invalid regex pattern', () => {
    expect(matchCondition('exec', { command: 'ls' }, 'exec([invalid)')).toBe(false);
  });
});
