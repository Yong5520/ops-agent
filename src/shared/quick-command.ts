// Quick command parser for the chat input.
//
// Detects commands that start with '>' or '$' prefix and extracts the
// shell command + optional @host mention. These commands are executed
// directly via SSH without going through the AI agent loop.
//
// This prevents the critical bug where ">ls @test" was sent to the AI
// as a regular message, causing the AI to interpret it as a work request
// and start doing unsolicited tasks.

export interface ParsedQuickCommand {
  isQuickCommand: boolean;
  command?: string;
  hostName?: string;
  prefix?: '>' | '$';
}

export function parseQuickCommand(input: string): ParsedQuickCommand {
  const trimmed = input.trim();

  // Must start with > or $ prefix
  if (trimmed.length < 2 || (trimmed[0] !== '>' && trimmed[0] !== '$')) {
    return { isQuickCommand: false };
  }

  const prefix = trimmed[0] as '>' | '$';
  const rest = trimmed.slice(1).trim();

  // Empty command after prefix
  if (!rest) {
    return { isQuickCommand: false };
  }

  // Extract @host mention from the rest
  // Pattern: command @hostName or command@hostName
  // The host name is the text after @ until whitespace or end
  const hostMatch = rest.match(/@(\S+)/);
  let command = rest;
  let hostName: string | undefined;

  if (hostMatch && hostMatch.index !== undefined) {
    hostName = hostMatch[1];
    // Remove the @host part from the command
    // Also clean up any trailing space before @
    const beforeHost = rest.slice(0, hostMatch.index).trimEnd();
    const afterHost = rest.slice(hostMatch.index + hostMatch[0].length).trim();
    command = afterHost ? `${beforeHost} ${afterHost}` : beforeHost;
  }

  // Final validation: command must not be empty after extracting host
  if (!command) {
    return { isQuickCommand: false };
  }

  return {
    isQuickCommand: true,
    command,
    hostName,
    prefix,
  };
}
