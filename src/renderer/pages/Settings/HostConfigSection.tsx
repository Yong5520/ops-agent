import { useEffect, useState, useCallback } from 'react';
import { useHostStore } from '../../store/hostStore.js';
import { Button } from '../../components/Button.js';
import { Input, Field, Select } from '../../components/Form.js';
import type { HostConfig, HostInput, AuthType } from '../../../shared/types.js';

interface HostStatus {
  hostId: string;
  state: string;
  circuit: 'closed' | 'open' | 'half-open';
  circuitReason?: string;
  latencyMs?: number;
  testing?: boolean;
  testError?: string;
}

// Collapsed group state - persisted in localStorage
const COLLAPSED_KEY = 'opsagent.collapsedGroups';
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

export function HostConfigSection() {
  const { hosts, load, create, update, remove } = useHostStore();
  const [editing, setEditing] = useState<HostConfig | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, HostStatus>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState('');

  useEffect(() => {
    load();
    // Load initial connection status
    window.opsAgent.hosts.listStatus().then((list) => {
      const map = new Map<string, HostStatus>();
      for (const s of list) {
        map.set(s.hostId, {
          hostId: s.hostId,
          state: s.state,
          circuit: s.circuit,
          circuitReason: s.circuitReason,
        });
      }
      setStatuses(map);
    });
  }, [load]);

  const testConnection = useCallback(async (hostId: string) => {
    setStatuses((prev) => {
      const next = new Map(prev);
      const s = next.get(hostId) ?? { hostId, state: 'disconnected', circuit: 'closed' as const };
      next.set(hostId, { ...s, testing: true, testError: undefined });
      return next;
    });
    try {
      const result = await window.opsAgent.hosts.testConnection(hostId);
      setStatuses((prev) => {
        const next = new Map(prev);
        const s = next.get(hostId) ?? { hostId, state: 'disconnected', circuit: 'closed' as const };
        next.set(hostId, {
          ...s,
          testing: false,
          state: result.ok ? 'connected' : 'disconnected',
          latencyMs: result.latencyMs,
          testError: result.error,
          circuit: 'closed',
        });
        return next;
      });
    } catch (err) {
      setStatuses((prev) => {
        const next = new Map(prev);
        const s = next.get(hostId) ?? { hostId, state: 'disconnected', circuit: 'closed' as const };
        next.set(hostId, { ...s, testing: false, testError: (err as Error).message });
        return next;
      });
    }
  }, []);

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

  const handleRenameGroup = async (oldName: string) => {
    const trimmed = groupEditName.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingGroup(null);
      return;
    }
    await window.opsAgent.hosts.renameGroup(oldName, trimmed);
    await load();
    setEditingGroup(null);
    setGroupEditName('');
  };

  const handleDeleteGroup = async (groupName: string) => {
    if (!confirm(`删除分组"${groupName}"？组内主机会移至 default 分组。`)) return;
    await window.opsAgent.hosts.deleteGroup(groupName);
    await load();
  };

  // Group hosts by groupName for organized display
  const grouped = hosts.reduce(
    (acc, h) => {
      const key = h.groupName || 'default';
      (acc[key] ??= []).push(h);
      return acc;
    },
    {} as Record<string, HostConfig[]>,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">目标主机</h2>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setShowImport(true)}>
            批量导入
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + 添加主机
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {hosts.length === 0 && !showForm && (
          <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-600">
            尚未配置任何主机。点击"添加主机"或"批量导入"开始。
          </p>
        )}
        {Object.entries(grouped).map(([group, groupHosts]) => {
          const isCollapsed = collapsed.has(group);
          return (
            <div key={group}>
              {/* Group header with collapse + rename/delete actions */}
              <div className="group flex items-center gap-1.5 mb-1.5">
                <button
                  onClick={() => toggleGroup(group)}
                  className="text-zinc-600 hover:text-zinc-400"
                  title={isCollapsed ? '展开' : '折叠'}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
                {editingGroup === group ? (
                  <input
                    autoFocus
                    value={groupEditName}
                    onChange={(e) => setGroupEditName(e.target.value)}
                    onBlur={() => handleRenameGroup(group)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameGroup(group);
                      if (e.key === 'Escape') {
                        setEditingGroup(null);
                        setGroupEditName('');
                      }
                    }}
                    className="rounded border border-zinc-600 bg-zinc-900 px-1.5 py-0.5 text-xs font-medium text-zinc-200 focus:border-zinc-400 focus:outline-none"
                  />
                ) : (
                  <span
                    className="text-xs font-medium text-zinc-500 cursor-pointer hover:text-zinc-300"
                    onClick={() => toggleGroup(group)}
                  >
                    {group}
                    <span className="text-zinc-700 ml-1">({groupHosts.length})</span>
                  </span>
                )}
                {editingGroup !== group && group !== 'default' && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => {
                        setEditingGroup(group);
                        setGroupEditName(group);
                      }}
                      title="重命名分组"
                      className="text-zinc-700 hover:text-zinc-400 text-xs px-1"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => handleDeleteGroup(group)}
                      title="删除分组"
                      className="text-zinc-700 hover:text-red-400 text-xs px-1"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              {!isCollapsed && (
                <div className="space-y-2">
                  {groupHosts.map((h) => {
                    const status = statuses.get(h.id);
                    const isConnected = status?.state === 'connected';
                    const circuitOpen = status?.circuit === 'open';
                    return (
                      <div
                        key={h.id}
                        className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                circuitOpen
                                  ? 'bg-red-500'
                                  : isConnected
                                    ? 'bg-emerald-400'
                                    : 'bg-zinc-600'
                              }`}
                              title={
                                circuitOpen
                                  ? (status?.circuitReason ?? '断路器已触发')
                                  : isConnected
                                    ? `已连接${status?.latencyMs ? ` · ${status.latencyMs}ms` : ''}`
                                    : '未连接'
                              }
                            />
                            <span className="text-sm font-medium text-zinc-100">{h.name}</span>
                          </div>
                          <div className="truncate text-xs text-zinc-500">
                            {h.username}@{h.host}:{h.port} ·{' '}
                            {h.authType === 'password' ? '密码' : '密钥'}
                          </div>
                          {status?.testError && (
                            <div className="mt-0.5 text-xs text-red-400">⚠ {status.testError}</div>
                          )}
                          {status?.latencyMs != null && !status?.testError && (
                            <div className="mt-0.5 text-xs text-emerald-400/60">
                              延迟 {status.latencyMs}ms
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => testConnection(h.id)}
                            disabled={status?.testing}
                          >
                            {status?.testing ? '测试中...' : '测试'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditing(h);
                              setShowForm(true);
                            }}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (confirm(`确定删除主机 "${h.name}"？`)) {
                                await remove(h.id);
                              }
                            }}
                          >
                            删除
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showForm && (
        <HostForm
          editing={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSave={async (input) => {
            if (editing) {
              await update(editing.id, input);
            } else {
              await create(input);
            }
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={async () => {
            await load();
            setShowImport(false);
          }}
        />
      )}
    </div>
  );
}

function HostForm({
  editing,
  onSave,
  onClose,
}: {
  editing: HostConfig | null;
  onSave: (input: HostInput) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(editing?.port ?? 22);
  const [username, setUsername] = useState(editing?.username ?? '');
  const [authType, setAuthType] = useState<AuthType>(editing?.authType ?? 'password');
  const [password, setPassword] = useState('');
  const [keyPath, setKeyPath] = useState(editing?.keyPath ?? '');
  const [sudoPassword, setSudoPassword] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [groupName, setGroupName] = useState(editing?.groupName ?? 'default');
  const [timeoutMs, setTimeoutMs] = useState(editing?.timeoutMs ?? 60000);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const input: HostInput = {
        name: name.trim(),
        host: host.trim(),
        port,
        username: username.trim(),
        authType,
        password: password || undefined,
        keyPath: keyPath || undefined,
        sudoPassword: sudoPassword || undefined,
        suPassword: suPassword || undefined,
        groupName: groupName.trim(),
        timeoutMs,
      };
      await onSave(input);
    } catch (err) {
      setFormError((err as Error).message || '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="mt-10 mb-10 w-full max-w-2xl space-y-3 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <h3 className="text-sm font-semibold text-zinc-200">
            {editing ? '编辑主机' : '添加主机'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        {formError && (
          <div className="rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {formError}
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="名称（别名）">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="n110"
              required
            />
          </Field>
          <Field label="主机地址">
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="10.31.10.110"
              required
            />
          </Field>
          <Field label="端口">
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              required
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="用户名">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              required
            />
          </Field>
          <Field label="认证方式">
            <Select value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
              <option value="password">密码</option>
              <option value="key">SSH 密钥</option>
            </Select>
          </Field>
          <Field label="分组">
            <Input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="default"
            />
          </Field>
        </div>
        {authType === 'password' ? (
          <Field label="密码">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editing ? '••••（留空不修改）' : '输入密码'}
              required={!editing}
            />
          </Field>
        ) : (
          <Field label="密钥文件路径">
            <Input
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_rsa"
              required={!editing}
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="sudo 密码（可选）">
            <Input
              type="password"
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
              placeholder={editing ? '••••（留空不修改）' : '用于 sudo 提权'}
            />
          </Field>
          <Field label="su 密码（可选）">
            <Input
              type="password"
              value={suPassword}
              onChange={(e) => setSuPassword(e.target.value)}
              placeholder={editing ? '••••（留空不修改）' : '用于 su 持久 root shell'}
            />
          </Field>
        </div>
        <Field label="命令超时（毫秒）">
          <Input
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
          />
        </Field>
        <div className="flex justify-end gap-2 border-t border-zinc-800 pt-3">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? '保存中...' : editing ? '保存' : '添加'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// CSV/TSV batch import modal
// Format: name,host,port,username,authType,groupName
// password column is optional and can be left empty
function ImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<HostInput[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    errors: Array<{ row: number; name: string; error: string }>;
  } | null>(null);

  const parse = () => {
    const lines = text.trim().split('\n').filter((l) => l.trim());
    const parsed: HostInput[] = [];
    const errs: string[] = [];

    // Detect delimiter: tab or comma
    const delim = lines[0]?.includes('\t') ? '\t' : ',';
    const headers = lines[0]?.split(delim).map((h) => h.trim().toLowerCase());

    // Check if first line is a header
    const hasHeader =
      headers &&
      (headers.includes('name') ||
        headers.includes('host') ||
        headers.includes('username'));
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const defaultFields = ['name', 'host', 'port', 'username', 'authtype', 'groupname'];

    for (let i = 0; i < dataLines.length; i++) {
      const row = dataLines[i];
      const cells = row.split(delim).map((c) => c.trim());
      const fields = hasHeader ? headers! : defaultFields;

      const get = (field: string): string | undefined => {
        const idx = fields.indexOf(field);
        if (idx < 0 || idx >= cells.length) return undefined;
        const val = cells[idx];
        return val || undefined;
      };

      const name = get('name');
      const host = get('host');
      const portStr = get('port') ?? '22';
      const username = get('username');
      const authType = (get('authtype') ?? 'password') as 'password' | 'key';
      const groupName = get('groupname') ?? 'default';
      const password = get('password');
      const keyPath = get('keypath');

      if (!name) {
        errs.push(`第 ${i + (hasHeader ? 2 : 1)} 行: 缺少 name`);
        continue;
      }
      if (!host) {
        errs.push(`第 ${i + (hasHeader ? 2 : 1)} 行: 缺少 host`);
        continue;
      }
      if (!username) {
        errs.push(`第 ${i + (hasHeader ? 2 : 1)} 行: 缺少 username`);
        continue;
      }
      const port = Number(portStr);
      if (isNaN(port) || port < 1 || port > 65535) {
        errs.push(`第 ${i + (hasHeader ? 2 : 1)} 行: 端口无效 "${portStr}"`);
        continue;
      }

      parsed.push({
        name,
        host,
        port,
        username,
        authType,
        password: authType === 'password' ? password : undefined,
        keyPath: authType === 'key' ? keyPath : undefined,
        groupName,
        timeoutMs: 60000,
      });
    }

    setPreview(parsed);
    setErrors(errs);
    setResult(null);
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await window.opsAgent.hosts.batchCreate(preview);
      setResult({ created: res.created.length, errors: res.errors });
      if (res.errors.length === 0) {
        await onImported();
      }
    } catch (err) {
      setResult({
        created: 0,
        errors: [{ row: -1, name: '(all)', error: (err as Error).message }],
      });
    } finally {
      setImporting(false);
    }
  };

  const exampleCsv = `name,host,port,username,authType,groupName
n110,10.31.10.110,22,root,password,GPU集群
n111,10.31.10.111,22,root,password,GPU集群
web01,10.31.20.1,22,ubuntu,key,Web组`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm">
      <div className="mt-10 mb-10 w-full max-w-3xl rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-zinc-200">批量导入主机</h3>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="text-xs text-zinc-500">
            粘贴 CSV/TSV 格式数据，列顺序:
            <code className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
              name, host, port, username, authType, groupName
            </code>
            。可选列: password, keyPath。首行可为表头。Tab 分隔也支持。
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={exampleCsv}
            rows={8}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-700 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          />

          <div className="flex justify-between items-center">
            <Button variant="ghost" size="sm" onClick={parse} disabled={!text.trim()}>
              解析预览
            </Button>
            {preview.length > 0 && errors.length === 0 && !result && (
              <span className="text-xs text-emerald-400">
                {preview.length} 台主机待导入
              </span>
            )}
          </div>

          {errors.length > 0 && (
            <div className="rounded-md border border-red-800 bg-red-950/30 px-3 py-2">
              <div className="text-xs font-medium text-red-300 mb-1">
                {errors.length} 个错误:
              </div>
              {errors.map((e, i) => (
                <div key={i} className="text-xs text-red-400/80">{e}</div>
              ))}
            </div>
          )}

          {preview.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/30">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="text-zinc-500">
                    <th className="px-2 py-1 text-left">name</th>
                    <th className="px-2 py-1 text-left">host</th>
                    <th className="px-2 py-1 text-left">port</th>
                    <th className="px-2 py-1 text-left">user</th>
                    <th className="px-2 py-1 text-left">auth</th>
                    <th className="px-2 py-1 text-left">group</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((h, i) => (
                    <tr key={i} className="border-t border-zinc-800/50 text-zinc-300">
                      <td className="px-2 py-1">{h.name}</td>
                      <td className="px-2 py-1 font-mono">{h.host}</td>
                      <td className="px-2 py-1">{h.port}</td>
                      <td className="px-2 py-1">{h.username}</td>
                      <td className="px-2 py-1">{h.authType}</td>
                      <td className="px-2 py-1">{h.groupName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result && (
            <div
              className={`rounded-md border px-3 py-2 ${
                result.errors.length === 0
                  ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300'
                  : 'border-amber-800 bg-amber-950/30 text-amber-300'
              }`}
            >
              <div className="text-xs font-medium">
                成功导入 {result.created} 台主机
                {result.errors.length > 0 && `，${result.errors.length} 台失败`}
              </div>
              {result.errors.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {result.errors.map((e, i) => (
                    <div key={i} className="text-xs text-amber-400/80">
                      {e.name}: {e.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={importing}>
            关闭
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={importing || preview.length === 0 || errors.length > 0}
          >
            {importing ? '导入中...' : `导入 ${preview.length} 台`}
          </Button>
        </div>
      </div>
    </div>
  );
}
