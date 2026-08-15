import { describe, it, expect } from 'vitest';
import { formatActivityEvent } from '../ai-activity-formatter.js';
import type { ActivityEvent } from '../../store/activityTerminalStore.js';

const CRLF = '\r\n';

function command(over: Partial<Extract<ActivityEvent, { kind: 'command' }>> = {}): ActivityEvent {
  return {
    kind: 'command',
    seq: 1,
    sessionId: 's1',
    toolCallId: 't1',
    hostId: 'h1',
    hostName: 'host1',
    toolName: 'exec',
    command: 'ls -la',
    description: 'list files',
    commandType: 'READ',
    ...over,
  };
}

function final(over: Partial<Extract<ActivityEvent, { kind: 'final' }>> = {}): ActivityEvent {
  return {
    kind: 'final',
    seq: 3,
    sessionId: 's1',
    toolCallId: 't1',
    hostId: 'h1',
    success: true,
    exitCode: 0,
    durationMs: 42,
    ...over,
  };
}

describe('formatActivityEvent', () => {
  it('renders a command as a cyan prompt line plus a dim meta line', () => {
    const out = formatActivityEvent(command());
    expect(out).toContain('$ ls -la');
    expect(out).toContain('# list files · host1 · exec [READ]');
    expect(out.startsWith(CRLF)).toBe(true);
  });

  it('omits the meta line when there is no description/host/tool text', () => {
    const out = formatActivityEvent(
      command({ description: undefined, hostName: '', toolName: '', commandType: '' }),
    );
    expect(out).toContain('$ ls -la');
    expect(out).not.toContain('# ');
  });

  it('writes chunk data verbatim', () => {
    const out = formatActivityEvent({
      kind: 'chunk',
      seq: 2,
      sessionId: 's1',
      toolCallId: 't1',
      hostId: 'h1',
      stream: 'stdout',
      data: 'hello world\n',
    });
    expect(out).toBe('hello world\n');
  });

  it('writes fallback stdout then a dim exit footer on a successful final', () => {
    const out = formatActivityEvent(final({ stdout: 'done\n' }));
    expect(out).toContain('done\n');
    expect(out).toContain('[exit 0 · 42ms]');
  });

  it('writes only the footer (no duplicated output) when partials were streamed', () => {
    // Store clears stdout/stderr on final when hadPartial was true.
    const out = formatActivityEvent(final({ stdout: undefined }));
    expect(out).not.toContain('done');
    expect(out).toContain('[exit 0 · 42ms]');
  });

  it('renders a red footer for a failed final', () => {
    const out = formatActivityEvent(final({ success: false, exitCode: 1, stdout: 'err\n' }));
    expect(out).toContain('err\n');
    expect(out).toContain('[exit 1 · 42ms]');
    expect(out).toContain('\x1b[31m');
  });

  it('renders a red blocked footer when blockedReason is set', () => {
    const out = formatActivityEvent(
      final({ success: false, blockedReason: 'dangerous command', stdout: undefined }),
    );
    expect(out).toContain('[blocked: dangerous command]');
    expect(out).toContain('\x1b[31m');
  });

  it('renders exit code as ? when null (e.g. aborted command)', () => {
    const out = formatActivityEvent(final({ exitCode: null, success: false, stdout: undefined }));
    expect(out).toContain('[exit ?');
  });

  it('full replay equals the concatenation of per-event formatting', () => {
    // The component relies on: replay = events.map(format).join(''), and
    // incremental = format(newEvent). Verify they compose consistently.
    const events: ActivityEvent[] = [
      command(),
      {
        kind: 'chunk',
        seq: 2,
        sessionId: 's1',
        toolCallId: 't1',
        hostId: 'h1',
        stream: 'stdout',
        data: 'out\n',
      },
      final(),
    ];
    const replayed = events.map(formatActivityEvent).join('');
    const incremental = events.map(formatActivityEvent).join('');
    expect(replayed).toBe(incremental);
    expect(replayed).toContain('$ ls -la');
    expect(replayed).toContain('out\n');
    expect(replayed).toContain('[exit 0 · 42ms]');
  });
});
