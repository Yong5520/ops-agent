// Skill type definitions.
//
// A Skill is a predefined diagnostic capability pack that injects domain
// knowledge and a diagnostic procedure into the system prompt. Skills help
// the AI follow structured diagnostic methodology instead of ad-hoc
// command construction.

export interface Skill {
  // Unique identifier (kebab-case)
  name: string;
  // Display name (Chinese)
  displayName: string;
  // Short description of what this skill covers
  description: string;
  // Keywords that may indicate this skill is relevant to the user's request.
  // Used for future auto-enablement; currently informational.
  triggerKeywords: string[];
  // The prompt fragment injected into the system prompt when this skill
  // is enabled. Should contain: when to use, diagnostic steps, key
  // commands, what to look for. Keep under ~500 tokens.
  promptFragment: string;
  // Whether this skill is enabled by default
  enabledByDefault: boolean;
}

// Persisted in app_settings under key "enabledSkills" as JSON string[].
// Only skill names listed here are enabled. If the setting is absent,
// all skills with enabledByDefault=true are enabled.
export type SkillName = string;
