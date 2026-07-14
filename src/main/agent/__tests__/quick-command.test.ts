import { describe, it, expect } from 'vitest';
import { parseQuickCommand } from '../../../shared/quick-command.js';

describe('parseQuickCommand', () => {
  it('should detect > prefix as quick exec command', () => {
    const result = parseQuickCommand('>ls @test');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('ls');
    expect(result.hostName).toBe('test');
  });

  it('should detect $ prefix as quick exec command', () => {
    const result = parseQuickCommand('$df -h @test');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('df -h');
    expect(result.hostName).toBe('test');
  });

  it('should handle command without host mention', () => {
    const result = parseQuickCommand('>ls -la');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('ls -la');
    expect(result.hostName).toBeUndefined();
  });

  it('should handle command with host mention in middle', () => {
    const result = parseQuickCommand('>df -h @prod');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('df -h');
    expect(result.hostName).toBe('prod');
  });

  it('should NOT treat regular text as quick command', () => {
    expect(parseQuickCommand('ls @test').isQuickCommand).toBe(false);
    expect(parseQuickCommand('检查磁盘').isQuickCommand).toBe(false);
    expect(parseQuickCommand('').isQuickCommand).toBe(false);
  });

  it('should NOT treat /compact as quick command', () => {
    const result = parseQuickCommand('/compact');
    expect(result.isQuickCommand).toBe(false);
  });

  it('should NOT treat > at non-start position as quick command', () => {
    const result = parseQuickCommand('echo > /dev/null');
    expect(result.isQuickCommand).toBe(false);
  });

  it('should handle empty command after prefix', () => {
    const result = parseQuickCommand('>');
    expect(result.isQuickCommand).toBe(false);
  });

  it('should handle command with multiple spaces', () => {
    const result = parseQuickCommand('>ps aux | grep nginx');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('ps aux | grep nginx');
    expect(result.hostName).toBeUndefined();
  });

  it('should handle host mention at end with no space after', () => {
    const result = parseQuickCommand('>ls@test');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('ls');
    expect(result.hostName).toBe('test');
  });

  it('should handle $ with complex command and host', () => {
    const result = parseQuickCommand('$systemctl status nginx @web-01');
    expect(result.isQuickCommand).toBe(true);
    expect(result.command).toBe('systemctl status nginx');
    expect(result.hostName).toBe('web-01');
  });
});
