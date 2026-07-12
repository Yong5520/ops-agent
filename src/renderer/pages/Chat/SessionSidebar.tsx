import { useEffect, useState, type KeyboardEvent } from 'react';
import { useSessionStore } from '../../store/sessionStore.js';
import { useHostStore } from '../../store/hostStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { Button } from '../../components/Button.js';
import { cn } from '../../lib/cn.js';
import type { SafetyMode } from '../../../shared/types.js';

const SAFETY_MODES: Array<{ value: SafetyMode; label: string }> = [
  { value: 'sentinel', label: '诊断' },
  { value: 'plan', label: '计划' },
  { value: 'operator', label: '标准' },
  { value: 'autopilot', label: '自主' },
];

export function SessionSidebar() {
  const {
    sessions,
    currentSession,
    hostIds,
    safetyMode,
    load,
    createSession,
    selectSession,
    deleteSession,
    setHostIds,
    setSafetyMode,
    renameSession,
  } = useSessionStore();
  const { hosts, load: loadHosts } = useHostStore();

  useEffect(() => {
    load();
    loadHosts();
  }, [load, loadHosts]);

  const toggleHost = (id: string) => {
    const next = hostIds.includes(id) ? hostIds.filter((h) => h !== id) : [...hostIds, id];
    setHostIds(next);
  };

  return (
    <div className="flex w-64 min-h-0 flex-col border-r border-zinc-800 bg-zinc-950">
      {/* New session */}
      <div className="p-3">
        <Button
          variant="primary"
          className="w-full"
          onClick={() => createSession({ hostIds, safetyMode })}
        >
          + 新建会话
        </Button>
      </div>

      {/* Session settings */}
      {currentSession && (
        <div className="space-y-2 border-y border-zinc-800 px-3 py-3">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">目标主机（可多选）</label>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900 p-1.5">
              {hosts.length === 0 && <p className="px-1 py-1 text-xs text-zinc-600">未配置主机</p>}
              {hosts.map((h) => {
                const checked = hostIds.includes(h.id);
                return (
                  <label
                    key={h.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-zinc-800"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleHost(h.id)}
                      className="h-3.5 w-3.5 accent-zinc-400"
                    />
                    <span className="flex-1 truncate text-zinc-200">{h.name}</span>
                    <span className="text-zinc-600">{h.host}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
              已选 {hostIds.length} 台 · 输入框可用 @主机名 指定
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">安全模式</label>
            <div className="flex gap-1">
              {SAFETY_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setSafetyMode(m.value)}
                  className={cn(
                    'flex-1 rounded px-2 py-1 text-xs transition-colors',
                    safetyMode === m.value
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Session list */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        <div className="mb-1 px-2 text-xs font-medium text-zinc-600">会话历史</div>
        {sessions.length === 0 && <p className="px-2 py-4 text-xs text-zinc-600">暂无会话</p>}
        {sessions.filter(Boolean).map((s) => (
          <SessionListItem
            key={s.id}
            session={s}
            isActive={currentSession?.id === s.id}
            onSelect={() => selectSession(s.id)}
            onDelete={async () => {
              const ok = await useUiStore.getState().confirm({
                message: '删除此会话？',
                confirmLabel: '删除',
                variant: 'danger',
              });
              if (ok) {
                // Await so IPC rejection is caught by the store's try/catch
                // instead of becoming an unhandled promise rejection.
                await deleteSession(s.id);
              }
            }}
            onRename={(title) => renameSession(s.id, title)}
          />
        ))}
      </div>
    </div>
  );
}

interface SessionListItemProps {
  session: { id: string; title?: string; updatedAt: string };
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

function SessionListItem({
  session,
  isActive,
  onSelect,
  onDelete,
  onRename,
}: SessionListItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? '');

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(session.title ?? '');
    setEditing(true);
  };

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  const cancel = () => {
    setEditing(false);
    setDraft(session.title ?? '');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const displayTitle = session.title ?? `会话 ${session.id.slice(0, 8)}`;

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center justify-between rounded-md px-2 py-2 transition-colors',
        isActive
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
      )}
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded border border-zinc-600 bg-zinc-900 px-1.5 py-0.5 text-sm text-zinc-100 focus:border-zinc-400 focus:outline-none"
          />
        ) : (
          <div className="truncate text-sm">{displayTitle}</div>
        )}
        {!editing && (
          <div className="text-xs text-zinc-600">
            {new Date(session.updatedAt).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        )}
      </div>
      {!editing && (
        <div className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={startEdit} title="重命名" className="text-zinc-600 hover:text-zinc-300">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="删除"
            className="text-zinc-600 hover:text-red-400"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
