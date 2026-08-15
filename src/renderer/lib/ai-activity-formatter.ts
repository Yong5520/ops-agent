import type { ActivityEvent } from '../store/activityTerminalStore.js';

// Pure formatter that turns a single logged activity event into the exact
// string to write into the read-only xterm panel. Stateless and DOM-free so it
// is unit-testable in the node vitest environment.
//
// The full panel content for a host view is just `events.map(formatActivityEvent).join('')`,
// and incremental live writes are `formatActivityEvent(newEvent)`. One function,
// two call sites - no duplicated formatting logic to drift.

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const CRLF = '\r\n';

function exitFooter(ev: Extract<ActivityEvent, { kind: 'final' }>): string {
  const dur = ev.durationMs != null ? ` · ${ev.durationMs}ms` : '';
  const code = ev.exitCode ?? '?';
  if (ev.blockedReason) {
    return `${CRLF}${RED}[blocked: ${ev.blockedReason}]${RESET}${CRLF}`;
  }
  if (ev.success) {
    return `${CRLF}${DIM}[exit ${code}${dur}]${RESET}${CRLF}`;
  }
  return `${CRLF}${RED}[exit ${code}${dur}]${RESET}${CRLF}`;
}

export function formatActivityEvent(ev: ActivityEvent): string {
  switch (ev.kind) {
    case 'command': {
      // Prompt line in cyan, then a dim meta line (description · host · tool).
      let out = `${CRLF}${CYAN}$ ${ev.command}${RESET}${CRLF}`;
      const parts: string[] = [];
      if (ev.description?.trim()) parts.push(ev.description);
      if (ev.hostName?.trim()) parts.push(ev.hostName);
      // Tool segment: "exec [READ]" - but only when a tool name is present, and
      // the command-type bracket only when non-empty (avoids emitting " []").
      if (ev.toolName?.trim()) {
        parts.push(ev.commandType?.trim() ? `${ev.toolName} [${ev.commandType}]` : ev.toolName);
      }
      if (parts.length > 0) {
        out += `${DIM}# ${parts.join(' · ')}${RESET}${CRLF}`;
      }
      return out;
    }
    case 'chunk':
      // Streamed output is written verbatim - it is already cleaned (ANSI /
      // pager artifacts stripped) by the executor's `clean()` before reaching
      // the renderer. Tinting stderr here would only add noise.
      return ev.data;
    case 'final': {
      // Fallback stdout/stderr is only present when no partial chunks were
      // streamed (the store clears them otherwise) - write it before the
      // footer so a fast command still shows its output.
      let out = '';
      if (ev.stdout) out += ev.stdout;
      if (ev.stderr) out += ev.stderr;
      out += exitFooter(ev);
      return out;
    }
  }
}
