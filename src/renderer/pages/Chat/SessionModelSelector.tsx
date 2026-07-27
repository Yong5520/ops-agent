import { useState, useRef, useEffect, useCallback } from 'react';
import type { ModelProvider } from '../../../shared/types.js';

interface SessionModelSelectorProps {
  // The current session's explicit override id. Undefined/null = use default.
  modelProviderId?: string;
  // All configured providers (from the model store). These omit apiKey on
  // the renderer side, which is fine - we only need name/type for the menu.
  providers: ModelProvider[];
  // The global active default provider (shown as the fallback label).
  activeProvider: ModelProvider | null;
  // Disabled while a run is in flight so the model can't be swapped mid-stream.
  disabled?: boolean;
  // Called with a provider id to set the override, or null to clear it
  // (revert to the global default). Persisted by the parent via the session
  // store, so the next turn resolves to the new model.
  onSelect: (modelProviderId: string | null) => void;
}

// Compact model picker for the chat header. Shows the resolved model name
// (the session override, else "默认 · {active}") and a menu of every
// configured provider plus a "使用默认模型" entry that clears the override.
//
// Click-outside and Escape close the menu (mirrors the TerminalPage context
// menu idiom). A ref guard prevents the opening click from immediately
// closing via the window click listener.
export function SessionModelSelector({
  modelProviderId,
  providers,
  activeProvider,
  disabled,
  onSelect,
}: SessionModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click / Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [open, close]);

  // Label for the trigger. An override shows its name; otherwise show the
  // global default (or "未配置" if there isn't one either).
  const overrideProvider = modelProviderId
    ? providers.find((p) => p.id === modelProviderId)
    : undefined;
  const triggerLabel = overrideProvider
    ? overrideProvider.name
    : activeProvider
      ? `默认 · ${activeProvider.name}`
      : '未配置模型';

  const hasOverride = Boolean(overrideProvider);

  const handleSelect = (value: string | null) => {
    onSelect(value);
    close();
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
        title="切换本会话使用的模型"
      >
        <span className={hasOverride ? 'text-zinc-300' : ''}>{triggerLabel}</span>
        <span className="text-[10px]">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[14rem] overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
          {/* Clear -> use the global active default */}
          <MenuItem
            active={!hasOverride}
            onClick={() => handleSelect(null)}
            label="使用默认模型"
            sub={activeProvider ? `默认 · ${activeProvider.name}` : '尚未配置默认模型'}
          />
          {providers.length > 0 && <div className="my-1 border-t border-zinc-800" />}
          {providers.map((p) => (
            <MenuItem
              key={p.id}
              active={modelProviderId === p.id}
              onClick={() => handleSelect(p.id)}
              label={p.name}
              sub={`${p.type} · ${p.modelName}`}
            />
          ))}
          {providers.length === 0 && !activeProvider && (
            <div className="px-3 py-2 text-xs text-zinc-600">尚未配置任何模型</div>
          )}
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  active: boolean;
  onClick: () => void;
  label: string;
  sub?: string;
}

function MenuItem({ active, onClick, label, sub }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800"
    >
      <span className={`text-xs ${active ? 'font-medium text-blue-400' : 'text-zinc-300'}`}>
        {label}
        {active && <span className="ml-1 text-blue-400">✓</span>}
      </span>
      {sub && <span className="text-[10px] text-zinc-500">{sub}</span>}
    </button>
  );
}
