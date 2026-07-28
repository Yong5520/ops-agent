// Tests for the slash-command parser (slash-commands.ts).
//
// /cost is a zero-LLM command: it queries the backend cost store directly and
// renders a system message, so the user can check token usage / estimated cost
// without the agent misinterpreting the question as a host task (the gpu-16-36
// incident). The parser must classify "/cost" as the builtin 'cost' command,
// NOT as a 'skill' invocation (which would be sent to the agent loop).

import { describe, it, expect } from 'vitest';
import { parseSlashCommand } from '../slash-commands.js';

describe('parseSlashCommand', () => {
  it('classifies "/cost" as the builtin cost command', () => {
    expect(parseSlashCommand('/cost')).toEqual({ command: 'cost' });
  });

  it('ignores trailing args after /cost (cost takes no args)', () => {
    // Users may type "/cost detail" etc. The command is still 'cost'; the
    // handler renders the full breakdown regardless.
    expect(parseSlashCommand('/cost detail')).toEqual({ command: 'cost' });
  });

  it('still classifies /compact and /context correctly (regression)', () => {
    expect(parseSlashCommand('/compact')).toEqual({
      command: 'compact',
      args: '',
      instructions: '',
    });
    expect(parseSlashCommand('/context')).toEqual({ command: 'context' });
  });

  it('returns none for a non-slash input', () => {
    expect(parseSlashCommand('list files')).toEqual({ command: 'none' });
  });
});
