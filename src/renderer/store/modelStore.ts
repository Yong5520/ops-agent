import { create } from 'zustand';
import type { ModelProvider, ModelProviderInput } from '../../shared/types.js';

interface ModelStore {
  providers: ModelProvider[];
  activeProvider: ModelProvider | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (input: ModelProviderInput) => Promise<void>;
  update: (id: string, input: Partial<ModelProviderInput>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string) => Promise<void>;
}

export const useModelStore = create<ModelStore>((set, get) => ({
  providers: [],
  activeProvider: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [providers, active] = await Promise.all([
        window.opsAgent.models.list(),
        window.opsAgent.models.getActive(),
      ]);
      set({ providers, activeProvider: active, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  create: async (input) => {
    const provider = await window.opsAgent.models.create(input);
    set({ providers: [...get().providers, provider] });
  },

  update: async (id, input) => {
    const updated = await window.opsAgent.models.update(id, input);
    set({
      providers: get().providers.map((p) => (p.id === id ? updated : p)),
    });
  },

  remove: async (id) => {
    await window.opsAgent.models.remove(id);
    const { activeProvider } = get();
    set({
      providers: get().providers.filter((p) => p.id !== id),
      activeProvider: activeProvider?.id === id ? null : activeProvider,
    });
  },

  setActive: async (id) => {
    await window.opsAgent.models.setActive(id);
    const provider = get().providers.find((p) => p.id === id);
    set({ activeProvider: provider ?? null });
  },
}));
