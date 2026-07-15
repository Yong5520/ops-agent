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

// Safety modes for the filter dropdown. Values must match the SafetyMode
// union stored in audit_logs.safety_mode (lowercase English). Labels show
// both Chinese and English so users can find the mode they ran in.
const SAFETY_MODES: Array<{ value: SafetyMode; label: string }> = [
  { value: 'sentinel', label: '诊断模式 (Sentinel)' },
  { value: 'operator', label: '标准模式 (Operator)' },
  { value: 'autopilot', label: '自主模式 (Autopilot)' },
];

const PAGE_SIZE_OPTIONS = [50, 100, 200];

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
  // Filter holds only criteria (no limit/offset). Pagination is separate state.
  const [filter, setFilter] = useState<AuditFilter>({});
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const loadLogs = async () => {
    setLoading(true);
    try {
      const fullFilter: AuditFilter = {
        ...filter,
        limit: pageSize,
        offset: page * pageSize,
      };
      const [rows, countResult] = await Promise.all([
        window.opsAgent.audit.list(fullFilter),
        window.opsAgent.audit.count(filter),
      ]);
      setLogs(rows);
      setTotal(countResult);
      // Clamp page if data shrank (e.g. records deleted)
      const maxPage = Math.max(0, Math.ceil(countResult / pageSize) - 1);
      if (page > maxPage) setPage(maxPage);
    } finally {
      setLoading(false);
    }
  };

  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page, pageSize]);

  const updateFilter = (partial: Partial<AuditFilter>) => {
    setFilter((prev) => ({ ...prev, ...partial }));
    setPage(0);
  };

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

  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min((page + 1) * pageSize, total);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold">审计日志</h1>
        <p className="text-xs text-zinc-500">所有 SSH 操作完整记录</p>
      </header>

      {/* Filter bar */}
      <div className="space-y-2 border-b border-zinc-800 px-6 py-3">
        <div className="grid grid-cols-6 gap-2">
          <Select
            value={filter.commandType ?? ''}
            onChange={(e) =>
              updateFilter({
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
            onChange={(e) => updateFilter({ hostName: e.target.value || undefined })}
          />

          <Select
            value={filter.safetyMode ?? ''}
            onChange={(e) =>
              updateFilter({
                safetyMode: (e.target.value as SafetyMode) || undefined,
              })
            }
          >
            <option value="">所有模式</option>
            {SAFETY_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>

          <Input
            placeholder="关键词搜索"
            value={filter.keyword ?? ''}
            onChange={(e) => updateFilter({ keyword: e.target.value || undefined })}
          />

          <Button variant="secondary" onClick={loadLogs} disabled={loading}>
            {loading ? '加载中...' : '刷新'}
          </Button>
          <Button variant="ghost" onClick={() => exportLogs(logs)} disabled={logs.length === 0}>
            导出 CSV
          </Button>
        </div>
      </div>

      {/* Log table */}
      <div className="flex-1 min-h-0 overflow-auto">
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

      {/* Pagination footer */}
      <div className="flex items-center gap-4 border-t border-zinc-800 px-6 py-2 text-xs text-zinc-500">
        <span>
          共 {total} 条记录，第 {rangeStart}-{rangeEnd} 条
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Select
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
            className="w-auto"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={String(size)}>
                {size}条/页
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
          >
            上一页
          </Button>
          <span>
            第 {page + 1}/{totalPages} 页
          </span>
          <Button
            variant="ghost"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || loading}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
