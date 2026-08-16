import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  useActivityMirrorStore,
  eventMatchesView,
  ALL_HOSTS,
} from '../../store/activityMirrorStore.js';
import { formatActivityEvent } from '../../lib/ai-activity-formatter.js';
import { useHostStore } from '../../store/hostStore.js';
import type { AgentMirrorEvent } from '../../../shared/activity-mirror-types.js';
import '@xterm/xterm/css/xterm.css';

interface AiActivityTerminalProps {
  /** Session this window mirrors ('' = every session). */
  sessionId: string;
  onClose: () => void;
}

// Read-only xterm panel that mirrors, in real time, the RAW bytes the AI's
// exec channels send and receive (v24, plan option c). The main-process
// activity-mirror ring taps executor.ts / serial exec and broadcasts command
// boundaries + uncleaned chunks + finals; this window replays buffered history
// on mount then appends live events.
//
// Read-only by construction: `term.onData` is NEVER wired, so there is no input
// path. The cursor is hidden for a display-only feel; selection/copy still work.
export function AiActivityTerminal({ sessionId, onClose }: AiActivityTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Highest event seq already written for the current host view.
  const lastSeqRef = useRef(0);
  // The host view currently rendered. A change triggers a full reset + replay;
  // otherwise we write only newly-arrived matching events.
  const viewRef = useRef<string | null>(null);

  const events = useActivityMirrorStore((s) => s.events);
  const selectedHostId = useActivityMirrorStore((s) => s.selectedHostId);
  const selectHost = useActivityMirrorStore((s) => s.selectHost);
  const setEvents = useActivityMirrorStore((s) => s.setEvents);
  const append = useActivityMirrorStore((s) => s.append);
  const clear = useActivityMirrorStore((s) => s.clear);
  const hosts = useHostStore((s) => s.hosts);

  // Create the xterm instance once. Mirrors TerminalView's setup minus the
  // input/paste/search wiring (this panel is display-only).
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      scrollback: 2000,
      allowProposedApi: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e7',
        cursor: '#3f3f46',
        selectionBackground: '#27272a',
        black: '#0a0a0a',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#fafafa',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.write('\x1b[?25l'); // hide cursor (read-only display)
    termRef.current = term;
    fitRef.current = fitAddon;

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore - may fail during teardown
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Seed the buffer from the main-process ring (history replay) and subscribe
  // to live mirror events. Runs once on mount.
  useEffect(() => {
    let cancelled = false;
    // Seed: fetch history scoped to this window's session + the ALL_HOSTS view
    // (the host filter is applied client-side at render time).
    window.opsAgent.agent
      .mirrorHistory(sessionId || undefined, ALL_HOSTS)
      .then((history) => {
        if (!cancelled && history.length > 0) setEvents(history);
      })
      .catch(() => {
        // History is best-effort; live events still flow.
      });
    const off = window.opsAgent.agent.onMirrorEvent((event) => {
      // Only accept events for this window's session (empty sessionId = all).
      if (sessionId && event.sessionId !== sessionId) return;
      append(event);
    });
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Render: full replay on host-view change, else incremental write of only the
  // newly-arrived matching events. Incremental is required so a streaming output
  // doesn't reset+replay the whole log on every chunk.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const matches = (e: AgentMirrorEvent): boolean =>
      eventMatchesView(e, sessionId, selectedHostId);

    const viewChanged = viewRef.current !== selectedHostId;

    if (viewChanged) {
      viewRef.current = selectedHostId;
      term.reset();
      term.write('\x1b[?25l');
      const matching = events.filter(matches);
      term.write(matching.map(formatActivityEvent).join(''));
      lastSeqRef.current = matching.length > 0 ? matching[matching.length - 1].seq : 0;
      return;
    }

    // Same view: write only new matching events (seq is monotonic, so this is
    // safe even after the store trims old events from the front).
    const newEvents = events.filter((e) => e.seq > lastSeqRef.current && matches(e));
    for (const ev of newEvents) {
      term.write(formatActivityEvent(ev));
    }
    if (newEvents.length > 0) {
      lastSeqRef.current = newEvents[newEvents.length - 1].seq;
    }
  }, [events, sessionId, selectedHostId]);

  const handleClear = () => {
    clear();
    lastSeqRef.current = 0;
    viewRef.current = selectedHostId;
    termRef.current?.reset();
    termRef.current?.write('\x1b[?25l');
  };

  const handleCopy = () => {
    const sel = termRef.current?.getSelection();
    if (sel) window.opsAgent.clipboard.writeText(sel);
    termRef.current?.focus();
  };

  const watchableHosts = hosts;

  return (
    <div className="flex h-full w-full flex-col bg-[#0a0a0a]">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium text-zinc-300">AI 活动终端</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
          只读 · 实时镜像
        </span>
        <select
          value={selectedHostId}
          onChange={(e) => selectHost(e.target.value)}
          className="ml-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300 focus:outline-none"
          title="选择要观察的主机"
        >
          <option value={ALL_HOSTS}>全部主机</option>
          {watchableHosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          onClick={handleCopy}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="复制选区"
        >
          复制
        </button>
        <button
          onClick={handleClear}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="清屏"
        >
          清屏
        </button>
        <button
          onClick={onClose}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:text-red-400"
          title="关闭"
        >
          ✕
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
