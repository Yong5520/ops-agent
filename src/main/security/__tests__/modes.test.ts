import { describe, it, expect } from 'vitest';
import { decideByMode, MODE_DESCRIPTIONS } from '../modes.js';
import type { SafetyMode, CommandType } from '../../../shared/types.js';

describe('decideByMode', () => {
  describe('sentinel mode (diagnostic)', () => {
    const mode: SafetyMode = 'sentinel';

    it('allows READ without approval', () => {
      const result = decideByMode(mode, 'READ');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(false);
    });

    it('blocks WRITE', () => {
      const result = decideByMode(mode, 'WRITE');
      expect(result.allowed).toBe(false);
      expect(result.needsApproval).toBe(false);
      expect(result.reason).toContain('Sentinel');
    });

    it('blocks SUDO', () => {
      const result = decideByMode(mode, 'SUDO');
      expect(result.allowed).toBe(false);
      expect(result.needsApproval).toBe(false);
    });

    it('blocks BLOCKED', () => {
      const result = decideByMode(mode, 'BLOCKED');
      expect(result.allowed).toBe(false);
    });
  });

  describe('operator mode (standard)', () => {
    const mode: SafetyMode = 'operator';

    it('allows READ without approval', () => {
      const result = decideByMode(mode, 'READ');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(false);
    });

    it('allows WRITE with approval', () => {
      const result = decideByMode(mode, 'WRITE');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(true);
    });

    it('allows SUDO with approval', () => {
      const result = decideByMode(mode, 'SUDO');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(true);
    });
  });

  describe('autopilot mode', () => {
    const mode: SafetyMode = 'autopilot';

    it('allows READ without approval', () => {
      const result = decideByMode(mode, 'READ');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(false);
    });

    it('allows WRITE without approval', () => {
      const result = decideByMode(mode, 'WRITE');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(false);
    });

    it('allows SUDO without approval', () => {
      const result = decideByMode(mode, 'SUDO');
      expect(result.allowed).toBe(true);
      expect(result.needsApproval).toBe(false);
    });
  });

  describe('mode descriptions', () => {
    it('has descriptions for all modes', () => {
      expect(MODE_DESCRIPTIONS.sentinel.name).toBeTruthy();
      expect(MODE_DESCRIPTIONS.operator.name).toBeTruthy();
      expect(MODE_DESCRIPTIONS.autopilot.name).toBeTruthy();
    });
  });
});

describe('exhaustive mode coverage', () => {
  const allModes: SafetyMode[] = ['sentinel', 'operator', 'autopilot'];
  const allTypes: CommandType[] = ['READ', 'WRITE', 'SUDO', 'BLOCKED'];

  for (const mode of allModes) {
    for (const type of allTypes) {
      it(`${mode}/${type} returns a valid decision`, () => {
        const result = decideByMode(mode, type);
        expect(typeof result.allowed).toBe('boolean');
        expect(typeof result.needsApproval).toBe('boolean');
      });
    }
  }
});
