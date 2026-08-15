// Network-device pager handling.
//
// Switches and routers (Huawei VRP, Cisco IOS, H3C, Juniper, ...) paginate
// command output with a `---- More ----` prompt and block waiting for a
// keypress (Space = next page). Over a non-interactive SSH exec channel the
// device never exits - it sits at the prompt - so the executor's `close` event
// never fires and the command times out.
//
// This module owns the three pieces needed to keep the output flowing:
//   1. detectPagerPrompt  - tail-anchored, chunk-safe detection that the
//      device is currently blocked at a pager prompt.
//   2. stripPagerArtifacts - remove prompt lines so the model sees clean,
//      continuous output (the prompt is a display artifact, not data).
//   3. createPagerAdvancer - per-exec state machine that sends an advance key
//      (Space) on each detected prompt, with a runaway cap and a double-send
//      guard so a single prompt is only advanced once.
//
// Tail-anchored detection is intentional: a `More` prompt earlier in the
// stream was already advanced past and must not re-trigger. Only a prompt at
// the current buffer tail means "blocked right now".

// Key sent to advance to the next page. Space = next page on every device
// family we target (VRP, IOS, H3C, Junos); Enter would only scroll one line.
export const PAGER_ADVANCE_KEY = ' ';

// Safety cap on the number of pages we will auto-advance before giving up and
// letting the host timeout bound a runaway command (e.g. `display logbuffer`
// on a device with a huge buffer). 2000 pages * ~24 lines/page ~ 48k lines,
// well past anything useful; reaching it indicates a misbehaving command.
export const MAX_PAGER_ADVANCES = 2000;

// ANSI escape sequences: CSI (`ESC [ ... letter`), charset designators, and
// the BEL terminator. PTY-mode devices emit these to redraw the pager prompt;
// they must be stripped before prompt detection and (in PTY mode) from the
// output returned to the model. Legitimately contains control chars
// (ESC = \x1b, BEL = \x07) - hence the targeted rule disable.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB012]|\x1b[=>]|\x1b#\d|\x07/g;

/** Remove ANSI escape sequences from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// The "More" prompt family: 2+ dashes, "More", 2+ dashes, optional trailing
// `NN%` percentage (Huawei VRP shows `  ---- More ----  45%`). Case-insensitive
// to also catch `more`/`MORE`. Matches: `  ---- More ----` (VRP/H3C),
// `--More--` (Cisco), `-- More --` (misc).
const MORE_PROMPT_RE = /-{2,}\s*More\s*-{2,}(?:\s+\d+%)?/i;
// less/more end-of-content marker.
const END_PROMPT_RE = /\(END\)/i;

// Tail-anchored versions: the prompt must be at the very end of the (cleaned)
// buffer, optionally followed by trailing whitespace.
const MORE_TAIL_RE = /-{2,}\s*More\s*-{2,}(?:\s+\d+%)?\s*$/i;
const END_TAIL_RE = /\(END\)\s*$/i;

/**
 * Does `buffer` currently end in a pager prompt? Tail-anchored and chunk-safe:
 * only the last 64 characters are examined, after stripping ANSI escapes and
 * trailing whitespace. A prompt earlier in the stream returns false.
 */
export function detectPagerPrompt(buffer: string): boolean {
  if (!buffer) return false;
  const tail = buffer.slice(-64);
  const cleaned = stripAnsi(tail).replace(/[ \t\r\n]+$/g, '');
  return MORE_TAIL_RE.test(cleaned) || END_TAIL_RE.test(cleaned);
}

/**
 * Remove pager prompt lines/marks from `text` so the model sees continuous
 * output. Handles both newline-terminated prompts (VRP/H3C) and inline prompts
 * with no surrounding newline (Cisco `--More--`), plus the `(END)` marker.
 */
export function stripPagerArtifacts(text: string): string {
  if (!text) return text;
  return text
    .replace(/[ \t]*-{2,}\s*More\s*-{2,}(?:\s+\d+%)?[ \t]*\r?\n?/gi, '')
    .replace(/[ \t]*\(END\)[ \t]*\r?\n?/gi, '');
}

export interface PagerAdvancerOptions {
  /** Invoked to send the advance key (Space) to the remote stream. */
  onAdvance: () => void;
  /** Max pages to advance before giving up. Defaults to MAX_PAGER_ADVANCES. */
  maxAdvances?: number;
}

export interface PagerAdvancer {
  /**
   * Feed a new stdout chunk. Returns true if an advance was sent for this
   * chunk. Internally tail-anchored, so a prompt split across chunks is
   * detected only once the completing chunk arrives.
   */
  consumeChunk: (text: string) => boolean;
  /** Total advances sent so far. */
  getAdvanceCount: () => number;
}

/**
 * Per-exec pager state machine. Tracks whether we are awaiting the device's
 * response to a sent Space (`pendingAdvance`) so the same prompt is not
 * advanced twice: after sending, the device blocks and emits no new data until
 * it processes the key, so the next chunk to arrive is the response - which
 * clears the pending flag before re-scanning for another page.
 *
 * Only the last ~256 characters of the stream are retained for detection, so
 * memory is bounded for very long paginated outputs.
 */
export function createPagerAdvancer(opts: PagerAdvancerOptions): PagerAdvancer {
  const max = opts.maxAdvances ?? MAX_PAGER_ADVANCES;
  let buffer = '';
  let pendingAdvance = false;
  let count = 0;

  return {
    consumeChunk(text: string): boolean {
      buffer += text;
      // New data arrived. If we were awaiting a response to a sent Space, this
      // is it - clear the guard before re-scanning (the response may itself end
      // in another page prompt).
      if (pendingAdvance) {
        pendingAdvance = false;
      }
      if (!pendingAdvance && detectPagerPrompt(buffer) && count < max) {
        opts.onAdvance();
        count += 1;
        pendingAdvance = true;
        // Bound memory: keep only the tail needed for the next detection.
        if (buffer.length > 256) buffer = buffer.slice(-256);
        return true;
      }
      if (buffer.length > 256) buffer = buffer.slice(-256);
      return false;
    },
    getAdvanceCount(): number {
      return count;
    },
  };
}

// Re-export the prompt regexes for callers that need to test full lines (e.g.
// stripping in a streaming context). Not used by the executor directly.
export { MORE_PROMPT_RE, END_PROMPT_RE };
