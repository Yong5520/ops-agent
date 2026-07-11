import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { useTerminalStore } from '../../store/terminalStore.js';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewProps {
  sessionId: string;
  hostName: string;
  hostId: string;
  isActive: boolean;
  onOpenFileTransfer: () => void;
  onToggleAiBar: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
}

// Floating search bar positioned over the terminal
function SearchBar({ searchAddon, onClose }: { searchAddon: SearchAddon; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    (direction: 'next' | 'prev') => {
      if (!query) return;
      const options = {
        caseSensitive,
        regex: useRegex,
        decorations: {
          matchBackground: '#eab308',
          matchOverviewRuler: '#eab308',
          activeMatchBackground: '#f97316',
          activeMatchColorOverviewRuler: '#f97316',
        },
      };
      if (direction === 'next') {
        searchAddon.findNext(query, options);
      } else {
        searchAddon.findPrevious(query, options);
      }
    },
    [query, caseSensitive, useRegex, searchAddon],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="absolute right-3 top-3 z-50 flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 shadow-xl">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="搜索..."
        className="w-40 bg-transparent text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none"
      />
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        className={cnBtn(caseSensitive)}
        title="区分大小写"
      >
        Aa
      </button>
      <button onClick={() => setUseRegex((v) => !v)} className={cnBtn(useRegex)} title="正则表达式">
        .*
      </button>
      <div className="mx-0.5 h-4 w-px bg-zinc-700" />
      <button
        onClick={() => doSearch('prev')}
        className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="上一个 (Shift+Enter)"
      >
        ↑
      </button>
      <button
        onClick={() => doSearch('next')}
        className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="下一个 (Enter)"
      >
        ↓
      </button>
      <button
        onClick={onClose}
        className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:text-red-400"
        title="关闭 (Esc)"
      >
        ×
      </button>
    </div>
  );
}

function cnBtn(active: boolean): string {
  return active
    ? 'rounded px-1.5 py-0.5 text-[10px] font-bold bg-yellow-600 text-white'
    : 'rounded px-1.5 py-0.5 text-[10px] font-bold text-zinc-500 hover:text-zinc-300';
}

