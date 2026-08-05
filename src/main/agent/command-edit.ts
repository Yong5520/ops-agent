// Edited-command re-validation (Phase A3).
//
// When the user edits a command in the AuthDialog before approving, the edited
// text has NOT been through the security pipeline (the original was classified
// at tools.ts:173, but the edit is user-supplied at approval time). This module
// re-runs sanitization + the full security check on the edited command so the
// user cannot accidentally or intentionally bypass blocked rules by editing.
//
// Contract:
//   - No edit (undefined / empty / whitespace / trim-equal to original) -> { changed: false }
//   - Edit that hits a blocked rule or fails sanitization -> { changed: true, blocked: true, reason }
//   - Valid edit -> { changed: true, modifiedCommand, commandType }
//
// The user explicitly approved the edited text, so we do NOT re-prompt for
// authorization - but blocked rules are enforced hard (defense-in-depth).

import { sanitizeCommand, checkCommandSecurity } from '../security/engine.js';
import type { EffectiveSecurityConfig } from '../security/types.js';
import type { CommandType } from '../../shared/types.js';

export interface EditedCommandValidation {
  /** true if the edited text (trim-normalized) differs from the original. */
  changed: boolean;
  /** The sanitized edited command to execute. Present only when changed && !blocked. */
  modifiedCommand?: string;
  /** Reclassified type of the edited command. Present only when changed && !blocked. */
  commandType?: CommandType;
  /** true when the edited command is blocked by security rules or fails sanitization. */
  blocked?: boolean;
  /** Block reason (when blocked). */
  reason?: string;
}

export function revalidateEditedCommand(
  editedCommand: string | undefined,
  originalCommand: string,
  hostId: string | undefined,
  config: EffectiveSecurityConfig,
): EditedCommandValidation {
  // No edit provided, or blank - treat as no change (preExec uses the original).
  if (typeof editedCommand !== 'string' || editedCommand.trim() === '') {
    return { changed: false };
  }

  // Unchanged modulo surrounding whitespace - skip re-validation.
  if (editedCommand.trim() === originalCommand.trim()) {
    return { changed: false };
  }

  // Re-sanitize: trims and enforces the length cap. Throws on empty/oversize.
  let sanitized: string;
  try {
    sanitized = sanitizeCommand(editedCommand);
  } catch (err) {
    return { changed: true, blocked: true, reason: (err as Error).message };
  }

  // Re-run the full security check (blocked rules + subshell extraction +
  // reclassification). Host overrides apply when hostId matches.
  const sec = checkCommandSecurity(sanitized, hostId, config);
  if (!sec.allowed) {
    return { changed: true, blocked: true, reason: `编辑后的命令命中安全规则：${sec.reason}` };
  }

  return { changed: true, modifiedCommand: sanitized, commandType: sec.commandType };
}

// Notice prepended to a tool's stdout when the user edited the command before
// approving. Without this, the model only sees the tool-call args it proposed
// (the original command) in its assistant message, so its subsequent steps
// (verification, follow-ups) reference the ORIGINAL command - not the edited
// one that actually ran. This notice surfaces the edit so the model updates
// its mental model of what happened.
export function buildEditNotice(executedCommand: string): string {
  return `⚠️ 用户在授权时修改了命令，实际执行：\n${executedCommand}\n（后续请基于此命令的实际情况操作）\n\n`;
}
