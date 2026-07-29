import { describe, it, expect, vi } from 'vitest';

// Mock rules-config: buildEffectiveConfig must read blocked rules from here,
// NOT from the hardcoded DEFAULT_BLOCKED_RULES. The mock returns a single
// custom blocked rule so we can prove the engine honors the config file and
// no longer falls back to factory defaults on its own.
vi.mock('../rules-config.js', () => ({
  loadSecurityRulesConfig: () => ({
    version: 1,
    blockedRules: [
      { id: 'custom', pattern: '^custom-blocked-cmd', reason: 'custom block', severity: 'high', enabled: true },
    ],
    allowedRules: [],
  }),
  seedFactoryDefaultsIfMissing: vi.fn(),
  resetToFactoryDefaults: vi.fn(),
  getRulesFilePath: vi.fn(() => null),
  reloadSecurityRulesConfig: vi.fn(),
}));

vi.mock('../../storage/custom-rules.js', () => ({
  customRulesStore: {
    list: () => [],
  },
}));

const { getEffectiveConfig, checkCommandSecurity } = await import('../engine.js');

describe('buildEffectiveConfig reads from rules-config (not hardcoded defaults)', () => {
  const config = getEffectiveConfig('operator');

  it('blocks a command matching the config-file rule', () => {
    const result = checkCommandSecurity('custom-blocked-cmd', undefined, config);
    expect(result.allowed).toBe(false);
    expect(result.commandType).toBe('BLOCKED');
  });

  it('does NOT block reboot (factory defaults are not used directly)', () => {
    // If buildEffectiveConfig still merged DEFAULT_BLOCKED_RULES, `reboot`
    // would be blocked. With the mocked config file it must be allowed.
    const result = checkCommandSecurity('reboot', undefined, config);
    expect(result.allowed).toBe(true);
  });
});