// Right-click context menu
function ContextMenu({
  state,
  onClose,
  actions,
}: {
  state: ContextMenuState;
  onClose: () => void;
  actions: {
    onCopy: () => void;
    onPaste: () => void;
    onUpload: () => void;
    onDownload: () => void;
    onClear: () => void;
    onSearch: () => void;
    onExport: () => void;
  };
}) {
  useEffect(() => {
    if (!state.visible) return;
    const handleClick = () => onClose();
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [state.visible, onClose]);

  if (!state.visible) return null;

  const items: Array<{ label: string; action: () => void; icon: string }> = [
    { label: '复制', action: actions.onCopy, icon: '📋' },
    { label: '粘贴', action: actions.onPaste, icon: '📌' },
    { label: '搜索 (Ctrl+F)', action: actions.onSearch, icon: '🔍' },
    { label: '清屏', action: actions.onClear, icon: '🧹' },
    { label: '导出输出', action: actions.onExport, icon: '💾' },
    { label: '上传文件', action: actions.onUpload, icon: '⬆' },
    { label: '下载文件', action: actions.onDownload, icon: '⬇' },
  ];

  return (
    <div
      className="fixed z-[100] min-w-[160px] rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
      style={{ left: state.x, top: state.y }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={(e) => {
            e.stopPropagation();
            item.action();
            onClose();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <span className="w-4 text-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function TerminalView({
  sessionId,
  hostName,
  isActive,
  onOpenFileTransfer,
  onToggleAiBar,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const { updateTabStatus, tabs, broadcastMode } = useTerminalStore();
  const [showSearch, setShowSearch] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false });

  // Keep refs in sync for broadcast mode (avoids stale closure in onData)
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const broadcastModeRef = useRef(broadcastMode);
  useEffect(() => {
    broadcastModeRef.current = broadcastMode;
  }, [broadcastMode]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm.js terminal instance
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
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
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(serializeAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    serializeRef.current = serializeAddon;

    // Forward user input to the SSH shell (with broadcast support)
    const inputDisposable = term.onData((data) => {
      window.opsAgent.terminal.input(sessionId, data);
      // Broadcast mode: send same input to all other connected tabs
      if (broadcastModeRef.current) {
        for (const tab of tabsRef.current) {
          if (tab.sessionId !== sessionId && tab.status === 'connected') {
            window.opsAgent.terminal.input(tab.sessionId, data).catch(() => {
              // Ignore broadcast errors - other sessions may have closed
            });
          }
        }
      }
    });

    // Handle resize: send new dimensions to SSH shell
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.opsAgent.terminal.resize(sessionId, cols, rows);
    });

    // Listen for shell output from the main process
    const removeDataListener = window.opsAgent.terminal.onData((sid, data) => {
      if (sid === sessionId) {
        term.write(data);
      }
    });

    // Listen for stream exit
    const removeExitListener = window.opsAgent.terminal.onExit((sid, info) => {
      if (sid === sessionId) {
        if (info.reason === 'reconnecting') {
          term.write('\r\n\x1b[33m[正在重连...]\x1b[0m\r\n');
          updateTabStatus(sessionId, 'reconnecting');
        } else if (info.reason === 'reconnect-failed') {
          term.write('\r\n\x1b[31m[重连失败: 网络不可达]\x1b[0m\r\n');
          updateTabStatus(sessionId, 'disconnected');
        } else {
          term.write('\r\n\x1b[31m[连接已断开]\x1b[0m\r\n');
          updateTabStatus(sessionId, 'disconnected');
        }
      }
    });

    // Listen for successful reconnect
    const removeReconnectListener = window.opsAgent.terminal.onReconnect((sid) => {
      if (sid === sessionId) {
        term.write('\r\n\x1b[32m[重连成功]\x1b[0m\r\n');
        updateTabStatus(sessionId, 'connected');
      }
    });

    // Send initial size to the shell
    window.opsAgent.terminal.resize(sessionId, term.cols, term.rows);

    // Handle container resize via ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore - may fail during initial render
      }
    });
    resizeObserver.observe(containerRef.current);

    // Ctrl+F to search, Ctrl+Shift+C/V for copy/paste, Ctrl+I to toggle AI bar
    // (attachCustomKeyEventHandler returns void - handler is disposed with terminal)
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
        return false;
      }
      if (e.ctrlKey && e.key === 'i') {
        e.preventDefault();
        onToggleAiBar();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {
            // ignore clipboard errors
          });
        }
        return false;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              window.opsAgent.terminal.input(sessionId, text);
            }
          })
          .catch(() => {
            // ignore clipboard errors
          });
        return false;
      }
      return true;
    });

    term.focus();

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      removeDataListener();
      removeExitListener();
      removeReconnectListener();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
      serializeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Focus terminal + refit when this tab becomes active
  useEffect(() => {
    if (isActive && termRef.current && fitRef.current) {
      const timer = setTimeout(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          // ignore
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive]);

  // ── Context menu actions ──────────────────────────────────────────────
  const handleCopy = () => {
    const selection = termRef.current?.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {
        // ignore
      });
    }
  };

  const handlePaste = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          window.opsAgent.terminal.input(sessionId, text);
        }
      })
      .catch(() => {
        // ignore
      });
  };

  const handleClear = () => {
    termRef.current?.clear();
  };

  const handleExport = () => {
    if (!serializeRef.current || !termRef.current) return;
    const content = serializeRef.current.serialize();
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `终端输出_${hostName}_${timestamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
  };

  const contextMenuActions = {
    onCopy: handleCopy,
    onPaste: handlePaste,
    onUpload: onOpenFileTransfer,
    onDownload: onOpenFileTransfer,
    onClear: handleClear,
    onSearch: () => setShowSearch(true),
    onExport: handleExport,
  };

  return (
    <div className="relative flex h-full w-full flex-col" onContextMenu={handleContextMenu}>
      {showSearch && searchAddonRef.current && (
        <SearchBar searchAddon={searchAddonRef.current} onClose={() => setShowSearch(false)} />
      )}
      <ContextMenu
        state={contextMenu}
        onClose={() => setContextMenu((s) => ({ ...s, visible: false }))}
        actions={contextMenuActions}
      />
      <div ref={containerRef} className="flex-1 overflow-hidden bg-[#0a0a0a] px-2 py-1" />
      <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-1 text-xs text-zinc-600">
        <span>{hostName}</span>
        <div className="flex items-center gap-2">
          {broadcastMode && isActive && <span className="text-amber-400">📡 广播模式</span>}
          <button
            onClick={() => setShowSearch(true)}
            className="text-zinc-600 hover:text-zinc-300"
            title="搜索 (Ctrl+F)"
          >
            🔍
          </button>
          <button onClick={handleClear} className="text-zinc-600 hover:text-zinc-300" title="清屏">
            🧹
          </button>
          <button
            onClick={handleExport}
            className="text-zinc-600 hover:text-zinc-300"
            title="导出终端输出"
          >
            💾
          </button>
        </div>
      </div>
    </div>
  );
}
