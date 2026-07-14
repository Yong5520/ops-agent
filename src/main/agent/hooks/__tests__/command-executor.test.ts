import { describe, it, expect } from 'vitest';
import { execCommandHook } from '../command-executor.js';
import type { HookInput } from '../../../../shared/types.js';

const mockInput: HookInput = {
  id: 'h1',
  name: 'test',
  event: 'PreToolUse',
  type: 'command',
  config: { name: 'test', event: 'PreToolUse', type: 'command', command: 'echo' },
  condition: { toolName: '*' },
  enabled: true,
  createdAt: '2026-01-01',
  input: { command: 'rm -rf /' },
};

describe('execCommandHook', () => {
  it('parses valid JSON output from command', async () => {
    const cmd = `node -e "console.log(JSON.stringify({permissionDecision:'deny',blockMessage:'blocked'}))"`;
    const result = await execCommandHook(cmd, mockInput, 5000);
    expect(result).toEqual({ permissionDecision: 'deny', blockMessage: 'blocked' });
  });

  it('returns null for invalid JSON output', async () => {
    const cmd = `node -e "console.log('not json')"`;
    const result = await execCommandHook(cmd, mockInput, 5000);
    expect(result).toBeNull();
  });

  it('returns null for empty output', async () => {
    const cmd = `node -e "process.exit(0)"`;
    const result = await execCommandHook(cmd, mockInput, 5000);
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    const cmd = `node -e "setTimeout(()=>{},60000)"`;
    const result = await execCommandHook(cmd, mockInput, 200);
    expect(result).toBeNull();
  }, 10000);

  it('passes hook input JSON to stdin', async () => {
    const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);console.log(JSON.stringify({permissionDecision:'deny',blockMessage:o.input.command+' blocked'}))})"`;
    const result = await execCommandHook(cmd, mockInput, 5000);
    expect(result).toEqual({ permissionDecision: 'deny', blockMessage: 'rm -rf / blocked' });
  });
});
