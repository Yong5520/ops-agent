import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock electron's app.getPath to return a temp directory
const testDir = mkdtempSync(join(tmpdir(), 'ops-agent-skills-test-'));

vi.mock('electron', () => ({
  app: {
    getPath: () => testDir,
  },
}));

// Mock settingsStore - skills enablement not needed for these tests
vi.mock('../../storage/settings.js', () => ({
  settingsStore: {
    get: () => null,
    set: () => undefined,
  },
}));

// Import after mocks are set up
import {
  listAllSkills,
  getSkillContent,
  readSkillFile,
  installSkill,
  listSkillFiles,
  writeSkillFile,
  deleteSkillFile,
  importSkillFromDirectory,
  clearSkillCache,
} from '../skills/index.js';

function createSkillDir(name: string) {
  const skillDir = join(testDir, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  return skillDir;
}

function writeSkillMd(skillDir: string, name: string, content: string) {
  const skillFile = join(skillDir, 'SKILL.md');
  const serialized = `---\nname: ${name}\ndescription: Test skill ${name}\n---\n${content}`;
  writeFileSync(skillFile, serialized, 'utf-8');
}

describe('skills loader', () => {
  beforeEach(() => {
    clearSkillCache();
  });

  afterEach(() => {
    // Clean up skills directory between tests
    const skillsDir = join(testDir, 'skills');
    if (existsSync(skillsDir)) {
      rmSync(skillsDir, { recursive: true, force: true });
    }
    clearSkillCache();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('loadUserSkills - subdir scanning', () => {
    it('loads scripts, references, and assets arrays correctly', () => {
      const skillDir = createSkillDir('test-skill');
      writeSkillMd(skillDir, 'test-skill', 'Test content');

      // Create subdirs with files
      mkdirSync(join(skillDir, 'scripts'));
      writeFileSync(join(skillDir, 'scripts', 'check.sh'), '#!/bin/bash\necho hello', 'utf-8');

      mkdirSync(join(skillDir, 'references'));
      writeFileSync(
        join(skillDir, 'references', 'spec.md'),
        '# API Spec\nSome documentation',
        'utf-8',
      );

      mkdirSync(join(skillDir, 'assets'));
      writeFileSync(join(skillDir, 'assets', 'template.json'), '{"key":"value"}', 'utf-8');

      const all = listAllSkills();
      const skill = all.find((s) => s.name === 'test-skill');
      expect(skill).toBeDefined();
      expect(skill!.scripts).toHaveLength(1);
      expect(skill!.references).toHaveLength(1);
      expect(skill!.assets).toHaveLength(1);

      expect(skill!.scripts[0]!.path).toBe('scripts/check.sh');
      expect(skill!.scripts[0]!.category).toBe('script');
      expect(skill!.scripts[0]!.size).toBeGreaterThan(0);
      expect(skill!.scripts[0]!.preview).toContain('echo hello');

      expect(skill!.references[0]!.path).toBe('references/spec.md');
      expect(skill!.references[0]!.category).toBe('reference');

      expect(skill!.assets[0]!.path).toBe('assets/template.json');
      expect(skill!.assets[0]!.category).toBe('asset');
    });

    it('returns empty arrays for skills without subdirs', () => {
      const skillDir = createSkillDir('simple-skill');
      writeSkillMd(skillDir, 'simple-skill', 'Simple content');

      const all = listAllSkills();
      const skill = all.find((s) => s.name === 'simple-skill');
      expect(skill).toBeDefined();
      expect(skill!.scripts).toHaveLength(0);
      expect(skill!.references).toHaveLength(0);
      expect(skill!.assets).toHaveLength(0);
    });

    it('binary files in assets get empty preview', () => {
      const skillDir = createSkillDir('binary-skill');
      writeSkillMd(skillDir, 'binary-skill', 'Binary test');

      mkdirSync(join(skillDir, 'assets'));
      // Write a file with null bytes (binary)
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
      writeFileSync(join(skillDir, 'assets', 'image.png'), binaryContent);

      const all = listAllSkills();
      const skill = all.find((s) => s.name === 'binary-skill');
      expect(skill).toBeDefined();
      expect(skill!.assets).toHaveLength(1);
      expect(skill!.assets[0]!.preview).toBe('');
    });
  });

  describe('getSkillContent - manifest', () => {
    it('appends file manifest when skill has files', () => {
      const skillDir = createSkillDir('manifest-skill');
      writeSkillMd(skillDir, 'manifest-skill', 'Diagnostic content');

      mkdirSync(join(skillDir, 'references'));
      writeFileSync(join(skillDir, 'references', 'guide.md'), 'Guide content', 'utf-8');

      const content = getSkillContent('manifest-skill');
      expect(content).toContain('Diagnostic content');
      expect(content).toContain('可用文件清单');
      expect(content).toContain('references/guide.md');
      expect(content).toContain('read_skill_file');
    });

    it('does not append manifest when skill has no files', () => {
      const skillDir = createSkillDir('no-files-skill');
      writeSkillMd(skillDir, 'no-files-skill', 'Plain content');

      const content = getSkillContent('no-files-skill');
      expect(content).toBe('Plain content');
      expect(content).not.toContain('可用文件清单');
    });

    it('returns null for non-existent skill', () => {
      expect(getSkillContent('does-not-exist')).toBeNull();
    });
  });

  describe('readSkillFile', () => {
    it('returns file content for valid path', () => {
      const skillDir = createSkillDir('read-skill');
      writeSkillMd(skillDir, 'read-skill', 'Content');

      mkdirSync(join(skillDir, 'scripts'));
      writeFileSync(join(skillDir, 'scripts', 'run.sh'), 'echo test', 'utf-8');

      const result = readSkillFile('read-skill', 'scripts/run.sh');
      expect(result.ok).toBe(true);
      expect(result.content).toBe('echo test');
    });

    it('blocks path traversal with ..', () => {
      const skillDir = createSkillDir('traversal-skill');
      writeSkillMd(skillDir, 'traversal-skill', 'Content');

      // Try to escape the skill directory
      const result = readSkillFile('traversal-skill', '../../../etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('blocks path traversal with encoded ..', () => {
      const skillDir = createSkillDir('encoded-skill');
      writeSkillMd(skillDir, 'encoded-skill', 'Content');

      const result = readSkillFile('encoded-skill', 'scripts/../../../etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('returns error for non-existent file', () => {
      const skillDir = createSkillDir('missing-file-skill');
      writeSkillMd(skillDir, 'missing-file-skill', 'Content');

      const result = readSkillFile('missing-file-skill', 'scripts/nonexistent.sh');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('installSkill with files', () => {
    it('writes SKILL.md and additional files', () => {
      const result = installSkill('install-test', 'Test content', 'Test description', undefined, [
        { path: 'scripts/setup.sh', content: '#!/bin/bash\nsetup' },
        { path: 'references/api.md', content: '# API\nDocumentation' },
        { path: 'assets/config.json', content: '{"key":"value"}' },
      ]);

      expect(result.ok).toBe(true);

      const skillDir = join(testDir, 'skills', 'install-test');
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'scripts', 'setup.sh'))).toBe(true);
      expect(existsSync(join(skillDir, 'references', 'api.md'))).toBe(true);
      expect(existsSync(join(skillDir, 'assets', 'config.json'))).toBe(true);

      const scriptContent = readFileSync(join(skillDir, 'scripts', 'setup.sh'), 'utf-8');
      expect(scriptContent).toBe('#!/bin/bash\nsetup');

      // Verify files are discoverable after install
      const all = listAllSkills();
      const skill = all.find((s) => s.name === 'install-test');
      expect(skill).toBeDefined();
      expect(skill!.scripts).toHaveLength(1);
      expect(skill!.references).toHaveLength(1);
      expect(skill!.assets).toHaveLength(1);
    });

    it('works without files param (backward compat)', () => {
      const result = installSkill('simple-install', 'Simple content', 'Simple desc');
      expect(result.ok).toBe(true);

      const skillDir = join(testDir, 'skills', 'simple-install');
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    });

    it('rejects invalid file paths in install', () => {
      const result = installSkill('bad-paths', 'Content', 'Desc', undefined, [
        { path: '../../../etc/bad', content: 'malicious' },
      ]);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid file path');
    });
  });

  describe('listSkillFiles', () => {
    it('returns all files across categories', () => {
      const skillDir = createSkillDir('list-files-skill');
      writeSkillMd(skillDir, 'list-files-skill', 'Content');

      mkdirSync(join(skillDir, 'scripts'));
      writeFileSync(join(skillDir, 'scripts', 'a.sh'), 'a', 'utf-8');
      writeFileSync(join(skillDir, 'scripts', 'b.sh'), 'b', 'utf-8');

      mkdirSync(join(skillDir, 'references'));
      writeFileSync(join(skillDir, 'references', 'doc.md'), 'doc', 'utf-8');

      const files = listSkillFiles('list-files-skill');
      expect(files).toHaveLength(3);
      expect(files.filter((f) => f.category === 'script')).toHaveLength(2);
      expect(files.filter((f) => f.category === 'reference')).toHaveLength(1);
    });

    it('returns empty for non-existent skill', () => {
      expect(listSkillFiles('non-existent')).toEqual([]);
    });
  });

  describe('writeSkillFile', () => {
    it('writes a file to a skill directory', () => {
      createSkillDir('write-skill');
      writeSkillMd(join(testDir, 'skills', 'write-skill'), 'write-skill', 'Content');

      const result = writeSkillFile('write-skill', 'scripts/new.sh', 'echo new');
      expect(result.ok).toBe(true);

      const content = readFileSync(
        join(testDir, 'skills', 'write-skill', 'scripts', 'new.sh'),
        'utf-8',
      );
      expect(content).toBe('echo new');
    });

    it('blocks path traversal', () => {
      createSkillDir('write-traversal');
      writeSkillMd(join(testDir, 'skills', 'write-traversal'), 'write-traversal', 'Content');

      const result = writeSkillFile('write-traversal', '../../../etc/bad', 'malicious');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('path traversal');
    });
  });

  describe('deleteSkillFile', () => {
    it('deletes a file from a skill directory', () => {
      const skillDir = createSkillDir('delete-skill');
      writeSkillMd(skillDir, 'delete-skill', 'Content');

      mkdirSync(join(skillDir, 'scripts'));
      const filePath = join(skillDir, 'scripts', 'temp.sh');
      writeFileSync(filePath, 'temp', 'utf-8');
      expect(existsSync(filePath)).toBe(true);

      const result = deleteSkillFile('delete-skill', 'scripts/temp.sh');
      expect(result.ok).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it('blocks path traversal', () => {
      createSkillDir('delete-traversal');
      writeSkillMd(join(testDir, 'skills', 'delete-traversal'), 'delete-traversal', 'Content');

      const result = deleteSkillFile('delete-traversal', '../../../etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('path traversal');
    });
  });

  describe('importSkillFromDirectory', () => {
    it('imports a skill with files from a directory', () => {
      // Create source directory
      const srcDir = mkdtempSync(join(tmpdir(), 'skill-import-src-'));
      try {
        writeFileSync(
          join(srcDir, 'SKILL.md'),
          '---\nname: imported-skill\ndescription: Imported\n---\nImported content',
          'utf-8',
        );

        mkdirSync(join(srcDir, 'scripts'));
        writeFileSync(join(srcDir, 'scripts', 'check.sh'), 'echo check', 'utf-8');

        mkdirSync(join(srcDir, 'references'));
        writeFileSync(join(srcDir, 'references', 'guide.md'), 'Guide', 'utf-8');

        const result = importSkillFromDirectory(srcDir);
        expect(result.ok).toBe(true);
        expect(result.name).toBe('imported-skill');

        // Verify skill was installed with files
        const skillDir = join(testDir, 'skills', 'imported-skill');
        expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
        expect(existsSync(join(skillDir, 'scripts', 'check.sh'))).toBe(true);
        expect(existsSync(join(skillDir, 'references', 'guide.md'))).toBe(true);

        const all = listAllSkills();
        const skill = all.find((s) => s.name === 'imported-skill');
        expect(skill).toBeDefined();
        expect(skill!.scripts).toHaveLength(1);
        expect(skill!.references).toHaveLength(1);
      } finally {
        rmSync(srcDir, { recursive: true, force: true });
      }
    });

    it('returns error when no SKILL.md found', () => {
      const srcDir = mkdtempSync(join(tmpdir(), 'skill-import-noskill-'));
      try {
        const result = importSkillFromDirectory(srcDir);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('SKILL.md');
      } finally {
        rmSync(srcDir, { recursive: true, force: true });
      }
    });

    it('returns error when source directory does not exist', () => {
      const result = importSkillFromDirectory('/nonexistent/path/xyz');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });
});
