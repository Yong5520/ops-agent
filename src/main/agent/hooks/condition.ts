// Hook condition matcher.
// Condition string format:
//   '*'              -> matches all tools
//   'exec'           -> exact tool name match
//   'exec(*)'        -> tool name matches, any command/input
//   'exec(rm *)'     -> tool name matches AND input.command matches regex 'rm *'
//   'write_file(*)'  -> tool name matches, any input

export function matchCondition(
  toolName: string,
  input: Record<string, unknown>,
  condition: string,
): boolean {
  // '*' matches all tools
  if (condition === '*') return true;

  const parenIndex = condition.indexOf('(');
  if (parenIndex === -1) {
    // Exact tool name match, no pattern
    return condition === toolName;
  }

  const condToolName = condition.slice(0, parenIndex);
  if (condToolName !== toolName) return false;

  // Extract pattern between parens
  const closingParen = condition.lastIndexOf(')');
  const pattern =
    closingParen > parenIndex
      ? condition.slice(parenIndex + 1, closingParen)
      : condition.slice(parenIndex + 1);

  // '*' means any input matches
  if (pattern === '*') return true;

  // Test command against regex pattern
  const command = typeof input.command === 'string' ? input.command : '';
  try {
    const regex = new RegExp(pattern);
    return regex.test(command);
  } catch {
    // Invalid regex - no match (fail safe)
    return false;
  }
}
