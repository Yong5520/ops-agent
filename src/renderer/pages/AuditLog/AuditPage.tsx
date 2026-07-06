import { useEffect, useState } from 'react';
import type { AuditLog, AuditFilter, CommandType, SafetyMode } from '../../../shared/types.js';
import { Select, Input } from '../../components/Form.js';
import { Button } from '../../components/Button.js';
import { cn } from '../../lib/cn.js';

const COMMAND_TYPES: Array<{ value: CommandType; label: string }> = [
  { value: 'READ', label: 'READ' },
  { value: 'WRITE', label: 'WRITE' },
  { value: 'SUDO', label: 'SUDO' },
  { value: 'BLOCKED', label: 'BLOCKED' },
];

const TYPE_STYLES: Record<string, string> = {
  READ: 'bg-zinc-800 text-zinc-300',
  WRITE: 'bg-amber-900 text-amber-300',
  SUDO: 'bg-red-900 text-red-300',
  BLOCKED: 'bg-red-950 text-red-400',
};

const AUTH_STYLES: Record<string, string> = {
  auto: 'text-zinc-500',
  approved: 'text-emerald-400',
  rejected: 'text-amber-400',
  blocked: 'text-red-400',
};

export function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<AuditFilter>({ limit: 200 });

  const loadLogs = async () => {
    setLoading(true);
    try {
      const result = await window.opsAgent.audit.list(filter);
      setLogs(result);
    } finally {
      setLoading(false);
    }
  };

  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const exportLogs = (rows: AuditLog[]) => {
    const headers = [
      '时间',
      '主机',
      'IP',
      '安全模式',
      '命令类型',
      '命令',
      '描述',
      '授权',
      '返回码',
      '耗时(ms)',
    ];
    const escape = (s: string | undefined) => `"${(s ?? '').replace(/"/g, '""')}"`;
    const csvLines = [
      headers.join(','),
      ...rows.map((r) =>
        [
          r.createdAt,
          r.hostName,
          r.hostIp,
          r.safetyMode,
          r.commandType,
          r.command,
          r.description,
          r.authorization,
          r.exitCode?.toString() ?? '',
          r.durationMs?.toString() ?? '',
        ]
          .map(escape)
          .join(','),
      ),
    ];
    const csv = '\uFEFF' + csvLines.join('\n'); // BOM for Excel compatibility
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold">审计日志</h1>
        <p className="text-xs text-zinc-500">所有 SSH 操作完整记录</p>
      </header>

      {/* Filter bar */}
      <div className="space-y-2 border-b border-zinc-800 px-6 py-3">
        <div className="grid grid-cols-5 gap-2">
          <Select
            value={filter.commandType ?? ''}
            onChange={(e) =>
              setFilter({
                ...filter,
                commandType: (e.target.value as CommandType) || undefined,
              })
            }
          >
            <option value="">所有类型</option>
            {COMMAND_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>

          <Input
            placeholder="主机名"
            value={filter.hostName ?? ''}
            onChange={(e) => setFilter({ ...filter, hostName: e.target.value || undefined })}
          />

          <Input
            placeholder="安全模式"
            value={filter.safetyMode ?? ''}
            onChange={(e) =>
              setFilter({ ...filter, safetyMode: (e.target.value as SafetyMode) || undefined })
            }
          />

          <Input
            placeholder="关键词搜索"
            value={filter.keyword ?? ''}
            onChange={(e) => setFilter({ ...filter, keyword: e.target.value || undefined })}
          />

          <Button variant="secondary" onClick={loadLogs} disabled={loading}>
            {loading ? '加载中...' : '刷新'}
          </Button>
          <Button variant="ghost" onClick={() => exportLogs(logs)} disabled={logs.length === 0}>
            导出 CSV
          </Button>
        </div>
        <div className="text-xs text-zinc-600">共 {logs.length} 条记录</div>
      </div>

      {/* Log table */}
      <div className="flex-1 overflow-auto">
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            暂无审计日志
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-950 text-xs text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-3 py-2 text-left">时间</th>
                <th className="px-3 py-2 text-left">主机</th>
                <th className="px-3 py-2 text-left">类型</th>
                <th className="px-3 py-2 text-left">命令</th>
                <th className="px-3 py-2 text-left">授权</th>
                <th className="px-3 py-2 text-left">耗时</th>
                <th className="px-3 py-2 text-left">返回码</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-zinc-900 hover:bg-zinc-900/50">
                  <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400 whitespace-nowrap">
                    {log.hostName}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-mono',
                        TYPE_STYLES[log.commandType],
                      )}
                    >
                      {log.commandType}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <code className="text-xs text-zinc-300 font-mono break-all max-w-md block">
                      {log.command}
                    </code>
                    {log.description && (
                      <div className="mt-0.5 text-xs text-zinc-600 italic">{log.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn('text-xs', AUTH_STYLES[log.authorization])}>
                      {log.authorization}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {log.durationMs != null ? `${log.durationMs}ms` : '-'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {log.exitCode != null ? (
                      <span
                        className={cn(
                          'font-mono',
                          log.exitCode === 0 ? 'text-emerald-400' : 'text-red-400',
                        )}
                      >
                        {log.exitCode}
                      </span>
                    ) : (
                      <span className="text-zinc-600">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
