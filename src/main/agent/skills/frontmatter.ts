// Simple YAML-like frontmatter parser for SKILL.md files.
//
// Supports the subset of YAML used in skill frontmatter:
//   ---
//   name: skill-name
//   description: A short description
//   when_to_use: When to use this skill
//   ---
//
// Values can be plain strings, quoted strings, or multi-line arrays.
// This is intentionally simple - no full YAML parser dependency.

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  [key: string]: string | undefined;
}

export interface ParsedSkillFile {
  frontmatter: ParsedFrontmatter;
  content: string; // markdown body (after frontmatter)
}

const FRONTMATTER_DELIMITER = /^---\s*$/;

export function parseFrontmatter(raw: string): ParsedSkillFile {
  const lines = raw.split('\n');

  // Check if the file starts with frontmatter delimiter
  if (lines.length === 0 || !FRONTMATTER_DELIMITER.test(lines[0]!.trim())) {
    // No frontmatter - entire content is the body
    return { frontmatter: {}, content: raw.trim() };
  }

  // Find the closing delimiter
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIMITER.test(lines[i]!.trim())) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    // No closing delimiter - treat entire content as body
    return { frontmatter: {}, content: raw.trim() };
  }

  const frontmatterLines = lines.slice(1, endIdx);
  const contentLines = lines.slice(endIdx + 1);

  const frontmatter: ParsedFrontmatter = {};
  for (const line of frontmatterLines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Parse key: value
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Map YAML keys to our interface
    switch (key) {
      case 'name':
        frontmatter.name = value;
        break;
      case 'description':
        frontmatter.description = value;
        break;
      case 'when_to_use':
        frontmatter.whenToUse = value;
        break;
      default:
        frontmatter[key] = value;
        break;
    }
  }

  return {
    frontmatter,
    content: contentLines.join('\n').trim(),
  };
}

// Serialize frontmatter + content back into SKILL.md format.
export function serializeSkillFile(frontmatter: ParsedFrontmatter, content: string): string {
  const lines: string[] = ['---'];

  if (frontmatter.name) {
    lines.push(`name: ${frontmatter.name}`);
  }
  if (frontmatter.description) {
    // Quote if contains special chars
    const needsQuotes = /[:#{}[\],&*?|<>=!%@`]/.test(frontmatter.description);
    lines.push(
      `description: ${needsQuotes ? `"${frontmatter.description}"` : frontmatter.description}`,
    );
  }
  if (frontmatter.whenToUse) {
    const needsQuotes = /[:#{}[\],&*?|<>=!%@`]/.test(frontmatter.whenToUse);
    lines.push(
      `when_to_use: ${needsQuotes ? `"${frontmatter.whenToUse}"` : frontmatter.whenToUse}`,
    );
  }

  lines.push('---', '', content);
  return lines.join('\n');
}
