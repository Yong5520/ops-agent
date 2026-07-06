import { useEffect, useState } from 'react';
import { useModelStore } from '../../store/modelStore.js';
import { Button } from '../../components/Button.js';
import { Input, Field, Select } from '../../components/Form.js';
import type {
  ModelProvider,
  ModelProviderInput,
  ModelProviderType,
} from '../../../shared/types.js';

const PROVIDER_TYPES: Array<{ value: ModelProviderType; label: string }> = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'openai-compatible', label: 'OpenAI 兼容端点 (Ark / GLM / Ollama / vLLM)' },
];

export function ModelConfigSection() {
  const { providers, activeProvider, load, create, update, remove, setActive } = useModelStore();
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">模型供应商</h2>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          + 添加模型
        </Button>
      </div>

      {/* Provider list */}
      <div className="space-y-2">
        {providers.length === 0 && !showForm && (
          <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-600">
            尚未配置任何模型供应商。点击"添加模型"开始。
          </p>
        )}
        {providers.map((p) => (
          <div
            key={p.id}
            className={`flex items-center justify-between rounded-md border px-3 py-2 ${
              activeProvider?.id === p.id
                ? 'border-emerald-800 bg-emerald-950/30'
                : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">{p.name}</span>
                {activeProvider?.id === p.id && (
                  <span className="rounded bg-emerald-900 px-1.5 py-0.5 text-xs text-emerald-300">
                    活跃
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {p.type} · {p.modelName} · {p.endpoint}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {activeProvider?.id !== p.id && (
                <Button size="sm" variant="ghost" onClick={() => setActive(p.id)}>
                  设为活跃
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(p);
                  setShowForm(true);
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (confirm(`确定删除模型 "${p.name}"？`)) remove(p.id);
                }}
              >
                删除
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <ModelForm
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

function ModelForm({
  editing,
  onSave,
  onClose,
}: {
  editing: ModelProvider | null;
  onSave: (input: ModelProviderInput) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [type, setType] = useState<ModelProviderType>(editing?.type ?? 'anthropic');
  const [endpoint, setEndpoint] = useState(editing?.endpoint ?? '');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState(editing?.modelName ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    // Validate: new models require apiKey
    if (!editing && !apiKey.trim()) {
      setFormError('请填写 API Key');
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const input: ModelProviderInput = {
        name: name.trim(),
        type,
        endpoint: endpoint.trim() || getDefaultEndpoint(type),
        apiKey: apiKey.trim() || undefined!,
        modelName: modelName.trim(),
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
            placeholder="My Claude"
            required
          />
        </Field>
        <Field label="供应商类型">
          <Select value={type} onChange={(e) => setType(e.target.value as ModelProviderType)}>
            {PROVIDER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="API 端点（可选，留空使用默认）">
        <Input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={getDefaultEndpoint(type)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="API Key">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing ? '••••（留空不修改）' : 'sk-...'}
            required={!editing}
          />
        </Field>
        <Field label="模型名称">
          <Input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="claude-sonnet-4-6"
            required
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? '保存中...' : editing ? '保存' : '添加'}
        </Button>
      </div>
    </form>
  );
}

function getDefaultEndpoint(type: ModelProviderType): string {
  switch (type) {
    case 'anthropic':
      return 'https://api.anthropic.com/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'openai-compatible':
      return 'https://ark.cn-beijing.volces.com/api/v3';
  }
}
