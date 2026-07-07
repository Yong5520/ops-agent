import { settingsStore } from '../../storage/settings.js';
import { BUILTIN_SKILLS } from './builtin.js';
import type { Skill } from './types.js';

// Skills loader — returns enabled skills for system prompt injection.
//
// Enablement is persisted in app_settings under "enabledSkills" as a JSON
// array of skill names. When the setting is absent, all skills with
// enabledByDefault=true are enabled.

const ENABLED_SKILLS_KEY = 'enabledSkills';

// Get the list of enabled skill names from settings. Falls back to
// enabledByDefault when the setting hasn't been written yet.
function getEnabledSkillNames(): Set<string> {
  const stored = settingsStore.get(ENABLED_SKILLS_KEY);
  if (!stored) {
    return new Set(
      BUILTIN_SKILLS.filter((s) => s.enabledByDefault).map((s) => s.name),
    );
  }
  try {
    const names = JSON.parse(stored) as string[];
    return new Set(names);
  } catch {
    // Corrupt JSON — fall back to defaults
    return new Set(
      BUILTIN_SKILLS.filter((s) => s.enabledByDefault).map((s) => s.name),
    );
  }
}

// Return all known skills (built-in for now; user skills can be added later).
export function listAllSkills(): Skill[] {
  return [...BUILTIN_SKILLS];
}

// Return only enabled skills — these are the ones whose promptFragment
// gets injected into the system prompt.
export function getEnabledSkills(): Skill[] {
  const enabled = getEnabledSkillNames();
  return BUILTIN_SKILLS.filter((s) => enabled.has(s.name));
}

// Enable or disable a skill by name.
export function setSkillEnabled(name: string, enabled: boolean): void {
  const current = getEnabledSkillNames();
  if (enabled) {
    current.add(name);
  } else {
    current.delete(name);
  }
  settingsStore.set(ENABLED_SKILLS_KEY, JSON.stringify([...current]));
}

export * from './types.js';
