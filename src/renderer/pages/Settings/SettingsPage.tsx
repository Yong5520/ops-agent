import { useState } from 'react';
import { ModelConfigSection } from './ModelConfigSection.js';
import { HostConfigSection } from './HostConfigSection.js';
import { SafetyModeSection } from './SafetyModeSection.js';
import { useSessionStore } from '../../store/sessionStore.js';
import type { SafetyMode } from '../../../shared/types.js';

type Tab = 'models' | 'hosts' | 'safety';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'models', label: '模型' },
  { value: 'hosts', label: '主机' },
  { value: 'safety', label: '安全' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('models');
  const { safetyMode, setSafetyMode } = useSessionStore();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold">设置</h1>
        <p className="text-xs text-zinc-500">模型供应商 / 目标主机 / 安全模式</p>
      </header>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-zinc-800 px-6">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.value
                ? 'border-zinc-100 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          {tab === 'models' && <ModelConfigSection />}
          {tab === 'hosts' && <HostConfigSection />}
          {tab === 'safety' && (
            <SafetyModeSection
              currentMode={safetyMode}
              onModeChange={(mode: SafetyMode) => setSafetyMode(mode)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
