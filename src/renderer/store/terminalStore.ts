import { create } from 'zustand';
import type { HostConfig } from '../../shared/types.js';

export interface TerminalTab {
  sessionId: string;
  hostId: string;
  hostName: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  type: 'ssh' | 'local';
  error?: string;
}

export interface CommandSnippet {
  id: string;
  name: string;
  command: string;
  category?: string;
  builtin?: boolean;
}

// ── Built-in command snippets ──────────────────────────────────────────────
const BUILTIN_SNIPPETS: CommandSnippet[] = [
  { id: 'bi-nvidia-smi', name: 'GPU 状态', command: 'nvidia-smi', category: '硬件', builtin: true },
  {
    id: 'bi-docker-ps',
    name: 'Docker 容器',
    command: 'docker ps -a',
    category: '容器',
    builtin: true,
  },
  {
    id: 'bi-docker-stats',
    name: 'Docker 资源',
    command: 'docker stats --no-stream',
    category: '容器',
    builtin: true,
  },
  {
    id: 'bi-systemctl',
    name: '服务状态',
    command: 'systemctl status',
    category: '系统',
    builtin: true,
  },
  { id: 'bi-df', name: '磁盘使用', command: 'df -h', category: '系统', builtin: true },
  { id: 'bi-free', name: '内存使用', command: 'free -m', category: '系统', builtin: true },
  { id: 'bi-ipaddr', name: 'IP 地址', command: 'ip addr', category: '网络', builtin: true },
  { id: 'bi-uptime', name: '运行时间', command: 'uptime', category: '系统', builtin: true },
  {
    id: 'bi-top',
    name: '进程 TOP5',
    command: 'ps aux --sort=-%cpu | head -5',
    category: '系统',
    builtin: true,
  },
  { id: 'bi-lsblk', name: '块设备', command: 'lsblk', category: '硬件', builtin: true },
  { id: 'bi-lscpu', name: 'CPU 信息', command: 'lscpu', category: '硬件', builtin: true },
  {
    id: 'bi-dmesg',
    name: '内核日志',
    command: 'dmesg --time-format iso | tail -20',
    category: '系统',
    builtin: true,
  },
  {
    id: 'bi-journal',
    name: '错误日志',
    command: 'journalctl -p err --since "1 hour ago" --no-pager | tail -20',
    category: '系统',
    builtin: true,
  },
  { id: 'bi-netstat', name: '监听端口', command: 'ss -tlnp', category: '网络', builtin: true },
  {
    id: 'bi-conntrack',
    name: '连接数',
    command: 'cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo N/A',
    category: '网络',
    builtin: true,
  },
];

// ── Snippet localStorage persistence ──────────────────────────────────────
const SNIPPETS_KEY = 'opsagent.terminal.customSnippets';
function loadCustomSnippets(): CommandSnippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (raw) return JSON.parse(raw) as CommandSnippet[];
  } catch {
    // ignore
  }
  return [];
}
function saveCustomSnippets(snippets: CommandSnippet[]): void {
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  } catch {
    // ignore
  }
}

interface TerminalStore {
  tabs: TerminalTab[];
  activeTabId: string | null;

  // Broadcast mode
  broadcastMode: boolean;
  toggleBroadcast: () => void;

  // Snippets
  builtinSnippets: CommandSnippet[];
  customSnippets: CommandSnippet[];
  addSnippet: (snippet: Omit<CommandSnippet, 'id'>) => void;
  removeSnippet: (id: string) => void;

  // Tab management
  openTab: (host: HostConfig) => Promise<void>;
  openLocalTab: () => Promise<void>;
  closeTab: (sessionId: string) => void;
  setActiveTab: (sessionId: string) => void;
  updateTabStatus: (sessionId: string, status: TerminalTab['status'], error?: string) => void;
  reorderTabs: (fromSessionId: string, toSessionId: string) => void;
  getTabByHost: (hostId: string) => TerminalTab | undefined;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  broadcastMode: false,
  builtinSnippets: BUILTIN_SNIPPETS,
  customSnippets: loadCustomSnippets(),

  toggleBroadcast: () => set({ broadcastMode: !get().broadcastMode }),

  addSnippet: (snippet) => {
    const newSnippet: CommandSnippet = {
      ...snippet,
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
    const next = [...get().customSnippets, newSnippet];
    set({ customSnippets: next });
    saveCustomSnippets(next);
  },

  removeSnippet: (id) => {
    const next = get().customSnippets.filter((s) => s.id !== id);
    set({ customSnippets: next });
    saveCustomSnippets(next);
  },

  openTab: async (host) => {
    // Always create a new terminal session (allow multiple terminals per host)
    const tempId = `temp-${Date.now()}`;
    const tab: TerminalTab = {
      sessionId: tempId,
      hostId: host.id,
      hostName: host.name,
      status: 'connecting',
      type: 'ssh' as const,
    };
    set({
      tabs: [...get().tabs, tab],
      activeTabId: tempId,
    });

    try {
      const result = await window.opsAgent.terminal.start(host.id);
      set({
        tabs: get().tabs.map((t) =>
          t.sessionId === tempId
            ? { ...t, sessionId: result.sessionId, status: 'connected' as const }
            : t,
        ),
        activeTabId: result.sessionId,
      });
    } catch (err) {
      set({
        tabs: get().tabs.map((t) =>
          t.sessionId === tempId
            ? { ...t, status: 'error' as const, error: (err as Error).message }
            : t,
        ),
      });
    }
  },

  openLocalTab: async () => {
    const tempId = `temp-local-${Date.now()}`;
    const tab: TerminalTab = {
      sessionId: tempId,
      hostId: 'local',
      hostName: '本地终端',
      status: 'connecting',
      type: 'local' as const,
    };
    set({
      tabs: [...get().tabs, tab],
      activeTabId: tempId,
    });

    try {
      const result = await window.opsAgent.terminal.startLocal();
      set({
        tabs: get().tabs.map((t) =>
          t.sessionId === tempId
            ? {
                ...t,
                sessionId: result.sessionId,
                hostName: result.hostName,
                status: 'connected' as const,
              }
            : t,
        ),
        activeTabId: result.sessionId,
      });
    } catch (err) {
      set({
        tabs: get().tabs.map((t) =>
          t.sessionId === tempId
            ? { ...t, status: 'error' as const, error: (err as Error).message }
            : t,
        ),
      });
    }
  },

  closeTab: (sessionId) => {
    // Kill the terminal session on the main process side
    window.opsAgent.terminal.kill(sessionId).catch(() => {
      // Ignore errors - the session may already be closed
    });
    set({
      tabs: get().tabs.filter((t) => t.sessionId !== sessionId),
      activeTabId:
        get().activeTabId === sessionId
          ? (get().tabs.find((t) => t.sessionId !== sessionId)?.sessionId ?? null)
          : get().activeTabId,
    });
  },

  setActiveTab: (sessionId) => {
    set({ activeTabId: sessionId });
  },

  updateTabStatus: (sessionId, status, error) => {
    set({
      tabs: get().tabs.map((t) => (t.sessionId === sessionId ? { ...t, status, error } : t)),
    });
  },

  reorderTabs: (fromSessionId, toSessionId) => {
    const tabs = [...get().tabs];
    const fromIndex = tabs.findIndex((t) => t.sessionId === fromSessionId);
    const toIndex = tabs.findIndex((t) => t.sessionId === toSessionId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
    // Remove the dragged tab and insert it at the target position
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    set({ tabs });
  },

  getTabByHost: (hostId) => get().tabs.find((t) => t.hostId === hostId),
}));
