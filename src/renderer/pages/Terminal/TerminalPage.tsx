import { useEffect, useState, useCallback } from 'react';
import { useHostStore } from '../../store/hostStore.js';
import { useTerminalStore } from '../../store/terminalStore.js';
import { Button } from '../../components/Button.js';
import { TerminalView } from './TerminalView.js';
import { FileTransferPanel } from './FileTransferPanel.js';
import { SnippetsBar } from './SnippetsBar.js';
import { AiCommandBar } from './AiCommandBar.js';
import { cn } from '../../lib/cn.js';
import type { HostConfig } from '../../../shared/types.js';

// Collapsed group state for the terminal host list
const COLLAPSED_KEY = 'opsagent.terminal.collapsedGroups';
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore
  }
  return new Set();
}
function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

export function TerminalPage() {
  const { hosts, load: loadHosts } = useHostStore();
  const {
    tabs,
    activeTabId,
    openTab,
    openLocalTab,
    closeTab,
    reorderTabs,
    setActiveTab,
    updateTabStatus,
    broadcastMode,
    toggleBroadcast,
  } = useTerminalStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [showFilePanel, setShowFilePanel] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showAiBar, setShowAiBar] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{
    x: number;
    y: number;
    visible: boolean;
    sessionId: string;
  }>({ x: 0, y: 0, visible: false, sessionId: '' });
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);

  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  // Listen for terminal exit events to update tab status
  useEffect(() => {
    const removeExitListener = window.opsAgent.terminal.onExit((sessionId) => {
      updateTabStatus(sessionId, 'disconnected');
    });
    return () => removeExitListener();
  }, [updateTabStatus]);

  const toggleGroup = (group: string) => {
    const next = new Set(collapsed);
    if (next.has(group)) {
      next.delete(group);
    } else {
      next.add(group);
    }
    setCollapsed(next);
    saveCollapsed(next);
  };

  // Group hosts by groupName
  const grouped = hosts.reduce(
    (acc, h) => {
      const key = h.groupName || 'default';
      (acc[key] ??= []).push(h);
      return acc;
    },
    {} as Record<string, HostConfig[]>,
  );

  const activeTab = tabs.find((t) => t.sessionId === activeTabId);

  // Reconnect a disconnected tab
  const handleReconnect = useCallback(
    (host: HostConfig) => {
      const tab = tabs.find((t) => t.hostId === host.id);
      if (tab) {
        closeTab(tab.sessionId);
        setTimeout(() => openTab(host), 100);
      }
    },
    [tabs, closeTab, openTab],
  );

  // Send a command to the active terminal
  const sendCommand = useCallback(
    (command: string) => {
      if (!activeTabId) return;
      window.opsAgent.terminal.input(activeTabId, command + '\n').catch(() => {
        // ignore - session may be closed
      });
    },
    [activeTabId],
  );

  const connectedTabs = tabs.filter((t) => t.status === 'connected');

  // Duplicate a tab (open same host or new local terminal)
  const handleDuplicateTab = useCallback(
    (sessionId: string) => {
      const tab = tabs.find((t) => t.sessionId === sessionId);
      if (!tab) return;
      if (tab.type === 'local') {
        openLocalTab();
      } else {
        const host = hosts.find((h) => h.id === tab.hostId);
        if (host) openTab(host);
      }
    },
    [tabs, hosts, openTab, openLocalTab],
  );

  // Close context menu on outside click
  useEffect(() => {
    if (!tabContextMenu.visible) return;
    const handleClick = () => setTabContextMenu((s) => ({ ...s, visible: false }));
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabContextMenu((s) => ({ ...s, visible: false }));
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [tabContextMenu.visible]);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left: host list */}
      <div className="flex w-64 min-h-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-3">
          <h1 className="text-lg font-semibold">终端</h1>
          <p className="text-xs text-zinc-500">点击主机打开交互式终端</p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {hosts.length === 0 && <p className="px-2 py-4 text-xs text-zinc-600">未配置主机</p>}
          {Object.entries(grouped).map(([group, groupHosts]) => {
            const isCollapsed = collapsed.has(group);
            return (
              <div key={group} className="mb-2">
                <button
                  onClick={() => toggleGroup(group)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-300"
                >
                  <span className="text-zinc-600">{isCollapsed ? '▸' : '▾'}</span>
                  {group}
                  <span className="text-zinc-700">({groupHosts.length})</span>
                </button>
                {!isCollapsed && (
                  <div className="mt-0.5 space-y-0.5">
                    {groupHosts.map((h) => {
                      const tab = tabs.find((t) => t.hostId === h.id);
                      const isActive = tab?.sessionId === activeTabId;
                      return (
                        <button
                          key={h.id}
                          onClick={() => openTab(h)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                            isActive
                              ? 'bg-zinc-800 text-zinc-100'
                              : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                          )}
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              tab?.status === 'connected'
                                ? 'bg-emerald-400'
                                : tab?.status === 'connecting'
                                  ? 'bg-amber-400'
                                  : tab?.status === 'error'
                                    ? 'bg-red-500'
                                    : 'bg-zinc-600',
                            )}
                          />
                          <span className="flex-1 truncate">{h.name}</span>
                          <span className="truncate text-zinc-700">{h.host}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: terminal tabs + toolbar */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {tabs.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center">
            <div className="text-4xl mb-3 opacity-30">{' />'}</div>
            <p className="text-sm text-zinc-500">点击左侧主机开始终端会话</p>
            <p className="mt-1 text-xs text-zinc-700">
              支持多标签 · 快捷键 Ctrl+Shift+T 新开 · Ctrl+W 关闭
            </p>
          </div>
        ) : (
          <>
            {/* Tab bar + toolbar */}
            <div className="flex items-center border-b border-zinc-800 bg-zinc-950">
              <div className="flex flex-1 min-w-0 items-center overflow-x-auto">
                {tabs.map((tab) => (
                  <div
                    key={tab.sessionId}
                    draggable
                    onDragStart={() => setDraggedTabId(tab.sessionId)}
                    onDragEnd={() => setDraggedTabId(null)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (draggedTabId && draggedTabId !== tab.sessionId) {
                        e.currentTarget.style.opacity = '1';
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedTabId && draggedTabId !== tab.sessionId) {
                        reorderTabs(draggedTabId, tab.sessionId);
                      }
                      setDraggedTabId(null);
                    }}
                    onClick={() => setActiveTab(tab.sessionId)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setTabContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        visible: true,
                        sessionId: tab.sessionId,
                      });
                    }}
                    className={cn(
                      'group flex shrink-0 cursor-pointer items-center gap-2 border-r border-zinc-800 px-3 py-2 text-xs transition-colors',
                      tab.sessionId === activeTabId
                        ? 'bg-zinc-900 text-zinc-100'
                        : 'text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300',
                      draggedTabId === tab.sessionId && 'opacity-40',
                    )}
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        tab.status === 'connected'
                          ? 'bg-emerald-400'
                          : tab.status === 'connecting'
                            ? 'bg-amber-400 animate-pulse'
                            : tab.status === 'reconnecting'
                              ? 'bg-amber-500 animate-pulse'
                              : tab.status === 'error'
                                ? 'bg-red-500'
                                : 'bg-zinc-600',
                      )}
                    />
                    <span className="max-w-[120px] truncate">{tab.hostName}</span>
                    {tab.type === 'local' && (
                      <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-500">
                        本地
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.sessionId);
                      }}
                      className="text-zinc-700 hover:text-red-400"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {/* + button at end of tab list - opens local terminal by default */}
                <button
                  onClick={() => openLocalTab()}
                  className="shrink-0 px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  title="新建终端"
                >
                  +
                </button>
              </div>
              {/* Toolbar buttons */}
              <div className="flex items-center gap-1 border-l border-zinc-800 px-2">
                <button
                  onClick={toggleBroadcast}
                  disabled={connectedTabs.length < 2}
                  className={cn(
                    'rounded px-2 py-1 text-xs transition-colors disabled:opacity-30',
                    broadcastMode
                      ? 'bg-amber-600/30 text-amber-400'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800',
                  )}
                  title={
                    connectedTabs.length < 2
                      ? '需要 2+ 个已连接终端'
                      : broadcastMode
                        ? '广播模式已开启 - 输入将发送到所有终端'
                        : '开启广播模式'
                  }
                >
                  📡
                </button>
                <button
                  onClick={() => setShowSnippets((v) => !v)}
                  className={cn(
                    'rounded px-2 py-1 text-xs transition-colors',
                    showSnippets
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800',
                  )}
                  title="命令片段"
                >
                  ⌘
                </button>
                <button
                  onClick={() => setShowFilePanel((v) => !v)}
                  disabled={!activeTab || activeTab.type === 'local'}
                  className={cn(
                    'rounded px-2 py-1 text-xs transition-colors disabled:opacity-30',
                    showFilePanel
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800',
                  )}
                  title={activeTab?.type === 'local' ? '本地终端不支持文件传输' : '文件传输'}
                >
                  📁
                </button>
                <button
                  onClick={() => setShowAiBar((v) => !v)}
                  disabled={!activeTab}
                  className={cn(
                    'rounded px-2 py-1 text-xs transition-colors disabled:opacity-30',
                    showAiBar
                      ? 'bg-indigo-900/30 text-indigo-400'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800',
                  )}
                  title="AI 命令助手 (Ctrl+I)"
                >
                  ✨
                </button>
              </div>
            </div>

            {/* Terminal + side panels layout */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
              {/* Terminal + AI bar column */}
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                {/* Terminal area - render ALL tabs, toggle visibility via CSS */}
                <div className="flex flex-1 min-h-0 overflow-hidden">
                  {tabs.map((tab) => (
                    <div
                      key={tab.sessionId}
                      className={cn(
                        'flex-1 min-h-0 overflow-hidden',
                        tab.sessionId === activeTabId ? 'flex' : 'hidden',
                      )}
                    >
                      {tab.status === 'error' ? (
                        <div className="flex h-full flex-col items-center justify-center">
                          <p className="text-sm text-red-400">连接失败: {tab.error}</p>
                          <Button
                            variant="primary"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                              const host = hosts.find((h) => h.id === tab.hostId);
                              if (host) handleReconnect(host);
                            }}
                          >
                            重连
                          </Button>
                        </div>
                      ) : tab.status === 'disconnected' ? (
                        <div className="flex h-full flex-col items-center justify-center">
                          <p className="text-sm text-zinc-500">连接已断开</p>
                          <Button
                            variant="primary"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                              const host = hosts.find((h) => h.id === tab.hostId);
                              if (host) handleReconnect(host);
                            }}
                          >
                            重连
                          </Button>
                        </div>
                      ) : tab.status === 'reconnecting' ? (
                        <div className="flex h-full flex-col items-center justify-center">
                          <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-400" />
                          <p className="text-sm text-amber-400">正在重连...</p>
                          <p className="mt-1 text-xs text-zinc-600">网络中断后自动尝试恢复连接</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="mt-3"
                            onClick={() => closeTab(tab.sessionId)}
                          >
                            取消
                          </Button>
                        </div>
                      ) : (
                        <TerminalView
                          sessionId={tab.sessionId}
                          hostName={tab.hostName}
                          hostId={tab.hostId}
                          isActive={tab.sessionId === activeTabId}
                          onOpenFileTransfer={() => setShowFilePanel(true)}
                          onToggleAiBar={() => setShowAiBar((v) => !v)}
                        />
                      )}
                    </div>
                  ))}
                </div>
                {/* AI command bar (bottom) */}
                {showAiBar && activeTab && (
                  <AiCommandBar
                    sessionId={activeTab.sessionId}
                    hostId={activeTab.hostId}
                    onExecute={(cmd) => {
                      window.opsAgent.terminal.input(activeTab.sessionId, cmd + '\n').catch(() => {
                        // ignore - session may be closed
                      });
                    }}
                    onClose={() => setShowAiBar(false)}
                  />
                )}
              </div>

              {/* Right side: Snippets bar */}
              {showSnippets && (
                <div className="w-64 min-h-0 border-l border-zinc-800">
                  <SnippetsBar onSendCommand={sendCommand} onClose={() => setShowSnippets(false)} />
                </div>
              )}

              {/* Right side: File transfer panel */}
              {showFilePanel && activeTab && (
                <div className="w-[28rem] min-h-0 border-l border-zinc-800">
                  <FileTransferPanel
                    hostId={activeTab.hostId}
                    hostName={activeTab.hostName}
                    onClose={() => setShowFilePanel(false)}
                  />
                </div>
              )}
            </div>

            {/* Status bar */}
            {activeTab && (
              <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950 px-4 py-1 text-xs text-zinc-600">
                <div className="flex items-center gap-3">
                  <span
                    className={
                      activeTab.status === 'connected'
                        ? 'text-emerald-400'
                        : activeTab.status === 'reconnecting'
                          ? 'text-amber-400'
                          : activeTab.status === 'error'
                            ? 'text-red-400'
                            : 'text-zinc-500'
                    }
                  >
                    {activeTab.hostName} · {activeTab.status}
                  </span>
                  {broadcastMode && connectedTabs.length > 1 && (
                    <span className="text-amber-400">
                      📡 广播模式: 输入将发送到 {connectedTabs.length} 个终端
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-700">✨ Ctrl+I AI 命令</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const host = hosts.find((h) => h.id === activeTab.hostId);
                      if (host) handleReconnect(host);
                    }}
                  >
                    重连
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => closeTab(activeTab.sessionId)}>
                    断开
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Tab context menu (right-click) */}
      {tabContextMenu.visible && (
        <div
          className="fixed z-[100] min-w-[140px] rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
          style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDuplicateTab(tabContextMenu.sessionId);
              setTabContextMenu((s) => ({ ...s, visible: false }));
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            复制当前窗口
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tabContextMenu.sessionId);
              setTabContextMenu((s) => ({ ...s, visible: false }));
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
          >
            关闭标签
          </button>
        </div>
      )}
    </div>
  );
}
