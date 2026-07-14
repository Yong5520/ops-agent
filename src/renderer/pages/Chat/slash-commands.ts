// Slash command parser for the chat input.
//
// Detects special commands that start with '/' and returns a structured
// result so ChatPage can route them to the appropriate handler instead of
// sending them as regular user messages to the agent loop.
//
// Supported commands:
//   /compact [instructions?]  - manually trigger context compression
//   /context                  - show context usage breakdown
//   /skillName [args]         - invoke a skill by name
//
// A leading "/" followed by an unknown name is treated as a potential
// skill invocation - ChatPage will check if it matches a known skill
// name and inject the skill's content if so, otherwise send as-is.

export interface ParsedSlashCommand {
  command: 'compact' | 'context' | 'skill' | 'none';
  // For 'skill': the skill name (without leading /)
  name?: string;
  // For 'skill' and 'compact': remaining text after the command name
  args?: string;
  // For 'compact': the instructions text (same as args, semantic alias)
  instructions?: string;
}

// Built-in command names that are NOT skills. These are intercepted by the
// parser and never passed through as skill invocations.
const BUILTIN_COMMANDS = new Set(['compact', 'context']);

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const trimmed = input.trim();

  // Not a slash command
  if (!trimmed.startsWith('/')) {
    return { command: 'none' };
  }

  // Extract the first token after '/' (the command name)
  // e.g. "/compact focus on nginx" -> name="compact", args="focus on nginx"
  const rest = trimmed.slice(1); // remove leading '/'

  // Find the first space to separate command name from args
  const spaceIdx = rest.search(/\s/);
  const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

  // Empty command (just "/")
  if (!name) {
    return { command: 'none' };
  }

  // Built-in commands
  if (name === 'compact') {
    return { command: 'compact', args, instructions: args };
  }
  if (name === 'context') {
    return { command: 'context' };
  }

  // Everything else is treated as a potential skill invocation
  // ChatPage will verify the skill exists and inject its content
  if (!BUILTIN_COMMANDS.has(name)) {
    return { command: 'skill', name, args };
  }

  return { command: 'none' };
}
