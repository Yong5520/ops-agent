import { describe, it, expect } from 'vitest';
import { parseCommandResponse } from '../ai-command.js';

describe('parseCommandResponse', () => {
  it('parses valid JSON response', () => {
    const raw = '{"command":"du -sh .","explanation":"统计目录大小","safetyLevel":"read"}';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('du -sh .');
    expect(result.explanation).toBe('统计目录大小');
    expect(result.safetyLevel).toBe('read');
  });

  it('extracts JSON from surrounding text', () => {
    const raw = `好的，这是命令：
{"command":"free -h","explanation":"显示内存使用","safetyLevel":"read"}
希望对您有帮助。`;
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('free -h');
    expect(result.explanation).toBe('显示内存使用');
    expect(result.safetyLevel).toBe('read');
  });

  it('extracts JSON from markdown code block', () => {
    const raw = '```json\n{"command":"df -h","explanation":"磁盘使用","safetyLevel":"read"}\n```';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('df -h');
    expect(result.explanation).toBe('磁盘使用');
    expect(result.safetyLevel).toBe('read');
  });

  it('normalizes safetyLevel to lowercase', () => {
    const raw = '{"command":"reboot","explanation":"重启","safetyLevel":"SUDO"}';
    const result = parseCommandResponse(raw);
    expect(result.safetyLevel).toBe('sudo');
  });

  it('defaults unknown safetyLevel to write', () => {
    const raw = '{"command":"touch /tmp/x","explanation":"创建文件","safetyLevel":"unknown"}';
    const result = parseCommandResponse(raw);
    expect(result.safetyLevel).toBe('write');
  });

  it('defaults missing safetyLevel to write', () => {
    const raw = '{"command":"touch /tmp/x","explanation":"创建文件"}';
    const result = parseCommandResponse(raw);
    expect(result.safetyLevel).toBe('write');
  });

  it('falls back to raw text as command when JSON parse fails', () => {
    const raw = 'du -sh .';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('du -sh .');
    expect(result.explanation).toBe('');
    expect(result.safetyLevel).toBe('write');
  });

  it('handles empty response gracefully', () => {
    const result = parseCommandResponse('');
    expect(result.command).toBe('');
    expect(result.explanation).toBe('');
    expect(result.safetyLevel).toBe('write');
  });

  it('trims whitespace from command and explanation', () => {
    const raw = '{"command":"  ls -la  ","explanation":"  列出文件  ","safetyLevel":"read"}';
    const result = parseCommandResponse(raw);
    expect(result.command).toBe('ls -la');
    expect(result.explanation).toBe('列出文件');
  });
});
