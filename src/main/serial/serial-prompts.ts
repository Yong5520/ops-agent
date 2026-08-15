// Pure serial-console prompt detection patterns.
//
// Serial consoles are byte streams with no structured channel: every decision
// (auto-login, exec completion, boot continuation) is made by pattern-matching
// the accumulated output. All detectors here are pure functions over strings
// so they can be exhaustively unit-tested without hardware.
//
// Tail/buffer notes: login + boot detection scan a recent window of the buffer
// (a prompt split across chunks must still match once completed); CLI prompt
// detection is tail-anchored (only the last non-empty line counts).

import type { DeviceType } from '../../shared/types.js';

// ── Login prompts ──────────────────────────────────────────────────────────
// "Last login: ..." must NOT match, so require login/user keywords.

const LOGIN_PROMPT_RES: RegExp[] = [
  // `switch login:` / `Login:` - a hostname prefix is allowed, but the SSH
  // banner form "Last login: ..." is excluded via lookbehind.
  /(?<!last\s)login\s*:/i,
  /(?:^|[\r\n])\s*user\s*name\s*:/i,
  /(?:^|[\r\n])\s*username\s*:/i,
];

const PASSWORD_PROMPT_RES: RegExp[] = [/(?:^|[\r\n])\s*(?:enter\s+)?password\s*:/i];

/** Has the buffer ever shown a username/login prompt in its recent window? */
export function detectLoginPrompt(buffer: string): boolean {
  return LOGIN_PROMPT_RES.some((re) => re.test(buffer));
}

/** Has the buffer ever shown a password prompt in its recent window? */
export function detectPasswordPrompt(buffer: string): boolean {
  return PASSWORD_PROMPT_RES.some((re) => re.test(buffer));
}

// ── Boot continuation prompts ──────────────────────────────────────────────
// A fresh device (switch initialization) boots to "Press any key" style
// prompts before the CLI is reachable. Answering with Enter moves it along.

const BOOT_PROMPT_RES: RegExp[] = [
  /press\s+any\s+key/i,
  /press\s+enter/i,
  /press\s+the\s+enter\s+key/i,
  /hit\s+enter/i,
];

/** Does the buffer end in a boot continuation prompt (or contain one in its
 * recent window)? Boot banners scroll past, so a window scan is used. */
export function detectBootPrompt(buffer: string): boolean {
  const window = buffer.slice(-128);
  return BOOT_PROMPT_RES.some((re) => re.test(window));
}

// ── CLI prompt (exec completion) detection ─────────────────────────────────
// A device is "back at the prompt" when the last non-empty line of the buffer
// is a short prompt-like token. Vendor shapes:
//   Huawei VRP:  <HUAWEI>            user view
//                [HUAWEI-vlan10]     config view
//   Cisco IOS:   Switch# / Switch>   (also Sub-mode# with parens)
//   H3C:         [switch]            like VRP bracket view
//   Generic:     hostname# / hostname>
// All anchored to line start so a mid-output '#' or '>' does not match.

const CLI_PROMPT_RES: RegExp[] = [
  /(?:^|\r?\n)<[^<>\r\n]{1,64}>\s*$/, // <HUAWEI>
  /(?:^|\r?\n)\[[^[\]\r\n]{1,64}\]\s*$/, // [HUAWEI-vlan10] / [switch]
  /(?:^|\r?\n)[A-Za-z0-9][\w.-]{0,63}(?:\([^\r\n()]{0,48}\))?[>#]\s*$/, // Switch# / sw(config)>
];

/**
 * Does `buffer` end at a CLI prompt? Tail-anchored: trailing whitespace (and
 * ANSI escapes) are ignored, and only the final non-empty line is examined, so
 * prompts earlier in the output (already answered) do not match.
 */
export function endsWithCliPrompt(buffer: string): boolean {
  if (!buffer) return false;
  const tail = buffer.slice(-256);
  const cleaned = stripTrailingWhitespace(stripSimpleAnsi(tail));
  return CLI_PROMPT_RES.some((re) => re.test(cleaned));
}

// Minimal ANSI strip (same character classes as ssh/pager.ts's stripAnsi,
// inlined so this module stays dependency-free).
// eslint-disable-next-line no-control-regex
const ANSI_INLINE_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB012]|\x1b[=>]|\x07/g;

function stripSimpleAnsi(text: string): string {
  return text.replace(ANSI_INLINE_RE, '');
}

function stripTrailingWhitespace(text: string): string {
  return text.replace(/[ \t\r\n]+$/g, '');
}

// ── Device-type-aware prompt helpers ───────────────────────────────────────

/**
 * Whether the device type's CLI uses the Huawei-style bracket prompt shapes.
 * Reserved for future per-vendor tuning; all vendors currently share the
 * generic CLI_PROMPT_RES set (each pattern is vendor-specific but the set is
 * applied together - a Cisco device never emits `<name>` and vice versa, so
 * false positives across vendors are not possible in practice).
 */
export function promptProfileForDevice(_deviceType: DeviceType | undefined): 'generic' {
  return 'generic';
}
