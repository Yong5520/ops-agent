import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_BLOCKED_RULES } from '../rules.js';

// rules-config.ts must NOT import electron at module top-level (it lazy-loads
// inside getRulesFilePath), so this test file can import it directly without
// mocking electron. All file I/O uses injected temp paths.
const { loadSecurityRulesConfig, seedFactoryDefaultsIfMissing, resetToFactoryDefaults, getRulesFilePath } =
  await import('../rules-config.js');

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ops-rules-'));
  file = join(dir, 'security-rules.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadSecurityRulesConfig', () => {
  it('seeds the file with factory defaults when it is missing', () => {
    expect(existsSync(file)).toBe(false);
    const config = loadSecurityRulesConfig({ filePath: file });
    // File was created on disk
    expect(existsSync(file)).toBe(true);
    // Returned factory defaults: same count as DEFAULT_BLOCKED_RULES, all enabled
    expect(config.blockedRules).toHaveLength(DEFAULT_BLOCKED_RULES.length);
    expect(config.allowedRules).toEqual([]);
    expect(config.blockedRules.every((r) => r.enabled === true)).toBe(true);
  });

  it('reads a valid custom config file', () => {
    const custom = {
      version: 1,
      blockedRules: [
        { id: 'r1', pattern: '^forbidden-cmd', reason: 'test block', severity: 'high', enabled: true },
      ],
      allowedRules: [
        { id: 'a1', pattern: '^allowed-cmd', reason: 'test allow', severity: 'low', enabled: true },
      ],
    };
    writeFileSync(file, JSON.stringify(custom), 'utf8');
    const config = loadSecurityRulesConfig({ filePath: file });
    expect(config.blockedRules).toHaveLength(1);
    expect(config.blockedRules[0].pattern).toBe('^forbidden-cmd');
    expect(config.allowedRules).toHaveLength(1);
    expect(config.allowedRules[0].pattern).toBe('^allowed-cmd');
  });

  it('falls back to factory defaults on corrupt JSON (does not throw)', () => {
    writeFileSync(file, '{ not valid json !!!', 'utf8');
    const config = loadSecurityRulesConfig({ filePath: file });
    expect(config.blockedRules).toHaveLength(DEFAULT_BLOCKED_RULES.length);
  });

  it('filters out malformed entries (missing pattern/reason)', () => {
    const custom = {
      version: 1,
      blockedRules: [
        { id: 'good', pattern: '^good', reason: 'ok', enabled: true },
        { id: 'bad', pattern: 'no-reason' }, // missing reason
        { reason: 'no-pattern' }, // missing pattern
        'not-an-object',
      ],
      allowedRules: [],
    };
    writeFileSync(file, JSON.stringify(custom), 'utf8');
    const config = loadSecurityRulesConfig({ filePath: file });
    expect(config.blockedRules).toHaveLength(1);
    expect(config.blockedRules[0].pattern).toBe('^good');
  });

  it('preserves enabled:false so the engine can skip disabled rules', () => {
    const custom = {
      version: 1,
      blockedRules: [
        { id: 'on', pattern: '^on', reason: 'on', enabled: true },
        { id: 'off', pattern: '^off', reason: 'off', enabled: false },
        { id: 'implicit', pattern: '^imp', reason: 'imp' }, // omitted -> enabled true
      ],
      allowedRules: [],
    };
    writeFileSync(file, JSON.stringify(custom), 'utf8');
    const config = loadSecurityRulesConfig({ filePath: file });
    const byId = new Map(config.blockedRules.map((r) => [r.id, r.enabled]));
    expect(byId.get('on')).toBe(true);
    expect(byId.get('off')).toBe(false);
    expect(byId.get('implicit')).toBe(true);
  });
});

describe('seedFactoryDefaultsIfMissing', () => {
  it('writes the file when missing', () => {
    expect(existsSync(file)).toBe(false);
    seedFactoryDefaultsIfMissing({ filePath: file });
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.blockedRules).toHaveLength(DEFAULT_BLOCKED_RULES.length);
  });

  it('does NOT overwrite an existing file (preserves user edits)', () => {
    const custom = {
      version: 1,
      blockedRules: [{ id: 'user', pattern: '^user-only', reason: 'mine', enabled: true }],
      allowedRules: [],
    };
    writeFileSync(file, JSON.stringify(custom), 'utf8');
    seedFactoryDefaultsIfMissing({ filePath: file });
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.blockedRules).toHaveLength(1);
    expect(parsed.blockedRules[0].pattern).toBe('^user-only');
  });
});

describe('resetToFactoryDefaults', () => {
  it('overwrites an existing custom file with factory defaults', () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, blockedRules: [{ id: 'x', pattern: 'x', reason: 'x' }], allowedRules: [] }),
      'utf8',
    );
    resetToFactoryDefaults({ filePath: file });
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed.blockedRules).toHaveLength(DEFAULT_BLOCKED_RULES.length);
  });
});

describe('getRulesFilePath', () => {
  it('returns null in a non-electron environment (vitest)', () => {
    // No electron app available in the test runner -> must not throw, returns null
    expect(getRulesFilePath()).toBeNull();
  });
});
