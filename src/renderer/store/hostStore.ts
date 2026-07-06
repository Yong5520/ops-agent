import { create } from 'zustand';
import type { HostConfig, HostInput } from '../../shared/types.js';

interface HostStore {
  hosts: HostConfig[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (input: HostInput) => Promise<HostConfig>;
  update: (id: string, input: Partial<HostInput>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  getByName: (name: string) => HostConfig | undefined;
}

export const useHostStore = create<HostStore>((set, get) => ({
  hosts: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const hosts = await window.opsAgent.hosts.list();
      set({ hosts, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  create: async (input) => {
    const host = await window.opsAgent.hosts.create(input);
    set({ hosts: [...get().hosts, host] });
    return host;
  },

  update: async (id, input) => {
    const updated = await window.opsAgent.hosts.update(id, input);
    set({ hosts: get().hosts.map((h) => (h.id === id ? updated : h)) });
  },

  remove: async (id) => {
    await window.opsAgent.hosts.remove(id);
    set({ hosts: get().hosts.filter((h) => h.id !== id) });
  },

  getByName: (name) => get().hosts.find((h) => h.name === name),
}));
