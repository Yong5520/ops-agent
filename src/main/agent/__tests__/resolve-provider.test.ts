// Unit tests for resolveModelProvider - the per-session model resolution used
// by the agent loop. Resolution order:
//   1. explicitId (passed in the run request)
//   2. session.model_provider_id (persisted override)
//   3. global active default (the Settings-page active model)
//   4. throws OpsAgentError when none yield a provider
//
// Critical contract: the returned provider must carry a DECRYPTED apiKey
// (i.e. it came from getWithSecret, not get - which strips the key). Using
// get() would silently break streamText with a confusing "API key missing".
import { describe, it, expect, beforeEach, vi } from 'vitest';

const stores = vi.hoisted(() => ({
  models: {
    getWithSecret: vi.fn(),
    getActive: vi.fn(),
  },
  sessions: {
    getModelProviderId: vi.fn(),
  },
}));

vi.mock('../../storage/models.js', () => ({ modelsStore: stores.models }));
vi.mock('../../storage/sessions.js', () => ({ sessionsStore: stores.sessions }));
vi.mock('../../ssh/connection.js', () => ({
  OpsAgentError: class OpsAgentError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'OpsAgentError';
      this.code = code;
    }
  },
}));
vi.mock('../model-errors.js', () => ({ formatModelError: (e: Error) => e.message }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { resolveModelProvider } from '../providers.js';

function provider(id: string, apiKey?: string) {
  return {
    id,
    name: `provider-${id}`,
    type: 'openai-compatible' as const,
    endpoint: `http://${id}/v1`,
    apiKey,
    modelName: `model-${id}`,
    contextWindow: 80000,
    isActive: false,
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stores.sessions.getModelProviderId.mockReturnValue(undefined);
});

describe('resolveModelProvider', () => {
  it('explicit id wins over session override and global default', () => {
    stores.models.getWithSecret.mockReturnValue(provider('explicit', 'key-explicit'));
    const result = resolveModelProvider('s1', 'explicit');
    expect(result.id).toBe('explicit');
    expect(stores.models.getWithSecret).toHaveBeenCalledWith('explicit');
    expect(stores.models.getActive).not.toHaveBeenCalled();
  });

  it('uses the session override when no explicit id is given', () => {
    stores.sessions.getModelProviderId.mockReturnValue('session-pick');
    stores.models.getWithSecret.mockReturnValue(provider('session-pick', 'key-session'));
    const result = resolveModelProvider('s1');
    expect(result.id).toBe('session-pick');
    expect(stores.sessions.getModelProviderId).toHaveBeenCalledWith('s1');
    expect(stores.models.getActive).not.toHaveBeenCalled();
  });

  it('falls back to the global active default when no override is set', () => {
    stores.models.getActive.mockReturnValue(provider('global', 'key-global'));
    const result = resolveModelProvider('s1');
    expect(result.id).toBe('global');
    expect(stores.models.getWithSecret).not.toHaveBeenCalled();
    expect(stores.models.getActive).toHaveBeenCalled();
  });

  it('falls back to global default when an override points at a deleted provider', () => {
    // A stale override (provider deleted without FK cascading) must NOT block
    // the session - it falls through to the global default.
    stores.sessions.getModelProviderId.mockReturnValue('deleted');
    stores.models.getWithSecret.mockReturnValue(null);
    stores.models.getActive.mockReturnValue(provider('global', 'key-global'));
    const result = resolveModelProvider('s1');
    expect(result.id).toBe('global');
  });

  it('throws when neither override nor global default is configured', () => {
    stores.sessions.getModelProviderId.mockReturnValue(undefined);
    stores.models.getActive.mockReturnValue(null);
    expect(() => resolveModelProvider('s1')).toThrow(/No model configured/);
  });

  it('throws when the resolved provider has an empty API key', () => {
    // getWithSecret returns the row WITH a decrypted key. If that key is
    // empty (misconfigured provider), we fail fast with a clear message
    // rather than letting streamText produce a confusing error later.
    stores.models.getWithSecret.mockReturnValue(provider('override', ''));
    expect(() => resolveModelProvider('s1', 'override')).toThrow(/empty API key/);
  });

  it('returns a provider whose apiKey is populated (proves getWithSecret was used)', () => {
    // Guards against a regression where get() (strips apiKey) is used instead
    // of getWithSecret - that would break streamText silently.
    stores.models.getWithSecret.mockReturnValue(provider('override', 'decrypted-key'));
    const result = resolveModelProvider('s1', 'override');
    expect(result.apiKey).toBe('decrypted-key');
  });
});
