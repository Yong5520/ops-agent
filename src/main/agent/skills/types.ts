// Skill type definitions.
//
// A Skill is a predefined diagnostic capability pack that can be invoked
// in chat via /skillName. Skills support progressive disclosure:
// only metadata (name + description) is injected into the system prompt,
// and the full content is loaded only when the user explicitly invokes
// the skill via /skillName.

export type SkillSource = 'builtin' | 'user';

export interface Skill {
  // Unique identifier (kebab-case)
  name: string;
  // Display name (Chinese)
  displayName: string;
  // Short description of what this skill covers
  description: string;
  // When to use this skill (shown in system prompt metadata + /context)
  whenToUse?: string;
  // Keywords that may indicate this skill is relevant to the user's request.
  // Used for future auto-enablement; currently informational.
  triggerKeywords: string[];
  // The full markdown content of the skill. Injected into the user message
  // when the user invokes /skillName (progressive disclosure - NOT in the
  // system prompt by default).
  content: string;
  // Whether this skill is enabled by default
  enabledByDefault: boolean;
  // Where this skill was loaded from
  source: SkillSource;
  // File path for user skills (undefined for builtin)
  filePath?: string;
}

// Persisted in app_settings under key "enabledSkills" as JSON string[].
// Only skill names listed here are enabled. If the setting is absent,
// all skills with enabledByDefault=true are enabled.
export type SkillName = string;
