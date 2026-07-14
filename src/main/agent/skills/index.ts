import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { settingsStore } from '../../storage/settings.js';
import { BUILTIN_SKILLS } from './builtin.js';
import { parseFrontmatter, serializeSkillFile } from './frontmatter.js';
import type { Skill } from './types.js';

// Skills loader - returns enabled skills for system prompt injection.
//
// Enablement is persisted in app_settings under "enabledSkills" as a JSON
// array of skill names. When the setting is absent, all skills with
// enabledByDefault=true are enabled.
//
// Skills come from two sources:
//   1. BUILTIN_SKILLS - hardcoded in builtin.ts
//   2. User skills - SKILL.md files in {userData}/skills/{name}/
//
// Progressive disclosure: only skill metadata (name + description) is
// injected into the system prompt. Full content is loaded via /skillName.

const ENABLED_SKILLS_KEY = 'enabledSkills';

// Cache for user-loaded skills. Cleared when skills are installed/deleted.
let userSkillsCache: Skill[] | null = null;

// Get the directory where user skills are stored.
function getSkillsDir(): string {
  return join(app.getPath('userData'), 'skills');
}

// Load all user skills from the filesystem.
function loadUserSkills(): Skill[] {
  if (userSkillsCache !== null) {
    return userSkillsCache;
  }

  const skillsDir = getSkillsDir();
  if (!existsSync(skillsDir)) {
    userSkillsCache = [];
    return userSkillsCache;
  }

  const skills: Skill[] = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(skillsDir, entry.name);
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      try {
        const raw = readFileSync(skillFile, 'utf-8');
        const { frontmatter, content } = parseFrontmatter(raw);

        const skillName = frontmatter.name ?? entry.name;
        skills.push({
          name: skillName,
          displayName: frontmatter.name ?? entry.name,
          description: frontmatter.description ?? `User skill: ${skillName}`,
          whenToUse: frontmatter.whenToUse,
          triggerKeywords: [],
          content,
          enabledByDefault: false,
          source: 'user',
          filePath: skillFile,
        });
      } catch {
        // Skip malformed skill files
      }
    }
  } catch {
    userSkillsCache = [];
    return userSkillsCache;
  }

  userSkillsCache = skills;
  return userSkillsCache;
}

// Clear the user skills cache (called after install/delete).
export function clearSkillCache(): void {
  userSkillsCache = null;
}

// Get the list of enabled skill names from settings. Falls back to
// enabledByDefault when the setting hasn't written yet.
function getEnabledSkillNames(): Set<string> {
  const stored = settingsStore.get(ENABLED_SKILLS_KEY);
  const allSkills = [...BUILTIN_SKILLS, ...loadUserSkills()];
  if (!stored) {
    return new Set(allSkills.filter((s) => s.enabledByDefault).map((s) => s.name));
  }
  try {
    const names = JSON.parse(stored) as string[];
    return new Set(names);
  } catch {
    return new Set(allSkills.filter((s) => s.enabledByDefault).map((s) => s.name));
  }
}

// Return all known skills (builtin + user).
export function listAllSkills(): Skill[] {
  return [...BUILTIN_SKILLS, ...loadUserSkills()];
}

// Return only enabled skills - these are the ones whose metadata
// gets injected into the system prompt (progressive disclosure).
export function getEnabledSkills(): Skill[] {
  const enabled = getEnabledSkillNames();
  return listAllSkills().filter((s) => enabled.has(s.name));
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

// Get the full content of a skill by name (for /skillName invocation).
export function getSkillContent(name: string): string | null {
  const skill = listAllSkills().find((s) => s.name === name);
  return skill?.content ?? null;
}

// Install a new user skill (write SKILL.md to filesystem).
export function installSkill(
  name: string,
  content: string,
  description?: string,
  whenToUse?: string,
): { ok: boolean; error?: string } {
  try {
    const skillsDir = getSkillsDir();
    const skillDir = join(skillsDir, name);
    const skillFile = join(skillDir, 'SKILL.md');

    // Create the skill directory
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    // Serialize with frontmatter
    const serialized = serializeSkillFile(
      {
        name,
        description: description ?? `User skill: ${name}`,
        whenToUse,
      },
      content,
    );

    writeFileSync(skillFile, serialized, 'utf-8');
    clearSkillCache();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Delete a user skill by name.
export function deleteSkill(name: string): { ok: boolean; error?: string } {
  try {
    const skillsDir = getSkillsDir();
    const skillDir = join(skillsDir, name);

    if (!existsSync(skillDir)) {
      return { ok: false, error: `Skill '${name}' not found` };
    }

    rmSync(skillDir, { recursive: true, force: true });
    clearSkillCache();

    // Also remove from enabled list
    const current = getEnabledSkillNames();
    current.delete(name);
    settingsStore.set(ENABLED_SKILLS_KEY, JSON.stringify([...current]));

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export * from './types.js';
