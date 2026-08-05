import { describe, it, expect } from 'vitest';
import { compileRules } from '../../security/engine.js';
import { DEFAULT_BLOCKED_RULES } from '../../security/rules.js';
import type { EffectiveSecurityConfig, SecurityRuleRaw } from '../../security/types.js';
import { revalidateEditedCommand, buildEditNotice } from '../command-edit.js';

// Build a test config without DB dependencies. Extra blocked rules let tests
// assert the blocked-path deterministically rather than depending on the
// default rule set's contents.
function makeTestConfig(extraBlocked: SecurityRuleRaw[] = []): EffectiveSecurityConfig {
  return {
    mode: 'operator',
    blocked: compileRules([...DEFAULT_BLOCKED_RULES, ...extraBlocked]),
    allowed: [],
    hostOverrides: new Map(),
  };
}

describe('revalidateEditedCommand', () => {
  describe('no-op cases (changed: false)', () => {
    it('returns changed=false when editedCommand is undefined', () => {
      const result = revalidateEditedCommand(undefined, 'ls -la', 'host-1', makeTestConfig());
      expect(result.changed).toBe(false);
      expect(result.modifiedCommand).toBeUndefined();
      expect(result.blocked).toBeUndefined();
    });

    it('returns changed=false when editedCommand is empty string', () => {
      const result = revalidateEditedCommand('', 'ls -la', 'host-1', makeTestConfig());
      expect(result.changed).toBe(false);
    });

    it('returns changed=false when editedCommand is whitespace-only', () => {
      const result = revalidateEditedCommand('   ', 'ls -la', 'host-1', makeTestConfig());
      expect(result.changed).toBe(false);
    });

    it('returns changed=false when edited equals original', () => {
      const result = revalidateEditedCommand('ls -la', 'ls -la', 'host-1', makeTestConfig());
      expect(result.changed).toBe(false);
    });

    it('returns changed=false when edited equals original modulo surrounding whitespace', () => {
      const result = revalidateEditedCommand('  ls -la  ', 'ls -la', 'host-1', makeTestConfig());
      expect(result.changed).toBe(false);
    });
  });

  describe('valid edits', () => {
    it('returns changed=true with trimmed modifiedCommand for a valid READ edit', () => {
      const result = revalidateEditedCommand(
        '  ls -la /tmp  ',
        'ls -la',
        'host-1',
        makeTestConfig(),
      );
      expect(result.changed).toBe(true);
      expect(result.modifiedCommand).toBe('ls -la /tmp');
      expect(result.commandType).toBe('READ');
      expect(result.blocked).toBeUndefined();
    });

    it('reclassifies commandType based on the edited command', () => {
      // `echo foo > /tmp/x` is a WRITE (file redirection).
      const result = revalidateEditedCommand(
        'echo foo > /tmp/x',
        'ls -la',
        'host-1',
        makeTestConfig(),
      );
      expect(result.changed).toBe(true);
      expect(result.commandType).toBe('WRITE');
    });
  });

  describe('blocked edits (security re-check)', () => {
    it('blocks when the edited command matches a blocked rule', () => {
      const config = makeTestConfig([
        { pattern: 'forbidden-pattern', reason: 'forbidden test rule', severity: 'high' },
      ]);
      const result = revalidateEditedCommand('echo forbidden-pattern', 'ls -la', 'host-1', config);
      expect(result.changed).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.modifiedCommand).toBeUndefined();
      expect(result.reason).toContain('forbidden test rule');
    });

    it('blocks when the edited command is too long', () => {
      const huge = 'x'.repeat(10001);
      const result = revalidateEditedCommand(huge, 'ls -la', 'host-1', makeTestConfig());
      expect(result.changed).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/too long|过长/i);
    });
  });

  describe('host overrides', () => {
    it('respects host-level blocked rules when hostId matches', () => {
      const hostBlocked = compileRules([
        { pattern: 'host-secret-cmd', reason: 'host-specific block', severity: 'high' },
      ]);
      const config: EffectiveSecurityConfig = {
        mode: 'operator',
        blocked: compileRules(DEFAULT_BLOCKED_RULES),
        allowed: [],
        hostOverrides: new Map([['host-1', { blocked: hostBlocked, allowed: [] }]]),
      };
      const result = revalidateEditedCommand('host-secret-cmd', 'ls -la', 'host-1', config);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('host-specific block');
    });

    it('does not apply host-level rules when hostId differs', () => {
      const hostBlocked = compileRules([
        { pattern: 'host-secret-cmd', reason: 'host-specific block', severity: 'high' },
      ]);
      const config: EffectiveSecurityConfig = {
        mode: 'operator',
        blocked: compileRules(DEFAULT_BLOCKED_RULES),
        allowed: [],
        hostOverrides: new Map([['host-1', { blocked: hostBlocked, allowed: [] }]]),
      };
      const result = revalidateEditedCommand(
        'host-secret-cmd',
        'ls -la',
        'host-2', // different host - override does not apply
        config,
      );
      expect(result.blocked).toBeUndefined();
      expect(result.changed).toBe(true);
    });
  });
});

describe('buildEditNotice', () => {
  it('includes the executed command', () => {
    const notice = buildEditNotice('mkdir /var/log/app2');
    expect(notice).toContain('mkdir /var/log/app2');
  });

  it('tells the model the command was modified', () => {
    const notice = buildEditNotice('ls -la');
    expect(notice).toContain('修改');
  });

  it('is non-empty and ends with a blank line (so real stdout starts cleanly)', () => {
    const notice = buildEditNotice('echo hi');
    expect(notice.length).toBeGreaterThan(10);
    expect(notice.endsWith('\n\n')).toBe(true);
  });
});
