import { app } from 'electron';
import { join, relative, isAbsolute, basename } from 'node:path';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { settingsStore } from '../../storage/settings.js';
import { BUILTIN_SKILLS } from './builtin.js';
import { parseFrontmatter, serializeSkillFile } from './frontmatter.js';
import type { Skill, SkillFile } from './types.js';

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
// Skill files (scripts/references/assets) are listed in a manifest appended
// to the skill content; individual files are read on-demand via
// read_skill_file tool.

const ENABLED_SKILLS_KEY = 'enabledSkills';

// Recognized subdirectory names within a skill directory.
const SKILL_SUBDIRS = ['scripts', 'references', 'assets'] as const;

// Maximum chars to read as a file preview for the manifest.
const PREVIEW_MAX_CHARS = 200;

// Cache for user-loaded skills. Cleared when skills are installed/deleted.
let userSkillsCache: Skill[] | null = null;

// Get the directory where user skills are stored.
function getSkillsDir(): string {
  return join(app.getPath('userData'), 'skills');
}

// Read the first N bytes of a file and return a preview string.
// Returns empty string for binary files (detected by null bytes).
function readFilePreview(filePath: string, maxChars: number): string {
  try {
    const buf = readFileSync(filePath);
    // Check for binary content (null bytes in first 1024 bytes)
    const checkLen = Math.min(buf.length, 1024);
    for (let i = 0; i < checkLen; i++) {
      if (buf[i] === 0) return ''; // Binary file - no preview
    }
    const text = buf.toString('utf-8', 0, Math.min(buf.length, maxChars * 3));
    // Take first `maxChars` chars, collapse to single line for manifest
    const preview = text.slice(0, maxChars).replace(/\n/g, ' ').trim();
    return preview;
  } catch {
    return '';
  }
}

