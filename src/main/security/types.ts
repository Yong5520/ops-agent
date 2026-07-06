import type { SafetyMode, CommandType } from '../../shared/types.js';

// Security rule severity levels.
export type Severity = 'critical' | 'high' | 'medium' | 'low';

// A compiled security rule with a RegExp pattern.
export interface SecurityRule {
  pattern: RegExp;
  reason: string;
  severity: Severity;
}

// Raw rule definition as stored in DB or default list (pattern is string).
export interface SecurityRuleRaw {
  pattern: string;
  reason: string;
  severity?: Severity;
}

// Rule type: 'blocked' rules reject commands, 'allowed' rules whitelist them.
export type RuleType = 'blocked' | 'allowed';

// Result of a security check on a command.
export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  commandType: CommandType;
  severity?: Severity;
}

// Effective security configuration assembled from defaults + DB rules + host overrides.
export interface EffectiveSecurityConfig {
  mode: SafetyMode;
  blocked: SecurityRule[];
  allowed: SecurityRule[];
  hostOverrides: Map<string, { blocked?: SecurityRule[]; allowed?: SecurityRule[] }>;
}
