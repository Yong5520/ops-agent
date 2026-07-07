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

export function HostConfigSection() {
  const { hosts, load, create, update, remove } = useHostStore();
  const [editing, setEditing] = useState<HostConfig | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, HostStatus>>(new Map());

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

      <div className="space-y-4">
        {hosts.length === 0 && !showForm && (
          <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-600">
            尚未配置任何主机。点击"添加主机"开始。
          </p>
        )}
        {Object.entries(grouped).map(([group, groupHosts]) => (
          <div key={group}>
            <div className="mb-1.5 text-xs font-medium text-zinc-500">{group}</div>
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
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                          {h.groupName}
                        </span>
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
          </div>
        ))}
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
