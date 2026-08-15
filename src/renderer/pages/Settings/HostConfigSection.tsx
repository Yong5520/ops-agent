import { useEffect, useState, useCallback } from 'react';
import { useHostStore } from '../../store/hostStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { Button } from '../../components/Button.js';
import { Input, Field, Select } from '../../components/Form.js';
import { SearchInput } from '../../components/SearchInput.js';
import { GroupCreateInput } from './GroupCreateInput.js';
import { groupHostsByFolder } from '../../utils/host-groups.js';
import { filterHosts } from '../../utils/host-search.js';
import type {
  HostConfig,
  HostInput,
  AuthType,
  DeviceType,
  ConnectionType,
  SerialParity,
  SerialFlowControl,
} from '../../../shared/types.js';

// Baud rates offered in the host-config serial form (mirrors
// src/main/serial/serial-options.ts BAUD_RATES). 9600 is the network-device
// console default.
const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

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
  const { hosts, groups, load, create, update, remove, createGroup } = useHostStore();
  const [editing, setEditing] = useState<HostConfig | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [statuses, setStatuses] = useState<Map<string, HostStatus>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupEditName, setGroupEditName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

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
    // Ignore group toggles while searching: groups are force-expanded during a
    // search, so a click would mutate/persist collapse state with no visible
    // feedback, then surface as a surprise collapse after the search clears.
    if (searchQuery.trim()) return;
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
    const ok = await useUiStore.getState().confirm({
      message: `删除分组"${groupName}"？组内主机会移至 default 分组。`,
      confirmLabel: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    await window.opsAgent.hosts.deleteGroup(groupName);
    await load();
  };

  const handleCreateGroup = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setGroupError('文件夹名称不能为空');
      return;
    }
    setGroupError(null);
    try {
      await createGroup(trimmed);
      setCreatingGroup(false);
    } catch (err) {
      setGroupError((err as Error).message || '创建失败');
    }
  };

  // Group hosts by folder for organized display. Explicitly-created folders
  // (incl. empty ones) are unioned with host-derived folders; 'default' first,
  // then the rest alphabetical. Shared util (also used by SessionSidebar).
  //
  // Search: filter by the query (empty = pass-through) before grouping. While
  // searching, drop groups that ended up empty and force-expand the rest so
  // every match is visible. Clearing the query restores the original grouped
  // view (incl. empty explicit folders) untouched.
  const filteredHosts = filterHosts(hosts, searchQuery);
  const hostGroups = groupHostsByFolder(filteredHosts, groups);
  const searching = searchQuery.trim().length > 0;
  const visibleGroups = searching ? hostGroups.filter((g) => g.hosts.length > 0) : hostGroups;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">目标主机</h2>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setShowImport(true)}>
            批量导入
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCreatingGroup(true);
              setGroupError(null);
            }}
          >
            新建文件夹
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

      {creatingGroup && (
        <GroupCreateInput
          onCreate={handleCreateGroup}
          onCancel={() => {
            setCreatingGroup(false);
            setGroupError(null);
          }}
          error={groupError}
        />
      )}

      {hosts.length > 0 && (
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索主机名称 / IP / 用户名"
          className="max-w-md"
        />
      )}

      <div className="space-y-3">
        {hosts.length === 0 && !showForm && (
          <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-600">
            尚未配置任何主机。点击"添加主机"或"批量导入"开始。
          </p>
        )}
        {hosts.length > 0 && visibleGroups.length === 0 && (
          <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-600">
            未找到匹配的主机
          </p>
        )}
        {visibleGroups.map(({ group, hosts: groupHosts }) => {
          const isCollapsed = searching ? false : collapsed.has(group);
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
                  {groupHosts.length === 0 && (
                    <p className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-600">
                      此文件夹暂无主机
                    </p>
                  )}
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
                            {h.connectionType === 'serial' && (
                              <span className="ml-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
                                串口
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-zinc-500">
                            {h.connectionType === 'serial'
                              ? `${h.serialPort ?? h.host} @ ${h.baudRate ?? 9600}bps${
                                  h.loginRequired ? ' · 需登录' : ''
                                }`
                              : `${h.username}@${h.host}:${h.port} · ${
                                  h.authType === 'password' ? '密码' : '密钥'
                                }`}
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
                              const ok = await useUiStore.getState().confirm({
                                message: `确定删除主机 "${h.name}"？`,
                                confirmLabel: '删除',
                                variant: 'danger',
                              });
                              if (ok) {
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
          allHosts={hosts}
          groups={groups}
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
  allHosts,
  groups,
  onSave,
  onClose,
}: {
  editing: HostConfig | null;
  allHosts: HostConfig[];
  groups: string[];
  onSave: (input: HostInput) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(editing?.port ?? 22);
  const [username, setUsername] = useState(editing?.username ?? '');
  const [authType, setAuthType] = useState<AuthType>(editing?.authType ?? 'password');
  const [password, setPassword] = useState('');
  // V3-11: serial console support. connectionType defaults to 'ssh' so every
  // existing host/form stays SSH; serial hosts show a port/baud/login form
  // instead of the SSH address/auth fields.
  const [connectionType, setConnectionType] = useState<ConnectionType>(
    editing?.connectionType ?? 'ssh',
  );
  const [serialPort, setSerialPort] = useState(editing?.serialPort ?? '');
  const [baudRate, setBaudRate] = useState(editing?.baudRate ?? 9600);
  const [dataBits, setDataBits] = useState<7 | 8>(editing?.dataBits ?? 8);
  const [stopBits, setStopBits] = useState<1 | 2>(editing?.stopBits ?? 1);
  const [parity, setParity] = useState<SerialParity>(editing?.parity ?? 'none');
  const [flowControl, setFlowControl] = useState<SerialFlowControl>(editing?.flowControl ?? 'none');
  const [loginRequired, setLoginRequired] = useState(editing?.loginRequired ?? false);
  const [serialPorts, setSerialPorts] = useState<
    Array<{ path: string; manufacturer?: string; serialNumber?: string; friendlyName?: string }>
  >([]);
  const [refreshingPorts, setRefreshingPorts] = useState(false);
  const [showSerialAdvanced, setShowSerialAdvanced] = useState(false);
  const [keyPath, setKeyPath] = useState(editing?.keyPath ?? '');
  const [sudoPassword, setSudoPassword] = useState('');
  const [suPassword, setSuPassword] = useState('');
  const [groupName, setGroupName] = useState(editing?.groupName ?? 'default');
  const [timeoutMs, setTimeoutMs] = useState(editing?.timeoutMs ?? 60000);
  // Phase 2: device type selects the exec profile (PTY for paginating
  // network-device CLIs, no-PTY for Linux). Defaults to 'linux'.
  const [deviceType, setDeviceType] = useState<DeviceType>(editing?.deviceType ?? 'linux');
  // V3-09: SSH bastion / agent forwarding / host-key fields.
  const [jumpHostId, setJumpHostId] = useState(editing?.jumpHostId ?? '');
  const [agentForward, setAgentForward] = useState(editing?.agentForward ?? false);
  // V3-09.1: encoded-bastion mode.
  const [jumpMode, setJumpMode] = useState<'forward' | 'encoded'>(editing?.jumpMode ?? 'forward');
  const [jumpUsernameTemplate, setJumpUsernameTemplate] = useState(
    editing?.jumpUsernameTemplate ?? '',
  );
  const [jumpTargetAuth, setJumpTargetAuth] = useState<'bastion-managed' | 'password'>(
    editing?.jumpTargetAuth ?? 'bastion-managed',
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // V3-10: local mirror of the recorded host-key fingerprint. The fingerprint
  // is auto-captured on first connect (TOFU) and is read-only here - the only
  // user action is "clear" (recover from a stale fingerprint after a host
  // re-key or address change). Kept in local state so the display hides
  // immediately after a clear without reopening the form.
  const [hostKeyFingerprint, setHostKeyFingerprint] = useState<string | undefined>(
    editing?.hostKeyFingerprint,
  );
  const [clearingKey, setClearingKey] = useState(false);

  // V3-11: enumerate local serial ports for the picker. Refreshed when the
  // form switches to serial mode (and on demand via the refresh button).
  const refreshSerialPorts = useCallback(async () => {
    setRefreshingPorts(true);
    try {
      setSerialPorts(await window.opsAgent.serial.listPorts());
    } catch {
      setSerialPorts([]);
    } finally {
      setRefreshingPorts(false);
    }
  }, []);
  useEffect(() => {
    if (connectionType === 'serial') {
      void refreshSerialPorts();
    }
  }, [connectionType, refreshSerialPorts]);

  const handleClearHostKey = async () => {
    if (!editing || clearingKey) return;
    const ok = await useUiStore.getState().confirm({
      message:
        '清除已记录的主机密钥？下次连接将重新校验并记录新指纹（适用于主机重装/更换地址后连接失败的情况）。',
      confirmLabel: '清除',
      variant: 'danger',
    });
    if (!ok) return;
    setClearingKey(true);
    try {
      await window.opsAgent.hosts.clearHostKey(editing.id);
      setHostKeyFingerprint(undefined);
    } catch (err) {
      setFormError((err as Error).message || '清除主机密钥失败');
    } finally {
      setClearingKey(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const input: HostInput = {
        name: name.trim(),
        // Serial hosts have no network address - mirror the port path into
        // `host` (the store enforces this too) so audit logs / terminal titles
        // show a meaningful value.
        host: connectionType === 'serial' ? serialPort.trim() : host.trim(),
        port,
        username: username.trim(),
        authType,
        password: password || undefined,
        keyPath: keyPath || undefined,
        sudoPassword: sudoPassword || undefined,
        suPassword: suPassword || undefined,
        groupName: groupName.trim(),
        timeoutMs,
        deviceType,
        jumpHostId: jumpHostId || undefined,
        agentForward,
        hostKeyFingerprint,
        // V3-09.1: only carry jumpMode/template/targetAuth when a jump host is
        // actually selected - otherwise the host is direct-connect.
        jumpMode: jumpHostId ? jumpMode : 'forward',
        jumpUsernameTemplate: jumpUsernameTemplate.trim() || undefined,
        jumpTargetAuth: jumpHostId ? jumpTargetAuth : 'bastion-managed',
        // V3-11: serial console fields. Only meaningful when connectionType is
        // 'serial'; carried through as undefined for SSH hosts.
        connectionType,
        serialPort: connectionType === 'serial' ? serialPort.trim() || undefined : undefined,
        baudRate: connectionType === 'serial' ? baudRate : undefined,
        dataBits: connectionType === 'serial' ? dataBits : undefined,
        stopBits: connectionType === 'serial' ? stopBits : undefined,
        parity: connectionType === 'serial' ? parity : undefined,
        flowControl: connectionType === 'serial' ? flowControl : undefined,
        loginRequired: connectionType === 'serial' ? loginRequired : undefined,
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
          <Field label="连接方式">
            <Select
              value={connectionType}
              onChange={(e) => setConnectionType(e.target.value as ConnectionType)}
            >
              <option value="ssh">SSH（网络主机）</option>
              <option value="serial">串口（Console 控制台，交换机初始化等）</option>
            </Select>
          </Field>
          {connectionType === 'ssh' ? (
            <>
              <Field label="主机地址">
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="10.31.10.110"
                  required
                />
              </Field>
            </>
          ) : (
            <Field label="波特率">
              <Select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))}>
                {BAUD_RATES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {connectionType === 'ssh' ? (
          <Field label="端口">
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              required
            />
          </Field>
        ) : (
          <Field label="串口（本地 COM 口 / ttyUSB，如 COM3、/dev/ttyUSB0）">
            <div className="flex gap-2">
              <Input
                list="serial-port-list"
                value={serialPort}
                onChange={(e) => setSerialPort(e.target.value)}
                placeholder="COM3"
                required
              />
              <datalist id="serial-port-list">
                {serialPorts.map((p) => (
                  <option key={p.path} value={p.path}>
                    {[p.friendlyName, p.manufacturer].filter(Boolean).join(' - ')}
                  </option>
                ))}
              </datalist>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void refreshSerialPorts()}
                disabled={refreshingPorts}
              >
                {refreshingPorts ? '刷新中…' : '刷新端口'}
              </Button>
            </div>
            {serialPorts.length === 0 && !refreshingPorts && (
              <div className="mt-1 text-xs text-zinc-500">
                未检测到串口。确认设备已连接，或直接手动输入端口路径。
              </div>
            )}
          </Field>
        )}
        {connectionType === 'serial' && (
          <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={loginRequired}
                onChange={(e) => setLoginRequired(e.target.checked)}
                className="accent-emerald-600"
              />
              需要账号密码登录（控制台要求 Login/Password 时勾选；新设备初始化引导界面不勾选）
            </label>
            {loginRequired && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="登录用户名">
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                  />
                </Field>
                <Field label="登录密码">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing ? '••••（留空不修改）' : '输入密码'}
                  />
                </Field>
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowSerialAdvanced((v) => !v)}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              {showSerialAdvanced ? '▼' : '▶'} 高级串口参数
            </button>
            {showSerialAdvanced && (
              <div className="grid grid-cols-4 gap-3">
                <Field label="数据位">
                  <Select
                    value={dataBits}
                    onChange={(e) => setDataBits(Number(e.target.value) as 7 | 8)}
                  >
                    <option value={8}>8</option>
                    <option value={7}>7</option>
                  </Select>
                </Field>
                <Field label="停止位">
                  <Select
                    value={stopBits}
                    onChange={(e) => setStopBits(Number(e.target.value) as 1 | 2)}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </Select>
                </Field>
                <Field label="校验">
                  <Select
                    value={parity}
                    onChange={(e) => setParity(e.target.value as SerialParity)}
                  >
                    <option value="none">无</option>
                    <option value="even">偶</option>
                    <option value="odd">奇</option>
                  </Select>
                </Field>
                <Field label="流控">
                  <Select
                    value={flowControl}
                    onChange={(e) => setFlowControl(e.target.value as SerialFlowControl)}
                  >
                    <option value="none">无</option>
                    <option value="rtscts">硬件 (RTS/CTS)</option>
                    <option value="xonxoff">软件 (XON/XOFF)</option>
                  </Select>
                </Field>
              </div>
            )}
          </div>
        )}
        {connectionType === 'ssh' && (
          <>
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
                <Select value={groupName} onChange={(e) => setGroupName(e.target.value)}>
                  {groups.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </Select>
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
          </>
        )}
        <Field label="命令超时（毫秒）">
          <Input
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
          />
        </Field>
        <Field label="设备类型（交换机/路由器分页输出需选对应类型）">
          <Select value={deviceType} onChange={(e) => setDeviceType(e.target.value as DeviceType)}>
            <option value="linux">Linux 服务器（默认）</option>
            <option value="huawei-vrp">华为 VRP（FutureMatrix/S6735 等）</option>
            <option value="cisco-ios">Cisco IOS</option>
            <option value="h3c">H3C</option>
            <option value="juniper-junos">Juniper Junos</option>
            <option value="arista-eos">Arista EOS</option>
            <option value="generic">其他/未知</option>
          </Select>
        </Field>
        {/* V3-09: SSH bastion / agent forwarding / host-key verification. */}
        {connectionType === 'ssh' && (
          <>
            <Field label="堡垒机 / 跳板机（可选，经此主机中转连接）">
              <Select value={jumpHostId} onChange={(e) => setJumpHostId(e.target.value)}>
                <option value="">不使用（直连）</option>
                {/* Exclude self to prevent a jump-to-self cycle. */}
                {allHosts
                  .filter((h) => h.id !== editing?.id)
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.host})
                    </option>
                  ))}
              </Select>
            </Field>
            {jumpHostId && (
              <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 space-y-3">
                <div className="text-xs font-medium text-zinc-400">
                  跳转模式（如何经堡垒机连接）
                </div>
                <Field label="跳转模式">
                  <Select
                    value={jumpMode}
                    onChange={(e) => setJumpMode(e.target.value as 'forward' | 'encoded')}
                  >
                    <option value="forward">TCP 转发（forward，堡垒机允许端口转发时用）</option>
                    <option value="encoded">用户名编码（encoded，堡垒机禁用端口转发时用）</option>
                  </Select>
                </Field>
                {jumpMode === 'encoded' && (
                  <>
                    <div className="text-xs text-zinc-500">
                      用户名编码模式：单次连接到堡垒机，用户名编码为目标信息 （如{' '}
                      <code className="font-mono">堡垒机用户@目标用户@目标IP</code>
                      ），堡垒机自行登录目标。 凭据使用<strong>堡垒机主机记录</strong>
                      里配的密码/密钥（本机路径）， 此处的目标密码仅在"手动密码"时用于二次认证。
                    </div>
                    <Field label="用户名编码模板（可选，留空用默认 {bastionUser}@{targetUser}@{targetHost}）">
                      <Input
                        value={jumpUsernameTemplate}
                        onChange={(e) => setJumpUsernameTemplate(e.target.value)}
                        placeholder="{bastionUser}@{targetUser}@{targetHost}"
                      />
                    </Field>
                    <Field label="目标认证方式">
                      <Select
                        value={jumpTargetAuth}
                        onChange={(e) =>
                          setJumpTargetAuth(e.target.value as 'bastion-managed' | 'password')
                        }
                      >
                        <option value="bastion-managed">
                          堡垒机托管（堡垒机用自己存的凭据登录目标）
                        </option>
                        <option value="password">
                          手动密码（用上面的目标密码做二次键盘交互认证）
                        </option>
                      </Select>
                    </Field>
                  </>
                )}
                {jumpMode === 'forward' && (
                  <div className="text-xs text-zinc-500">
                    TCP 转发模式：先连堡垒机，再经其端口转发隧道连目标。 凭据使用
                    <strong>目标主机</strong>的密码/密钥（本机路径）。 若堡垒机报"port forwarding is
                    disabled"，请改用用户名编码模式。
                  </div>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={agentForward}
                onChange={(e) => setAgentForward(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
              />
              启用 SSH Agent 转发（目标主机可复用本地 agent 凭据）
            </label>
            {hostKeyFingerprint && (
              <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium text-zinc-300">主机密钥指纹（已记录）：</span>
                    <code className="ml-1 break-all font-mono">{hostKeyFingerprint}</code>
                    <div className="mt-1 text-zinc-500">
                      首次连接时自动记录，后续连接校验此指纹以防中间人攻击。若主机重装或更换地址后连接失败（Host
                      denied），可清除后重新校验。
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleClearHostKey}
                    disabled={clearingKey}
                    className="shrink-0"
                    title="清除已记录的指纹，下次连接重新校验（TOFU）"
                  >
                    {clearingKey ? '清除中...' : '清除主机密钥'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
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
    const lines = text
      .trim()
      .split('\n')
      .filter((l) => l.trim());
    const parsed: HostInput[] = [];
    const errs: string[] = [];

    // Detect delimiter: tab or comma
    const delim = lines[0]?.includes('\t') ? '\t' : ',';
    const headers = lines[0]?.split(delim).map((h) => h.trim().toLowerCase());

    // Check if first line is a header
    const hasHeader =
      headers &&
      (headers.includes('name') || headers.includes('host') || headers.includes('username'));
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
        agentForward: false,
        deviceType: 'linux',
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
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" aria-label="关闭">
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
              <span className="text-xs text-emerald-400">{preview.length} 台主机待导入</span>
            )}
          </div>

          {errors.length > 0 && (
            <div className="rounded-md border border-red-800 bg-red-950/30 px-3 py-2">
              <div className="text-xs font-medium text-red-300 mb-1">{errors.length} 个错误:</div>
              {errors.map((e, i) => (
                <div key={i} className="text-xs text-red-400/80">
                  {e}
                </div>
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
