import { useEffect, useState } from 'react';
import { Button } from '../../components/Button.js';
import { Input, Field, Select } from '../../components/Form.js';
import type { SafetyMode, CustomRule, CustomRuleInput } from '../../../shared/types.js';

const MODES: Array<{ value: SafetyMode; name: string; description: string; color: string }> = [
  {
    value: 'sentinel',
    name: '诊断模式 (Sentinel)',
    description: '严格只读。仅允许查询、诊断类命令。任何写入操作均被拦截。',
    color: 'border-blue-800 bg-blue-950/30',
  },
  {
    value: 'operator',
    name: '标准模式 (Operator)',
    description: '允许全部操作，但写入类命令需用户逐条确认授权后执行。',
    color: 'border-amber-800 bg-amber-950/30',
  },
  {
    value: 'autopilot',
    name: '自主模式 (Autopilot)',
    description: 'AI 可自行决定并执行全部命令，无需人工确认。仅适用于测试环境。',
    color: 'border-red-800 bg-red-950/30',
  },
];

interface SafetyModeSectionProps {
  currentMode: SafetyMode;
  onModeChange: (mode: SafetyMode) => void;
}

export function SafetyModeSection({ currentMode, onModeChange }: SafetyModeSectionProps) {
  const [rules, setRules] = useState<CustomRule[]>([]);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadRules();
  }, []);

  const loadRules = async () => {
    const result = await window.opsAgent.rules.list();
    setRules(result);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-300">安全模式</h2>

      {/* Mode selector */}
      <div className="space-y-2">
        {MODES.map((mode) => (
          <label
            key={mode.value}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
              currentMode === mode.value
                ? mode.color
                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
            }`}
          >
            <input
              type="radio"
              name="safetyMode"
              value={mode.value}
              checked={currentMode === mode.value}
              onChange={() => onModeChange(mode.value)}
              className="mt-0.5 accent-zinc-100"
            />
            <div>
              <div className="text-sm font-medium text-zinc-100">{mode.name}</div>
              <div className="mt-0.5 text-xs text-zinc-400">{mode.description}</div>
            </div>
          </label>
        ))}
      </div>

      {/* Custom rules */}
      <div className="space-y-2 pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-300">自定义安全规则</h2>
          <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
            + 添加规则
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          自定义规则会与 17 条默认拦截规则合并生效。blocked 类型拦截匹配命令，allowed
          类型放行匹配命令。
        </p>

        {rules.length === 0 && !showForm && (
          <p className="rounded-md border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-600">
            尚未添加自定义规则。
          </p>
        )}

        {rules.map((r) => (
          <div
            key={r.id}
            className="flex items-start justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    r.type === 'blocked'
                      ? 'bg-red-900 text-red-300'
                      : 'bg-emerald-900 text-emerald-300'
                  }`}
                >
                  {r.type === 'blocked' ? '拦截' : '放行'}
                </span>
                <code className="truncate text-xs text-zinc-400">{r.pattern}</code>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">{r.reason}</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await window.opsAgent.rules.remove(r.id);
                loadRules();
              }}
            >
              删除
            </Button>
          </div>
        ))}

        {showForm && (
          <RuleForm
            onClose={() => setShowForm(false)}
            onSave={async (input) => {
              await window.opsAgent.rules.create(input);
              setShowForm(false);
              loadRules();
            }}
          />
        )}
      </div>
    </div>
  );
}

function RuleForm({
  onSave,
  onClose,
}: {
  onSave: (input: CustomRuleInput) => Promise<void>;
  onClose: () => void;
}) {
  const [type, setType] = useState<'blocked' | 'allowed'>('blocked');
  const [pattern, setPattern] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSave({ type, pattern: pattern.trim(), reason: reason.trim() });
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
      <div className="grid grid-cols-3 gap-3">
        <Field label="类型">
          <Select value={type} onChange={(e) => setType(e.target.value as 'blocked' | 'allowed')}>
            <option value="blocked">拦截 (blocked)</option>
            <option value="allowed">放行 (allowed)</option>
          </Select>
        </Field>
        <Field label="正则表达式" className="col-span-2">
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="(^|\\s)rm\\s+-rf\\s+/tmp"
            required
          />
        </Field>
      </div>
      <Field label="原因说明">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="禁止删除 /tmp 目录"
          required
        />
      </Field>
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
