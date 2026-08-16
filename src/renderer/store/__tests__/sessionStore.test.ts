import { describe, it, expect, beforeEach, vi } from 'vitest';

// sessionStore touches window.opsAgent only inside action bodies (not at
// module eval), so we can import the store safely and stub window per-test.

import { useSessionStore } from '../sessionStore.js';

describe('useSessionStore.createSession (v24: new sessions default to no host)', () => {
  let createMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createMock = vi.fn().mockImplementation((payload: { hostIds?: string[] }) => ({
      id: 'sess-new',
      title: null,
      hostIds: payload?.hostIds ?? null,
      safetyMode: 'operator',
      status: 'active',
      updatedAt: new Date().toISOString(),
    }));
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      opsAgent: {
        sessions: { create: createMock, messages: vi.fn().mockResolvedValue([]) },
      },
    };
  });

  it('a new session starts with NO hosts even after viewing a session that had hosts', async () => {
    // The bug: the store-level hostIds is shared across sessions, so after
    // selecting a session with hosts (selectSession writes session.hostIds
    // into the store), "+ 新建会话" silently pre-selected those hosts.
    useSessionStore.setState({ hostIds: ['h1', 'h2'] });

    await useSessionStore.getState().createSession({ safetyMode: 'operator' });

    // IPC payload must not carry the stale host selection.
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostIds: undefined }),
    );
    // Store-level selection is reset to empty for the fresh session.
    expect(useSessionStore.getState().hostIds).toEqual([]);
  });

  it('explicitly passed hostIds are still honored (@mention flow)', async () => {
    useSessionStore.setState({ hostIds: [] });
    await useSessionStore.getState().createSession({ hostIds: ['h9'], safetyMode: 'operator' });
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ hostIds: ['h9'] }));
    expect(useSessionStore.getState().hostIds).toEqual(['h9']);
  });
});
