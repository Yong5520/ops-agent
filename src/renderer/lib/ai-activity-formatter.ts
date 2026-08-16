// Pure formatter that turns a single activity/mirror event into the exact
// string to write into the read-only xterm panel. Stateless and DOM-free so
// it is unit-testable in the node vitest environment.
//
// The input is a structural type: both the legacy tool-call ActivityEvent and
// the v24 raw-channel AgentMirrorEvent satisfy it, so the same formatter
// renders history replays and live mirror chunks. One function, two call
// sites (full replay + incremental live write) - no duplicated logic.

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const CRLF = '\r\n';

// Structural event shapes the formatter reads. Optional fields are tolerated
// when absent (mirror finals carry no stdout; legacy chunks may lack hostName).
export interface FormattedCommandEvent {
  kind: 'command';
  seq: number;
  command: string;
  description?: string;
  hostName?: string;
  toolName?: string;
  commandType?: string;
}

export interface FormattedChunkEvent {
  kind: 'chunk';
  seq: number;
  data: string;
}

export interface FormattedFinalEvent {
  kind: 'final';
  seq: number;
  success: boolean;
  exitCode?: number | null;
  durationMs?: number;
  stderr?: string;
  // Legacy final events carry fallback stdout (written before the footer when
  // no partial chunks were streamed). Mirror finals never set it.
  stdout?: string;
  blockedReason?: string;
}

export type FormattedEvent =
  | FormattedCommandEvent
  | FormattedChunkEvent
  | FormattedFinalEvent;

function exitFooter(ev: FormattedFinalEvent): string {
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

export function formatActivityEvent(ev: FormattedEvent): string {
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
      // Streamed output is written verbatim. For the legacy store this is the
      // cleaned chunk; for the v24 mirror it is the RAW bytes the AI's channel
      // received (ANSI/pager prompts included) - exactly what the AI saw.
      return ev.data;
    case 'final': {
      // Fallback stdout/stderr is only present when no partial chunks were
      // streamed - write it before the footer so a fast command still shows
      // its output.
      let out = '';
      if (ev.stdout) out += ev.stdout;
      if (ev.stderr) out += ev.stderr;
      out += exitFooter(ev);
      return out;
    }
  }
}
