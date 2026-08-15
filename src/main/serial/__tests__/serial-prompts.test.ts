// Unit tests for pure serial prompt detection patterns (login prompts, boot
// continuation prompts, CLI prompt-at-end detection). serial-prompts.ts has no
// runtime dependencies so these run anywhere.
import { describe, it, expect } from 'vitest';
import {
  detectLoginPrompt,
  detectPasswordPrompt,
  detectBootPrompt,
  endsWithCliPrompt,
} from '../serial-prompts.js';

describe('detectLoginPrompt', () => {
  it('matches common login prompt phrasings (case-insensitive)', () => {
    expect(detectLoginPrompt('Login: ')).toBe(true);
    expect(detectLoginPrompt('switch login:')).toBe(true);
    expect(detectLoginPrompt('Username: ')).toBe(true);
    expect(detectLoginPrompt('User Name:')).toBe(true);
  });

  it('does not match ordinary output', () => {
    expect(detectLoginPrompt('display version')).toBe(false);
    expect(detectLoginPrompt('Last login: Wed Aug 12 10:00:00 2026')).toBe(false);
  });
});

describe('detectPasswordPrompt', () => {
  it('matches password prompts (case-insensitive)', () => {
    expect(detectPasswordPrompt('Password: ')).toBe(true);
    expect(detectPasswordPrompt('Enter password:')).toBe(true);
  });

  it('does not match ordinary output', () => {
    expect(detectPasswordPrompt('password policy: min length 8')).toBe(false);
  });
});

describe('detectBootPrompt', () => {
  it('matches press-any-key boot continuation prompts', () => {
    expect(detectBootPrompt('Press any key to continue')).toBe(true);
    expect(detectBootPrompt('Press any key to get started')).toBe(true);
    expect(detectBootPrompt('press ENTER to continue...')).toBe(true);
  });

  it('does not match ordinary output', () => {
    expect(detectBootPrompt('press the button on the panel')).toBe(false);
  });
});

describe('endsWithCliPrompt', () => {
  it('matches a huawei-style <name> prompt at end of buffer', () => {
    expect(endsWithCliPrompt('<HUAWEI>')).toBe(true);
    expect(endsWithCliPrompt('some output\r\n<HUAWEI> ')).toBe(true);
  });

  it('matches bracketed config-mode prompts', () => {
    expect(endsWithCliPrompt('[HUAWEI-vlan10]')).toBe(true);
    expect(endsWithCliPrompt('[switch]system-view')).toBe(false); // not at end
  });

  it('matches cisco-style hostname# / hostname> prompts', () => {
    expect(endsWithCliPrompt('Switch#')).toBe(true);
    expect(endsWithCliPrompt('Switch>')).toBe(true);
    expect(endsWithCliPrompt('Core-SW-01(config)#')).toBe(true);
  });

  it('matches generic device# / device> prompts on their own line', () => {
    expect(endsWithCliPrompt('output\r\nmydevice# ')).toBe(true);
  });

  it('does not match mid-output text or echoed commands', () => {
    expect(endsWithCliPrompt('display version> not a prompt really')).toBe(false);
    // An echoed command with a trailing > on the same line as other words is
    // not a prompt: a prompt is the last non-empty line AND is short.
    expect(endsWithCliPrompt('echo hello > world this is long text >')).toBe(false);
  });

  it('requires a newline before the prompt line when output precedes it', () => {
    // A prompt must start a line - mid-line '#' (comment) is not a prompt.
    expect(endsWithCliPrompt('this line ends with # comment')).toBe(false);
  });
});
