import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../../utils/logger.js';

// CLAUDE.md loading + @include directive resolution.
//
// Loads memory files from the OpsAgent data directory:
//   1. %APPDATA%/ops-agent/CLAUDE.md (global ops instructions)
//   2. %APPDATA%/ops-agent/rules/*.md (additional rule files)
//
// Supports @include directives: @./relative/path, @/absolute/path, @~/home/path
// Recursively loads included files up to MAX_INCLUDE_DEPTH, with cycle detection.

const MAX_CLAUDE_MD_SIZE = 25_000; // 25KB limit
const MAX_INCLUDE_DEPTH = 5;
const VALID_EXTENSIONS = ['.md', '.txt', '.text'];

export interface MemoryFile {
  path: string;
  content: string;
  source: 'project' | 'rules';
}

export function getOpsAgentDataDir(): string {
  return app.getPath('userData');
}

export function getRulesDir(): string {
  return path.join(getOpsAgentDataDir(), 'rules');
}

export function getClaudeMdPath(): string {
  return path.join(getOpsAgentDataDir(), 'CLAUDE.md');
}

// Load all memory files (CLAUDE.md + rules/*.md)
export function loadProjectMemoryFiles(): MemoryFile[] {
  const files: MemoryFile[] = [];

  // 1. CLAUDE.md in data directory
  const claudeMdPath = getClaudeMdPath();
  if (fs.existsSync(claudeMdPath)) {
    try {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      if (content.length <= MAX_CLAUDE_MD_SIZE) {
        files.push({ path: claudeMdPath, content, source: 'project' });
      } else {
        logger.warn(
          `[Memory] CLAUDE.md exceeds ${MAX_CLAUDE_MD_SIZE} chars, truncating`,
        );
        files.push({
          path: claudeMdPath,
          content: content.slice(0, MAX_CLAUDE_MD_SIZE),
          source: 'project',
        });
      }
    } catch (err) {
      logger.error('[Memory] Failed to read CLAUDE.md:', err);
    }
  }

  // 2. rules/*.md files
  const rulesDir = getRulesDir();
  if (fs.existsSync(rulesDir)) {
    try {
      const ruleFiles = fs
        .readdirSync(rulesDir)
        .filter((f) => f.endsWith('.md'))
        .sort(); // alphabetical for cache stability

      for (const ruleFile of ruleFiles) {
        const fullPath = path.join(rulesDir, ruleFile);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          files.push({ path: fullPath, content, source: 'rules' });
        } catch (err) {
          logger.error(`[Memory] Failed to read rule file ${ruleFile}:`, err);
        }
      }
    } catch (err) {
      logger.error('[Memory] Failed to read rules directory:', err);
    }
  }

  return files;
}

// Process @include directives in content, recursively loading referenced files.
export function processIncludeDirectives(
  content: string,
  basePath: string,
  processedPaths: Set<string> = new Set(),
  depth: number = 0,
): string {
  if (depth >= MAX_INCLUDE_DEPTH) return content;

  const basePathDir = path.dirname(basePath);
  processedPaths.add(path.resolve(basePath));

  // Regex: @path, @./path, @~/path, @/absolute
  // Matches @ followed by a path (with escaped spaces support)
  const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let result = content;
  let match;

  while ((match = includeRegex.exec(content)) !== null) {
    let includePath = match[1];

    // Unescape spaces
    includePath = includePath.replace(/\\ /g, ' ');

    // Strip fragment identifiers
    includePath = includePath.split('#')[0];

    if (!includePath) continue;

    // Resolve path
    let resolvedPath: string;
    if (includePath.startsWith('~/')) {
      resolvedPath = path.join(process.env.HOME || process.env.USERPROFILE || '', includePath.slice(2));
    } else if (includePath.startsWith('/')) {
      resolvedPath = includePath;
    } else if (includePath.startsWith('./')) {
      resolvedPath = path.resolve(basePathDir, includePath.slice(2));
    } else {
      // Bare @path - treat as relative
      resolvedPath = path.resolve(basePathDir, includePath);
    }

    // Cycle detection
    const normalizedPath = path.resolve(resolvedPath);
    if (processedPaths.has(normalizedPath)) continue;

    // Check file exists
    if (!fs.existsSync(resolvedPath)) continue;

    // Only allow text files
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!VALID_EXTENSIONS.includes(ext)) continue;

    try {
      const includedContent = fs.readFileSync(resolvedPath, 'utf-8');

      // Recursively process @include in included content
      const processedIncluded = processIncludeDirectives(
        includedContent,
        resolvedPath,
        new Set(processedPaths),
        depth + 1,
      );

      // Replace the @path reference with the included content
      result = result.replace(match[0], processedIncluded);
    } catch (err) {
      logger.error(`[Memory] Failed to read @include ${includePath}:`, err);
    }
  }

  return result;
}

// Build the memory prompt section for system prompt injection.
export function buildMemoryPromptSection(): string {
  const files = loadProjectMemoryFiles();
  if (files.length === 0) return '';

  const sections: string[] = [];

  for (const file of files) {
    let content = file.content;

    // Process @include directives
    content = processIncludeDirectives(content, file.path);

    const label = path.basename(file.path);
    sections.push(`### ${label}\n\n${content}`);
  }

  const total = sections.join('\n\n---\n\n');

  // Truncate if over limit
  if (total.length > MAX_CLAUDE_MD_SIZE) {
    return (
      total.slice(0, MAX_CLAUDE_MD_SIZE) +
      '\n\n[WARNING: Memory content truncated at 25KB limit]'
    );
  }

  return total;
}
