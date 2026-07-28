import { useEffect, useState } from 'react';
import { useModelStore } from '../../store/modelStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { Button } from '../../components/Button.js';
import { Input, Field, Select } from '../../components/Form.js';
import { parsePriceField } from '../../lib/parse-price-field.js';
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
          <ProviderCard
            key={p.id}
            provider={p}
            isActive={activeProvider?.id === p.id}
            onSetActive={() => setActive(p.id)}
            onEdit={() => {
              setEditing(p);
              setShowForm(true);
            }}
            onDelete={async () => {
              const ok = await useUiStore.getState().confirm({
                message: `确定删除模型 "${p.name}"？`,
                confirmLabel: '删除',
                variant: 'danger',
              });
              if (ok) remove(p.id);
            }}
          />
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
  const [contextWindow, setContextWindow] = useState(
    editing?.contextWindow ? String(editing.contextWindow) : '',
  );
  // V3-01 Cycle 5: per-million-token pricing (USD). Free-text -> parsed via
  // parsePriceField on submit. Empty = "not configured" (estimated_usd stays 0,
  // token totals still persist). Loaded from the provider row in edit mode.
  const [inputPrice, setInputPrice] = useState(
    editing?.inputPricePerMTok != null ? String(editing.inputPricePerMTok) : '',
  );
  const [outputPrice, setOutputPrice] = useState(
    editing?.outputPricePerMTok != null ? String(editing.outputPricePerMTok) : '',
  );
  const [cacheReadPrice, setCacheReadPrice] = useState(
    editing?.cacheReadPricePerMTok != null ? String(editing.cacheReadPricePerMTok) : '',
  );
  const [cacheCreationPrice, setCacheCreationPrice] = useState(
    editing?.cacheCreationPricePerMTok != null ? String(editing.cacheCreationPricePerMTok) : '',
  );
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
        contextWindow: contextWindow.trim() ? Number(contextWindow.trim()) : undefined,
        inputPricePerMTok: parsePriceField(inputPrice),
        outputPricePerMTok: parsePriceField(outputPrice),
        cacheReadPricePerMTok: parsePriceField(cacheReadPrice),
        cacheCreationPricePerMTok: parsePriceField(cacheCreationPrice),
      };
      await onSave(input);
    } catch (err) {
      setFormError((err as Error).message || '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // Modal overlay: fixed full-screen, dimmed + blurred backdrop. The form
    // scrolls if it overflows. Clicking the backdrop closes the modal.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="mt-10 mb-10 w-full max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-zinc-200">
            {editing ? '编辑模型' : '添加模型'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* Modal body */}
        <div className="space-y-3 px-5 py-4">
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
          <Field label="上下文窗口大小（可选，单位 tokens。留空则自动推断）">
            <Input
              type="number"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              placeholder="例如: 128000（留空自动推断）"
            />
          </Field>
          {/* V3-01 Cycle 5: per-million-token pricing (USD). Optional - when left
              blank, estimated_usd = 0 but token totals still persist. Common
              defaults: Claude Sonnet input $3 / output $15 / cache-read $0.30 /
              cache-creation $3.75 per 1M tokens. */}
          <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
            <div className="mb-2 text-xs font-medium text-zinc-400">
              计费定价（可选，USD / 百万 tokens。留空则不估算成本，token 仍会记录）
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="输入 ($/MTok)">
                <Input
                  type="number"
                  step="0.01"
                  value={inputPrice}
                  onChange={(e) => setInputPrice(e.target.value)}
                  placeholder="例如: 3"
                />
              </Field>
              <Field label="输出 ($/MTok)">
                <Input
                  type="number"
                  step="0.01"
                  value={outputPrice}
                  onChange={(e) => setOutputPrice(e.target.value)}
                  placeholder="例如: 15"
                />
              </Field>
              <Field label="缓存读取 ($/MTok)">
                <Input
                  type="number"
                  step="0.01"
                  value={cacheReadPrice}
                  onChange={(e) => setCacheReadPrice(e.target.value)}
                  placeholder="例如: 0.30"
                />
              </Field>
              <Field label="缓存写入 ($/MTok)">
                <Input
                  type="number"
                  step="0.01"
                  value={cacheCreationPrice}
                  onChange={(e) => setCacheCreationPrice(e.target.value)}
                  placeholder="例如: 3.75"
                />
              </Field>
            </div>
          </div>
          <FormTestButton
            buildInput={() => ({
              name: name.trim(),
              type,
              endpoint: endpoint.trim() || getDefaultEndpoint(type),
              apiKey: apiKey.trim() || undefined!,
              modelName: modelName.trim(),
              contextWindow: contextWindow.trim() ? Number(contextWindow.trim()) : undefined,
              inputPricePerMTok: parsePriceField(inputPrice),
              outputPricePerMTok: parsePriceField(outputPrice),
              cacheReadPricePerMTok: parsePriceField(cacheReadPrice),
              cacheCreationPricePerMTok: parsePriceField(cacheCreationPrice),
            })}
            editingId={editing?.id}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={submitting}>
              {submitting ? '保存中...' : editing ? '保存' : '添加'}
            </Button>
          </div>
        </div>
      </form>
    </div>
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

// ── Test connection components ──────────────────────────────────────────
// Both render a "测试" button that fires a real generateText(maxTokens=1)
// round-trip via the models:testConnection IPC handler. The result (ok +
// latencyMs, or a friendly error) is shown inline so the user does not need a
// modal. While testing, the button shows a spinner and is disabled.

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; latencyMs?: number }
  | { status: 'fail'; error: string };

function TestResultBadge({ state }: { state: TestState }) {
  if (state.status === 'idle' || state.status === 'testing') return null;
  if (state.status === 'ok') {
    return (
      <span className="text-xs text-emerald-400">
        ✓ 连接成功{state.latencyMs != null ? `（${state.latencyMs}ms）` : ''}
      </span>
    );
  }
  return (
    <span className="whitespace-pre-wrap break-words text-xs text-red-400">✗ {state.error}</span>
  );
}

// "测试" button on each saved provider card. Tests the persisted config
// (id only - the main process loads the row from DB).
// A single provider row. Owns the connection-test state so that a FAILED test
// can render the actual cause (not just "✗ 异常") in a detail row beneath the
// main row - the user must be able to see WHY a model failed without hovering.
function ProviderCard({
  provider,
  isActive,
  onSetActive,
  onEdit,
  onDelete,
}: {
  provider: ModelProvider;
  isActive: boolean;
  onSetActive: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const testing = state.status === 'testing';

  const runTest = async () => {
    setState({ status: 'testing' });
    try {
      const result = await useModelStore.getState().testConnection(null, provider.id);
      if (result.ok) {
        setState({ status: 'ok', latencyMs: result.latencyMs });
      } else {
        setState({ status: 'fail', error: result.error ?? '未知错误' });
      }
    } catch (err) {
      setState({ status: 'fail', error: (err as Error).message });
    }
  };

  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        isActive ? 'border-emerald-800 bg-emerald-950/30' : 'border-zinc-800 bg-zinc-900'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{provider.name}</span>
            {isActive && (
              <span className="rounded bg-emerald-900 px-1.5 py-0.5 text-xs text-emerald-300">
                活跃
              </span>
            )}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {provider.type} · {provider.modelName} · {provider.endpoint}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isActive && (
            <Button size="sm" variant="ghost" onClick={onSetActive}>
              设为活跃
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={runTest}
            disabled={testing}
            title="向模型端点发送一次极小请求以验证连接"
          >
            {testing ? '测试中...' : '测试'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>

      {/* Test result detail row. Visible only after a test run so the user can
          see the latency on success or the underlying cause on failure. */}
      {state.status === 'ok' && (
        <div className="mt-2 flex items-center gap-2 rounded border border-emerald-800/60 bg-emerald-950/40 px-2 py-1 text-xs text-emerald-300">
          <span>✓ 连接成功</span>
          {state.latencyMs != null && (
            <span className="text-emerald-400/80">（延迟 {state.latencyMs}ms）</span>
          )}
        </div>
      )}
      {state.status === 'fail' && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded border border-red-800/60 bg-red-950/40 px-2 py-1.5 text-xs">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-red-300">✗ 连接失败</div>
            {/* whitespace-pre-wrap preserves the "（原因：...）" line break from
                the backend so the raw cause is readable. break-words wraps long
                URLs / error strings instead of overflowing the card. */}
            <div className="mt-0.5 whitespace-pre-wrap break-words text-red-400/90">
              {state.error}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={runTest}
            disabled={testing}
            className="shrink-0"
          >
            重试
          </Button>
        </div>
      )}
    </div>
  );
}

// "测试连接" button inside the add/edit form. Builds the input from the
// current form fields; when editing with a blank key, the main process falls
// back to the stored key (editingId). Shows the result inline above the
// action bar so the user can iterate without closing the form.
function FormTestButton({
  buildInput,
  editingId,
}: {
  buildInput: () => ModelProviderInput;
  editingId?: string;
}) {
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const testing = state.status === 'testing';

  const run = async (e: React.MouseEvent) => {
    // Prevent the surrounding <form> from submitting.
    e.preventDefault();
    setState({ status: 'testing' });
    try {
      const input = buildInput();
      const result = await useModelStore.getState().testConnection(input, editingId);
      if (result.ok) {
        setState({ status: 'ok', latencyMs: result.latencyMs });
      } else {
        setState({ status: 'fail', error: result.error ?? '未知错误' });
      }
    } catch (err) {
      setState({ status: 'fail', error: (err as Error).message });
    }
  };

  if (state.status === 'idle' || state.status === 'testing') {
    return (
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={run} disabled={testing}>
          {testing ? '测试中...' : '测试连接'}
        </Button>
      </div>
    );
  }
  // Show the result inline with a retry button.
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${
        state.status === 'ok'
          ? 'border-emerald-800 bg-emerald-950/30 text-emerald-300'
          : 'border-red-800 bg-red-950/30 text-red-300'
      }`}
    >
      <TestResultBadge state={state} />
      <Button size="sm" variant="ghost" onClick={run} disabled={testing}>
        重新测试
      </Button>
    </div>
  );
}
