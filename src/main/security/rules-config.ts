import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SecurityRuleRaw, Severity } from './types.js';
import { DEFAULT_BLOCKED_RULES } from './rules.js';
import { logger } from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────

// A rule as it appears in the on-disk config file. Extends SecurityRuleRaw
// with an optional stable id and an `enabled` toggle so users can disable a
// default rule without deleting it.
export interface SecurityRuleConfigEntry extends SecurityRuleRaw {
  id?: string;
  enabled?: boolean;
}

// Shape of `{userData}/security-rules.json`. This file is the user-editable
// source of truth for the default blocked/allowed rule set; the app seeds it
// from factory defaults on first run and never clobbers user edits.
export interface SecurityRulesConfig {
  version: number;
  blockedRules: SecurityRuleConfigEntry[];
  allowedRules: SecurityRuleConfigEntry[];
}

// ── Factory defaults ──────────────────────────────────────────────────────

// The config file's default content, derived from the compiled-in factory
// rule list. Each entry gets a stable id and enabled=true so the file is
// self-documenting and individually toggleable. Returns a fresh copy each
// call (immutability - never mutate the module-level DEFAULT_BLOCKED_RULES).
function factoryDefaultConfig(): SecurityRulesConfig {
  return {
    version: CONFIG_VERSION,
    blockedRules: DEFAULT_BLOCKED_RULES.map((r, i) => ({
      id: `factory-${i}`,
      pattern: r.pattern,
      reason: r.reason,
      severity: r.severity,
      enabled: true,
    })),
    allowedRules: [],
  };
}

// Shallow clone of a config's rule arrays so callers can't mutate the cache.
function cloneConfig(config: SecurityRulesConfig): SecurityRulesConfig {
  return {
    version: config.version,
    blockedRules: config.blockedRules.map((r) => ({ ...r })),
    allowedRules: config.allowedRules.map((r) => ({ ...r })),
  };
}

// ── File path resolution ──────────────────────────────────────────────────

const CONFIG_VERSION = 1;
const CONFIG_FILENAME = 'security-rules.json';

// Resolve the config file path under Electron's userData directory.
// electron is lazy-required (not a top-level import) so this module can be
// imported in non-electron environments (vitest) without pulling electron.
// Returns null when electron/app is unavailable; callers fall back to
// factory defaults in that case.
export function getRulesFilePath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app?: { getPath: (name: string) => string } };
    if (!app?.getPath) return null;
    return join(app.getPath('userData'), CONFIG_FILENAME);
  } catch {
    return null;
  }
}

// ── Validation ────────────────────────────────────────────────────────────

const VALID_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

function isValidEntry(val: unknown): val is Record<string, unknown> {
  return (
    !!val &&
    typeof val === 'object' &&
    typeof (val as Record<string, unknown>).pattern === 'string' &&
    typeof (val as Record<string, unknown>).reason === 'string'
  );
}

function normalizeEntries(val: unknown): SecurityRuleConfigEntry[] {
  if (!Array.isArray(val)) return [];
  return val.filter(isValidEntry).map((e) => {
    const entry = e as Record<string, unknown>;
    const severity = entry.severity;
    return {
      id: typeof entry.id === 'string' ? entry.id : undefined,
      pattern: entry.pattern as string,
      reason: entry.reason as string,
      severity: VALID_SEVERITIES.includes(severity as Severity)
        ? (severity as Severity)
        : undefined,
      enabled: entry.enabled !== false,
    };
  });
}

function validateConfig(parsed: unknown): SecurityRulesConfig {
  if (!parsed || typeof parsed !== 'object') return factoryDefaultConfig();
  const obj = parsed as Record<string, unknown>;
  return {
    version: typeof obj.version === 'number' ? obj.version : CONFIG_VERSION,
    blockedRules: normalizeEntries(obj.blockedRules),
    allowedRules: normalizeEntries(obj.allowedRules),
  };
}

// ── Load / seed / reset ───────────────────────────────────────────────────

// Single-entry cache for the default-path load so the engine doesn't re-read
// the file on every getEffectiveConfig call. Cache is mtime-keyed; inject a
// filePath (tests) or pass force:true to bypass.
let cachedConfig: SecurityRulesConfig | null = null;
let cachedPath: string | null = null;
let cachedMtime = 0;

function clearCache(): void {
  cachedConfig = null;
  cachedPath = null;
  cachedMtime = 0;
}

function writeFactoryDefaults(filePath: string): void {
  writeFileSync(filePath, JSON.stringify(factoryDefaultConfig(), null, 2), 'utf8');
}

// Load the security rules config. When the file is missing it is seeded with
// factory defaults first. On any read/parse error it falls back to factory
// defaults (and never throws) so a corrupted file can't disable protection.
export function loadSecurityRulesConfig(opts?: {
  filePath?: string;
  force?: boolean;
}): SecurityRulesConfig {
  const filePath = opts?.filePath ?? getRulesFilePath();
  if (!filePath) return factoryDefaultConfig(); // non-electron env
  const useCache = !opts?.filePath && !opts?.force;
  try {
    if (!existsSync(filePath)) {
      writeFactoryDefaults(filePath);
      clearCache();
      return factoryDefaultConfig();
    }
    const stat = statSync(filePath);
    if (useCache && cachedConfig && cachedPath === filePath && stat.mtimeMs === cachedMtime) {
      return cloneConfig(cachedConfig);
    }
    const config = validateConfig(JSON.parse(readFileSync(filePath, 'utf8')));
    if (useCache) {
      cachedConfig = config;
      cachedPath = filePath;
      cachedMtime = stat.mtimeMs;
    }
    return config;
  } catch (err) {
    logger.warn(
      `[Security] Failed to load rules config from ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }. Using factory defaults.`,
    );
    return factoryDefaultConfig();
  }
}

// Seed the config file with factory defaults ONLY if it does not exist.
// Called once at app startup so the file is visible/editable for the user
// without clobbering any edits they have already made.
export function seedFactoryDefaultsIfMissing(opts?: { filePath?: string }): void {
  const filePath = opts?.filePath ?? getRulesFilePath();
  if (!filePath) return;
  try {
    if (!existsSync(filePath)) {
      writeFactoryDefaults(filePath);
      clearCache();
    }
  } catch (err) {
    logger.warn(
      `[Security] Failed to seed rules config at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }.`,
    );
  }
}

// Overwrite the config file with factory defaults, discarding user edits.
// Backs the "恢复默认" (reset to defaults) UI action.
export function resetToFactoryDefaults(opts?: { filePath?: string }): void {
  const filePath = opts?.filePath ?? getRulesFilePath();
  if (!filePath) return;
  try {
    writeFactoryDefaults(filePath);
    clearCache();
  } catch (err) {
    logger.warn(
      `[Security] Failed to reset rules config at ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }.`,
    );
  }
}

// Clear the in-memory cache so the next load re-reads the file. Backs the
// "重新加载" (reload) UI action after the user edits the file on disk.
export function reloadSecurityRulesConfig(): void {
  clearCache();
}
