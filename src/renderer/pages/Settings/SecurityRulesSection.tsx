import { useEffect, useState } from 'react';
import { Button } from '../../components/Button.js';
import { useUiStore } from '../../store/uiStore.js';

// Infer the config view type from the global preload API (the type is declared
// in global.d.ts and flows through window.opsAgent).
type RulesConfig = Awaited<ReturnType<typeof window.opsAgent.securityConfig.list>>;
type RuleEntry = RulesConfig['blockedRules'][number];

export function SecurityRulesSection() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [config, setConfig] = useState<RulesConfig | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const [path, cfg] = await Promise.all([
        window.opsAgent.securityConfig.getFilePath(),
        window.opsAgent.securityConfig.list(),
      ]);
      setFilePath(path);
      setConfig(cfg);
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    setBusy(true);
    setError(null);
    try {
      const res = await window.opsAgent.securityConfig.openFile();
      if (!res.ok) setError(res.error || '无法打开文件');
    } catch (err) {
      setError((err as Error).message || '打开失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleReload() {
    setBusy(true);
    setError(null);
    try {
      const cfg = await window.opsAgent.securityConfig.reload();
      setConfig(cfg);
      setToast('已重新加载配置文件');
    } catch (err) {
      setError((err as Error).message || '重载失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    const ok = await useUiStore.getState().confirm({
      message: '确定恢复为默认拦截规则？这将覆盖配置文件中的所有自定义修改。',
      confirmLabel: '恢复默认',
      variant: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const cfg = await window.opsAgent.securityConfig.reset();
      setConfig(cfg);
      setToast('已恢复默认拦截规则');
    } catch (err) {
      setError((err as Error).message || '重置失败');
    } finally {
      setBusy(false);
    }
  }

  const blockedCount = config?.blockedRules.length ?? 0;
  const allowedCount = config?.allowedRules.length ?? 0;

  return (
    <div className="space-y-2 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">默认拦截规则（配置文件）</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={handleOpen} disabled={busy}>
            打开配置文件
          </Button>
          <Button size="sm" variant="ghost" onClick={handleReload} disabled={busy}>
            重新加载
          </Button>
          <Button size="sm" variant="ghost" onClick={handleReset} disabled={busy}>
            恢复默认
          </Button>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        默认拦截/放行规则存放在用户配置文件中，可直接编辑该文件来增删规则；保存后点“重新加载”生效。DB
        中的自定义规则（见上方）会叠加在配置文件规则之上。损坏的文件会自动回退到内置默认值。
      </p>

      {error && (
        <div className="rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {toast && !error && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
          {toast}
        </div>
      )}

      <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
        <div className="text-xs text-zinc-500">配置文件路径</div>
        <code className="block break-all text-xs text-zinc-400">
          {filePath ?? '（当前环境不可用）'}
        </code>
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <span>拦截规则 {blockedCount} 条</span>
        <span>·</span>
        <span>放行规则 {allowedCount} 条</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
        >
          {expanded ? '收起' : '查看拦截规则'}
        </button>
      </div>

      {expanded && config && (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900 p-2">
          {config.blockedRules.map((r: RuleEntry, i: number) => (
            <div key={r.id ?? i} className="flex items-center gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 ${
                  r.enabled === false ? 'bg-zinc-800 text-zinc-600' : 'bg-red-900/60 text-red-300'
                }`}
              >
                {r.enabled === false ? '已禁用' : '拦截'}
              </span>
              <code className="truncate text-zinc-400">{r.pattern}</code>
              <span className="ml-auto shrink-0 text-zinc-600">{r.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
