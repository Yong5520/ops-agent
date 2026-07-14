import { useEffect, useState } from 'react';
import { Button } from '../../components/Button.js';
import { Input, Field, Select } from '../../components/Form.js';
import type { Hook, HookCreateInput, HookEvent, HookType } from '../../../shared/types.js';

export function HooksSection() {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadHooks();
  }, []);

  const loadHooks = async () => {
    const result = await window.opsAgent.hooks.list();
    setHooks(result);
  };

  const toggleEnabled = async (hook: Hook) => {
    await window.opsAgent.hooks.update(hook.id, { enabled: !hook.enabled });
    loadHooks();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">Hooks (PreToolUse / PostToolUse)</h2>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          + 添加 Hook
        </Button>
      </div>
      <p className="text-xs text-zinc-500">
        Hook 允许在工具执行前/后注入自定义逻辑。command 类型执行本地命令（stdin 接收 JSON），http
        类型发送 webhook 请求。返回 deny 拦截命令，allow 跳过授权，pass 继续正常流程。
      </p>

      {hooks.length === 0 && !showForm && (
        <p className="rounded-md border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-600">
          尚未配置 Hook。
        </p>
      )}

      {hooks.map((h) => (
        <div
          key={h.id}
          className="flex items-start justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  h.event === 'PreToolUse'
                    ? 'bg-amber-900 text-amber-300'
                    : 'bg-blue-900 text-blue-300'
                }`}
              >
                {h.event}
              </span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                {h.type}
              </span>
              <span className="text-sm font-medium text-zinc-100">{h.name}</span>
              {!h.enabled && (
                <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-500">
                  已禁用
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-zinc-500">
              <span>条件: <code className="text-zinc-400">{h.condition.toolName}</code></span>
              {h.type === 'command' && h.config.command && (
                <span className="truncate">命令: <code className="text-zinc-400">{h.config.command}</code></span>
              )}
              {h.type === 'http' && h.config.url && (
                <span className="truncate">URL: <code className="text-zinc-400">{h.config.url}</code></span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => toggleEnabled(h)}>
              {h.enabled ? '禁用' : '启用'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await window.opsAgent.hooks.remove(h.id);
                loadHooks();
              }}
            >
              删除
            </Button>
          </div>
        </div>
      ))}

      {showForm && (
        <HookForm
          onClose={() => setShowForm(false)}
          onSave={async (input) => {
            await window.opsAgent.hooks.create(input);
            setShowForm(false);
            loadHooks();
          }}
        />
      )}
    </div>
  );
}

function HookForm({
  onSave,
  onClose,
}: {
  onSave: (input: HookCreateInput) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [event, setEvent] = useState<HookEvent>('PreToolUse');
  const [type, setType] = useState<HookType>('command');
  const [condition, setCondition] = useState('*');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<'POST' | 'GET'>('POST');
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const input: HookCreateInput = {
        name: name.trim(),
        event,
        type,
        config: {
          name: name.trim(),
          event,
          type,
          ...(type === 'command' ? { command: command.trim() } : {}),
          ...(type === 'http' ? { url: url.trim(), method } : {}),
          timeoutMs,
        },
        condition: { toolName: condition.trim() || '*' },
        enabled: true,
      };
      await onSave(input);
    } catch (err) {
      setFormError((err as Error).message || '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900 p-4"
    >
      {formError && (
        <div className="rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {formError}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="名称">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="阻止危险命令"
            required
          />
        </Field>
        <Field label="条件 (toolName glob)">
          <Input
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="exec(rm *)"
          />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="事件">
          <Select value={event} onChange={(e) => setEvent(e.target.value as HookEvent)}>
            <option value="PreToolUse">PreToolUse</option>
            <option value="PostToolUse">PostToolUse</option>
          </Select>
        </Field>
        <Field label="类型">
          <Select value={type} onChange={(e) => setType(e.target.value as HookType)}>
            <option value="command">command (本地命令)</option>
            <option value="http">http (webhook)</option>
          </Select>
        </Field>
        <Field label="超时 (ms)">
          <Input
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            min={100}
          />
        </Field>
      </div>
      {type === 'command' && (
        <Field label="命令 (stdout 输出 JSON: {permissionDecision, blockMessage, modifiedToolInput, additionalContext})">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder='echo {"permissionDecision":"deny","blockMessage":"blocked"}'
            required
          />
        </Field>
      )}
      {type === 'http' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="URL" className="col-span-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:8080/hook"
              required
            />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value as 'POST' | 'GET')}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </Select>
          </Field>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? '保存中...' : '添加'}
        </Button>
      </div>
    </form>
  );
}