// Scan a skill's subdirectories for files. Returns SkillFile arrays
// for scripts, references, and assets categories.
function scanSkillFiles(skillDir: string): {
  scripts: SkillFile[];
  references: SkillFile[];
  assets: SkillFile[];
} {
  const result = {
    scripts: [] as SkillFile[],
    references: [] as SkillFile[],
    assets: [] as SkillFile[],
  };

  for (const subdir of SKILL_SUBDIRS) {
    const subdirPath = join(skillDir, subdir);
    if (!existsSync(subdirPath)) continue;

    try {
      const entries = readdirSync(subdirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = join(subdir, entry.name);
        const fullPath = join(skillDir, filePath);
        try {
          const stat = statSync(fullPath);
          result[subdir].push({
            path: filePath.replace(/\\/g, '/'), // Normalize for cross-platform
            category:
              subdir === 'scripts' ? 'script' : subdir === 'references' ? 'reference' : 'asset',
            size: stat.size,
            preview: readFilePreview(fullPath, PREVIEW_MAX_CHARS),
          });
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Skip subdirs we can't read
    }
  }

  return result;
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
        const files = scanSkillFiles(skillDir);
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
          scripts: files.scripts,
          references: files.references,
          assets: files.assets,
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

// Build the file manifest string appended to skill content.
function buildFileManifest(skill: Skill): string {
  const sections: string[] = [];

  if (skill.references.length > 0) {
    sections.push('参考文档 (references/):');
    for (const f of skill.references) {
      sections.push(`- \`${f.path}\` (${formatSize(f.size)})${f.preview ? ` - ${f.preview}` : ''}`);
    }
  }

  if (skill.scripts.length > 0) {
    sections.push('脚本 (scripts/):');
    for (const f of skill.scripts) {
      sections.push(`- \`${f.path}\` (${formatSize(f.size)})${f.preview ? ` - ${f.preview}` : ''}`);
    }
  }

  if (skill.assets.length > 0) {
    sections.push('资源 (assets/):');
    for (const f of skill.assets) {
      sections.push(`- \`${f.path}\` (${formatSize(f.size)})`);
    }
  }

  if (sections.length === 0) return '';

  return `\n\n---\n## 可用文件清单\n\n${sections.join('\n')}\n\n使用 read_skill_file 工具按路径读取文件内容。脚本可通过 exec/sudo_exec 在远程主机执行（先 cat 内容或 SFTP 上传）。`;
}

// Format file size for human-readable display.
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Get the full content of a skill by name (for /skillName invocation).
// Appends a file manifest if the skill has scripts/references/assets.
export function getSkillContent(name: string): string | null {
  const skill = listAllSkills().find((s) => s.name === name);
  if (!skill) return null;
  const manifest = buildFileManifest(skill);
  return manifest ? `${skill.content}${manifest}` : skill.content;
}

// Resolve a skill directory path by skill name.
function getSkillDir(name: string): string {
  return join(getSkillsDir(), name);
}

// Validate that a relative file path stays within the skill directory.
// Returns the resolved absolute path if safe, or null if path traversal detected.
function resolveSafePath(skillName: string, filePath: string): string | null {
  const skillDir = getSkillDir(skillName);
  // Normalize the input path - handle both / and \ separators
  const normalized = filePath.replace(/\\/g, '/');

  // Reject any path containing ..
  if (normalized.split('/').some((segment) => segment === '..')) {
    return null;
  }

  const resolved = join(skillDir, normalized);
  // Ensure the resolved path is within the skill directory
  const rel = relative(skillDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

// Read a file from a skill directory by relative path.
export function readSkillFile(
  skillName: string,
  filePath: string,
): { ok: boolean; content?: string; error?: string } {
  const resolved = resolveSafePath(skillName, filePath);
  if (!resolved) {
    return { ok: false, error: 'Invalid file path (path traversal blocked)' };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }
  try {
    const content = readFileSync(resolved, 'utf-8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// List all files in a skill directory (scripts + references + assets).
export function listSkillFiles(skillName: string): SkillFile[] {
  const skill = listAllSkills().find((s) => s.name === skillName);
  if (!skill) return [];
  return [...skill.scripts, ...skill.references, ...skill.assets];
}

// Write (create or overwrite) a file in a skill directory.
export function writeSkillFile(
  skillName: string,
  filePath: string,
  content: string,
): { ok: boolean; error?: string } {
  const resolved = resolveSafePath(skillName, filePath);
  if (!resolved) {
    return { ok: false, error: 'Invalid file path (path traversal blocked)' };
  }
  // Ensure the parent directory exists
  const parentDir = join(resolved, '..');
  try {
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(resolved, content, 'utf-8');
    clearSkillCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// Delete a file from a skill directory.
export function deleteSkillFile(
  skillName: string,
  filePath: string,
): { ok: boolean; error?: string } {
  const resolved = resolveSafePath(skillName, filePath);
  if (!resolved) {
    return { ok: false, error: 'Invalid file path (path traversal blocked)' };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }
  try {
    unlinkSync(resolved);
    clearSkillCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// File entry for installSkill's optional files parameter.
export interface SkillFileInput {
  path: string; // Relative path within skill dir, e.g. "scripts/check.sh"
  content: string;
}

// Install a new user skill (write SKILL.md to filesystem).
// Optionally writes additional files (scripts/references/assets).
export function installSkill(
  name: string,
  content: string,
  description?: string,
  whenToUse?: string,
  files?: SkillFileInput[],
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

    // Write additional files if provided
    if (files && files.length > 0) {
      for (const file of files) {
        const resolved = resolveSafePath(name, file.path);
        if (!resolved) {
          return { ok: false, error: `Invalid file path: ${file.path}` };
        }
        const parentDir = join(resolved, '..');
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        writeFileSync(resolved, file.content, 'utf-8');
      }
    }

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

// Import a skill from a local directory. Reads SKILL.md from the source
// directory and copies recognized scripts/references/assets subdirs.
// If no SKILL.md is found, returns an error. If no recognized subdirs exist,
// the skill is installed with SKILL.md only (no files copied).
export function importSkillFromDirectory(
  srcPath: string,
  skillName?: string,
): { ok: boolean; error?: string; name?: string } {
  try {
    if (!existsSync(srcPath)) {
      return { ok: false, error: 'Source directory does not exist' };
    }

    // Read SKILL.md from source
    const srcSkillFile = join(srcPath, 'SKILL.md');
    if (!existsSync(srcSkillFile)) {
      return { ok: false, error: 'No SKILL.md found in selected directory' };
    }

    const raw = readFileSync(srcSkillFile, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(raw);

    // Determine skill name: explicit > frontmatter > directory name
    const name = skillName || frontmatter.name || basename(srcPath);

    // Collect files from recognized subdirs
    const files: SkillFileInput[] = [];
    for (const subdir of SKILL_SUBDIRS) {
      const srcSubdir = join(srcPath, subdir);
      if (!existsSync(srcSubdir)) continue;
      try {
        const entries = readdirSync(srcSubdir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const srcFilePath = join(srcSubdir, entry.name);
          try {
            const fileContent = readFileSync(srcFilePath, 'utf-8');
            files.push({
              path: `${subdir}/${entry.name}`,
              content: fileContent,
            });
          } catch {
            // Skip files we can't read (binary, permission, etc.)
          }
        }
      } catch {
        // Skip subdirs we can't read
      }
    }

    // Install the skill with files
    const result = installSkill(
      name,
      content,
      frontmatter.description,
      frontmatter.whenToUse,
      files.length > 0 ? files : undefined,
    );

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export * from './types.js';
