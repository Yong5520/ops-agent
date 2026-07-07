import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { HostConfig, Session, AuditLog } from '../../../shared/types.js';

interface DashboardData {
  hosts: HostConfig[];
  sessions: Session[];
  auditLogs: AuditLog[];
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData>({ hosts: [], sessions: [], auditLogs: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboardData();
  }, []);

  async function loadDashboardData() {
    try {
      const [hosts, sessions, auditLogs] = await Promise.all([
        window.opsAgent.hosts.list(),
        window.opsAgent.sessions.list(),
        window.opsAgent.audit.list({ limit: 10 }),
      ]);
      setData({ hosts, sessions: sessions.slice(0, 5), auditLogs });
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-600">
        <div className="flex items-center gap-2">
          <span className="flex gap-1">
            <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.3s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.15s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500" />
          </span>
          加载中...
        </div>
      </div>
    );
  }

  const hostsByGroup = groupBy(data.hosts, (h) => h.groupName);
  const noHosts = data.hosts.length === 0;
  const noSessions = data.sessions.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-zinc-100">运维仪表盘</h1>
          <button
            onClick={loadDashboardData}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            ↻ 刷新
          </button>
        </div>

        {/* Environment Summary */}
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard
            label="主机总数"
            value={data.hosts.length}
            icon="🖥"
          />
          <SummaryCard
            label="主机分组"
            value={Object.keys(hostsByGroup).length}
            icon="📁"
          />
          <SummaryCard
            label="最近会话"
            value={data.sessions.length}
            icon="💬"
          />
        </div>

        {/* Empty state — guide user to first setup */}
        {noHosts && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center">
            <div className="text-3xl mb-2">🚀</div>
            <h3 className="text-sm font-medium text-zinc-200">欢迎使用 OpsAgent</h3>
            <p className="mt-1 text-xs text-zinc-500">
              开始前请先配置目标主机和模型供应商
            </p>
            <div className="mt-3 flex justify-center gap-2">
              <button
                onClick={() => navigate('/settings')}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
              >
                前往设置
              </button>
              <button
                onClick={() => navigate('/chat')}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                开始对话
              </button>
            </div>
          </div>
        )}

        {/* Quick Actions */}
        {!noHosts && (
          <div>
            <h2 className="mb-2 text-sm font-medium text-zinc-400">快捷操作</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <QuickAction
                label="新对话"
                icon="💬"
                onClick={() => navigate('/chat')}
              />
              <QuickAction
                label="系统诊断"
                icon="🏥"
                onClick={() => navigate('/chat')}
              />
              <QuickAction
                label="磁盘检查"
                icon="💾"
                onClick={() => navigate('/chat')}
              />
              <QuickAction
                label="安全巡检"
                icon="🔒"
                onClick={() => navigate('/chat')}
              />
            </div>
          </div>
        )}

        {/* Host Grid */}
        {data.hosts.length > 0 && (
          <div>
            <h2 className="mb-2 text-sm font-medium text-zinc-400">
              主机概览 ({data.hosts.length})
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {data.hosts.map((host) => (
                <HostCard key={host.id} host={host} onClick={() => navigate('/chat')} />
              ))}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Recent Sessions */}
          <div>
            <h2 className="mb-2 text-sm font-medium text-zinc-400">最近会话</h2>
            {noSessions ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-center text-xs text-zinc-600">
                暂无会话记录
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => navigate(`/chat/${session.id}`)}
                    className="flex w-full items-center gap-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-left hover:bg-zinc-800"
                  >
                    <span className="text-zinc-500">💬</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm text-zinc-200">
                        {session.title || '未命名会话'}
                      </div>
                      <div className="text-xs text-zinc-600">
                        {formatRelativeTime(session.updatedAt)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Recent Audit */}
          <div>
            <h2 className="mb-2 text-sm font-medium text-zinc-400">最近操作</h2>
            {data.auditLogs.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-center text-xs text-zinc-600">
                暂无操作记录
              </div>
            ) : (
              <div className="space-y-1.5">
                {data.auditLogs.slice(0, 5).map((log) => (
                  <div
                    key={log.id}
                    className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        log.exitCode === 0 ? 'bg-emerald-400' : 'bg-red-400'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-xs font-mono text-zinc-300">
                        {log.command}
                      </div>
                      <div className="text-[10px] text-zinc-600">
                        {log.hostName} · {log.commandType} · {formatRelativeTime(log.createdAt)}
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => navigate('/audit')}
                  className="w-full rounded-md border border-zinc-800 py-1.5 text-center text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                >
                  查看全部审计日志 →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────────────

function SummaryCard({ label, value, icon }: { label: string; value: number; icon: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center gap-2">
        <span className="text-lg">{icon}</span>
        <span className="text-xs text-zinc-500">{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function QuickAction({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-3 hover:bg-zinc-800 hover:border-zinc-700"
    >
      <span className="text-xl">{icon}</span>
      <span className="text-xs text-zinc-300">{label}</span>
    </button>
  );
}

function HostCard({ host, onClick }: { host: HostConfig; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left hover:bg-zinc-800 hover:border-zinc-700"
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-zinc-600" title="状态未知" />
        <span className="text-sm font-medium text-zinc-200">{host.name}</span>
      </div>
      <div className="mt-1 text-xs text-zinc-600">
        {host.host}:{host.port}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <span className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-500">
          {host.groupName}
        </span>
        <span className="text-[10px] text-zinc-600">{host.username}</span>
      </div>
    </button>
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return date.toLocaleDateString('zh-CN');
}
