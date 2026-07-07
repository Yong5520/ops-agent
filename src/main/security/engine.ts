import type {
  SecurityRule,
  SecurityRuleRaw,
  SecurityCheckResult,
  EffectiveSecurityConfig,
} from './types.js';
import type { CustomRule } from '../../shared/types.js';
import { DEFAULT_BLOCKED_RULES } from './rules.js';
import { classifyCommand } from './classifier.js';
import { customRulesStore } from '../storage/custom-rules.js';

// ── Rule compilation ──────────────────────────────────────────────────────

// Compile raw string-pattern rules into RegExp-backed rules.
// Patterns are case-insensitive to catch RM, Sudo, etc.
export function compileRules(raw: SecurityRuleRaw[]): SecurityRule[] {
  return raw.map((r) => ({
    pattern: new RegExp(r.pattern, 'i'),
    reason: r.reason,
    severity: r.severity ?? 'high',
  }));
}

// ── Command chain splitting ───────────────────────────────────────────────

// Split a compound shell command by operators: ; || && |& |
// Each segment is checked independently so blocked patterns can't sneak
// through inside a pipe chain.
export function splitCommandChain(command: string): string[] {
  const segments = command.split(/\s*(?:;|\|\||&&|\|&|\|)\s*/);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ── Subshell content extraction ──────────────────────────────────────────

// Extract the inner content of $(...) and `...` substitutions so the
// security engine can check them against blocked rules independently.
// Without this, `echo "$(rm -rf /)"` would only be checked as `echo ...`
// and the dangerous rm inside the substitution would be invisible.
//
// Nested substitutions are not expanded — we extract only the top-level
// content, which is sufficient for the common evasion patterns.
export function extractSubshellCommands(command: string): string[] {
  const commands: string[] = [];
  // Match $( ... ) — non-greedy to stop at the first closing paren
  for (const m of command.matchAll(/\$\(([^)]+)\)/g)) {
    commands.push(m[1].trim());
  }
  // Match ` ... ` backtick substitution
  for (const m of command.matchAll(/`([^`]+)`/g)) {
    commands.push(m[1].trim());
  }
  return commands.filter((s) => s.length > 0);
}

// ── Custom rule loading ───────────────────────────────────────────────────

// Convert DB-backed custom rules into raw rules for compilation.
function customRulesToRaw(rules: CustomRule[], type: 'blocked' | 'allowed'): SecurityRuleRaw[] {
  return rules
    .filter((r) => r.type === type)
    .map((r) => ({
      pattern: r.pattern,
      reason: r.reason,
      severity: 'high' as const,
    }));
}

// ── Effective config assembly ─────────────────────────────────────────────

// Build the effective security config for a given safety mode by merging:
//   1. Default blocked rules
//   2. Custom rules from DB (global + all hosts, grouped by host)
// The result is cached per mode for the process lifetime; host-level
// overrides are looked up by hostId at check time.
let cachedConfig: EffectiveSecurityConfig | null = null;

function buildEffectiveConfig(mode: EffectiveSecurityConfig['mode']): EffectiveSecurityConfig {
  const allCustom = customRulesStore.list();
  const globalBlocked = allCustom.filter((r) => r.type === 'blocked' && r.hostId == null);
  const globalAllowed = allCustom.filter((r) => r.type === 'allowed' && r.hostId == null);

  const blocked = compileRules([
    ...DEFAULT_BLOCKED_RULES,
    ...customRulesToRaw(globalBlocked, 'blocked'),
  ]);
  const allowed = compileRules(customRulesToRaw(globalAllowed, 'allowed'));

  const hostOverrides = new Map<string, { blocked?: SecurityRule[]; allowed?: SecurityRule[] }>();
  for (const rule of allCustom) {
    if (!rule.hostId) continue;
    const entry = hostOverrides.get(rule.hostId) ?? {};
    const list = rule.type === 'blocked' ? (entry.blocked ?? []) : (entry.allowed ?? []);
    list.push({
      pattern: new RegExp(rule.pattern, 'i'),
      reason: rule.reason,
      severity: 'high',
    });
    if (rule.type === 'blocked') entry.blocked = list;
    else entry.allowed = list;
    hostOverrides.set(rule.hostId, entry);
  }

  return { mode, blocked, allowed, hostOverrides };
}

export function getEffectiveConfig(mode: EffectiveSecurityConfig['mode']): EffectiveSecurityConfig {
  // Rebuild whenever mode changes; the custom rules are re-read each time
  // so that user-edited rules take effect without restarting the app.
  cachedConfig = buildEffectiveConfig(mode);
  return cachedConfig;
}

// ── Command security check ────────────────────────────────────────────────

// Check a command against the effective security config.
// Returns a SecurityCheckResult with `commandType` always set and `reason`
// populated when the command is blocked.
export function checkCommandSecurity(
  command: string,
  hostId: string | undefined,
  config: EffectiveSecurityConfig,
): SecurityCheckResult {
  const commandType = classifyCommand(command);

  // Look up host-level rule additions (merged on top of global rules).
  const hostOverride = hostId ? config.hostOverrides.get(hostId) : undefined;
  const effectiveBlocked = hostOverride?.blocked
    ? [...config.blocked, ...hostOverride.blocked]
    : config.blocked;
  // Note: allowed-list whitelisting (strict/readonly modes from ssh-mcp-multi)
  // is replaced by the three-tier SafetyMode system in modes.ts. The allowed
  // list is still compiled and stored for future use but not consulted here.

  // 1. Check full command against blocked list first — catches cross-pipe
  //    patterns like `base64 -d | bash`.
  for (const rule of effectiveBlocked) {
    if (rule.pattern.test(command)) {
      return {
        allowed: false,
        reason: rule.reason,
        commandType: 'BLOCKED',
        severity: rule.severity,
      };
    }
  }

  // 2. Split compound commands and check each segment independently.
  const segments = splitCommandChain(command);
  for (const segment of segments) {
    for (const rule of effectiveBlocked) {
      if (rule.pattern.test(segment)) {
        return {
          allowed: false,
          reason: rule.reason,
          commandType: 'BLOCKED',
          severity: rule.severity,
        };
      }
    }
  }

  // 3. Extract and check the inner content of $(...) and `...`
  //    substitutions. A command like `echo "$(rm -rf /)"` looks benign
  //    on the surface, but the substitution executes `rm -rf /`. We
  //    re-run each extracted subshell command through the full security
  //    check so nested dangerous commands are caught.
  const subshellCommands = extractSubshellCommands(command);
  for (const sub of subshellCommands) {
    const subResult = checkCommandSecurity(sub, hostId, config);
    if (!subResult.allowed) {
      return {
        allowed: false,
        reason: `命令替换中包含被拦截的操作: ${subResult.reason}`,
        commandType: 'BLOCKED',
        severity: subResult.severity,
      };
    }
  }

  return { allowed: true, commandType };
}

// ── Sanitization helpers ──────────────────────────────────────────────────

export function sanitizeCommand(command: string, maxChars = 10000): string {
  if (typeof command !== 'string') {
    throw new Error('Command must be a string');
  }
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('Command cannot be empty');
  }
  if (trimmed.length > maxChars) {
    throw new Error(`Command too long (max ${maxChars} chars)`);
  }
  return trimmed;
}

// Escape a command string for safe embedding inside a single-quoted shell
// context. Used when wrapping user commands in `sudo sh -c '...'`.
export function escapeCommandForShell(command: string): string {
  return command.replace(/'/g, "'\"'\"'");
}
