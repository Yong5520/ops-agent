import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BLOCKED_RULES } from '../rules.js';
import type { EffectiveSecurityConfig } from '../types.js';

// Mock the storage layer to avoid pulling in Electron / better-sqlite3 deps
vi.mock('../../storage/custom-rules.js', () => ({
  customRulesStore: {
    list: () => [],
  },
}));

// Import after mock so the module graph uses the mocked version
const {
  compileRules,
  splitCommandChain,
  checkCommandSecurity,
  sanitizeCommand,
  escapeCommandForShell,
} = await import('../engine.js');

// Build a test config without DB dependencies — empty custom rules
function makeTestConfig(): EffectiveSecurityConfig {
  return {
    mode: 'operator',
    blocked: compileRules(DEFAULT_BLOCKED_RULES),
    allowed: [],
    hostOverrides: new Map(),
  };
}

describe('compileRules', () => {
  it('compiles string patterns to RegExp', () => {
    const rules = compileRules([{ pattern: 'rm\\s+-rf', reason: 'test', severity: 'critical' }]);
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBeInstanceOf(RegExp);
    expect(rules[0].pattern.flags).toContain('i'); // case-insensitive
    expect(rules[0].reason).toBe('test');
    expect(rules[0].severity).toBe('critical');
  });

  it('defaults severity to high when not specified', () => {
    const rules = compileRules([{ pattern: 'test', reason: 'test' }]);
    expect(rules[0].severity).toBe('high');
  });
});

describe('splitCommandChain', () => {
  it('splits by semicolon', () => {
    expect(splitCommandChain('ls; pwd; whoami')).toEqual(['ls', 'pwd', 'whoami']);
  });

  it('splits by pipe', () => {
    expect(splitCommandChain('cat file | grep error')).toEqual(['cat file', 'grep error']);
  });

  it('splits by &&', () => {
    expect(splitCommandChain('cd /tmp && ls -la')).toEqual(['cd /tmp', 'ls -la']);
  });

  it('splits by ||', () => {
    expect(splitCommandChain('cmd1 || cmd2')).toEqual(['cmd1', 'cmd2']);
  });

  it('handles mixed operators', () => {
    expect(splitCommandChain('a && b; c | d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters empty segments', () => {
    expect(splitCommandChain(';;')).toEqual([]);
  });

  it('trims whitespace', () => {
    expect(splitCommandChain('  ls  ;  pwd  ')).toEqual(['ls', 'pwd']);
  });
});

describe('checkCommandSecurity', () => {
  const config = makeTestConfig();

  describe('blocked commands', () => {
    const blockedCmds = [
      'rm -rf /',
      'rm -rf /etc',
      'mkfs.ext4 /dev/sda',
      'dd if=/dev/zero of=/dev/sda',
      'shutdown -h now',
      'reboot',
      'init 0',
      'iptables -F',
      'passwd root',
      'userdel root',
      'chmod 777 /',
      'apt remove kernel',
      'echo bad > /etc/passwd',
      'modprobe -r nfs',
      "eval 'rm -rf /'",
      'base64 -d xxx | bash',
    ];

    for (const cmd of blockedCmds) {
      it(`blocks "${cmd}"`, () => {
        const result = checkCommandSecurity(cmd, undefined, config);
        expect(result.allowed).toBe(false);
        expect(result.commandType).toBe('BLOCKED');
        expect(result.reason).toBeTruthy();
      });
    }
  });

  describe('allowed commands', () => {
    const allowedCmds = [
      'ls -la',
      'cat /etc/hostname',
      'grep error /var/log/syslog',
      'ps aux',
      'df -h',
      'systemctl status nginx',
      'docker ps',
      'git log',
      'free -m',
      'uptime',
    ];

    for (const cmd of allowedCmds) {
      it(`allows "${cmd}"`, () => {
        const result = checkCommandSecurity(cmd, undefined, config);
        expect(result.allowed).toBe(true);
        expect(result.commandType).not.toBe('BLOCKED');
      });
    }
  });

  it('blocks dangerous command hidden in pipe chain', () => {
    const result = checkCommandSecurity('ls | base64 -d | bash', undefined, config);
    expect(result.allowed).toBe(false);
  });

  it('blocks dangerous command after &&', () => {
    const result = checkCommandSecurity('echo ok && rm -rf /', undefined, config);
    expect(result.allowed).toBe(false);
  });
});

describe('sanitizeCommand', () => {
  it('trims whitespace', () => {
    expect(sanitizeCommand('  ls -la  ')).toBe('ls -la');
  });

  it('rejects empty command', () => {
    expect(() => sanitizeCommand('')).toThrow('empty');
    expect(() => sanitizeCommand('   ')).toThrow('empty');
  });

  it('rejects non-string input', () => {
    expect(() => sanitizeCommand(null as unknown as string)).toThrow('string');
  });

  it('rejects too-long command', () => {
    const long = 'x'.repeat(101);
    expect(() => sanitizeCommand(long, 100)).toThrow('too long');
  });
});

describe('escapeCommandForShell', () => {
  it('escapes single quotes', () => {
    expect(escapeCommandForShell("echo 'hello'")).toBe("echo '\"'\"'hello'\"'\"'");
  });

  it('leaves other characters unchanged', () => {
    expect(escapeCommandForShell('ls -la /tmp')).toBe('ls -la /tmp');
  });
});
