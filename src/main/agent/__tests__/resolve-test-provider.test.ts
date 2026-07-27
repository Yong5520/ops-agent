// Tests for resolveTestProvider: the pure merge logic behind the
// "测试连接" button.
//
// The UI's model form lets the user leave the API Key field blank when editing
// an existing provider ("留空不修改"). To actually test the connection we
// need a complete provider config with a real key. resolveTestProvider merges
// the form input with the stored record so a blank form key falls back to the
// stored key (and a provided form key overrides the stored one).

import { describe, it, expect } from 'vitest';
import { resolveTestProvider, resolveTestTarget } from '../providers.js';
import type { ModelProvider, ModelProviderInput } from '../../../shared/types.js';

const STORED_PROVIDER: ModelProvider = {
  id: 'prov-1',
  name: 'My GLM',
  type: 'openai-compatible',
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: 'stored-secret-key',
  modelName: 'glm-5.2',
  contextWindow: 128000,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function formInput(overrides: Partial<ModelProviderInput> = {}): ModelProviderInput {
  return {
    name: 'My GLM',
    type: 'openai-compatible',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'new-form-key',
    modelName: 'glm-5.2',
    contextWindow: 128000,
    ...overrides,
  };
}

describe('resolveTestProvider', () => {
  it('uses the form apiKey when provided (create flow, no stored provider)', () => {
    const resolved = resolveTestProvider(formInput(), null);
    expect(resolved.apiKey).toBe('new-form-key');
    expect(resolved.modelName).toBe('glm-5.2');
  });

  it('falls back to the stored apiKey when the form key is blank (edit flow)', () => {
    // User opens "编辑" on an existing provider, leaves the key field empty.
    const resolved = resolveTestProvider(formInput({ apiKey: undefined }), STORED_PROVIDER);
    expect(resolved.apiKey).toBe('stored-secret-key');
  });

  it('falls back to the stored apiKey when the form key is only whitespace', () => {
    // "  " must be treated as blank so the stored key is used, not a
    // whitespace string that would 401 against the API.
    const resolved = resolveTestProvider(formInput({ apiKey: '   ' }), STORED_PROVIDER);
    expect(resolved.apiKey).toBe('stored-secret-key');
  });

  it('overrides the stored apiKey when the form provides a new key', () => {
    const resolved = resolveTestProvider(formInput({ apiKey: 'rotated-key' }), STORED_PROVIDER);
    expect(resolved.apiKey).toBe('rotated-key');
  });

  it('returns a blank apiKey when neither form nor stored provides one', () => {
    // New provider, user hasn't entered a key yet but hits "测试连接" early.
    // The caller (testProviderConnection) will surface a clear "missing key"
    // error rather than sending an empty string to the API.
    const resolved = resolveTestProvider(formInput({ apiKey: undefined }), null);
    expect(resolved.apiKey).toBeUndefined();
  });

  it('prefers form endpoint/modelName but falls back to stored when form omits', () => {
    const resolved = resolveTestProvider(
      formInput({ endpoint: '   ', modelName: '  ' }),
      STORED_PROVIDER,
    );
    expect(resolved.endpoint).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(resolved.modelName).toBe('glm-5.2');
  });

  it('preserves the form type and name verbatim', () => {
    const resolved = resolveTestProvider(
      formInput({ type: 'anthropic', name: 'Claude' }),
      STORED_PROVIDER,
    );
    expect(resolved.type).toBe('anthropic');
    expect(resolved.name).toBe('Claude');
  });
});

describe('resolveTestTarget', () => {
  // Builds the final ModelProvider to probe. The contract this pins down is
  // the regression where the test button failed with "API key is missing"
  // even though chat worked: the handler MUST hand resolveTestTarget a stored
  // row that already has its apiKey DECRYPTED (getWithSecret), and that key
  // must reach the returned target.

  it('returns a synthesized target carrying the decrypted stored key when input has none (card test flow)', () => {
    // input=null, stored has a decrypted key -> target MUST keep that key.
    const target = resolveTestTarget(null, STORED_PROVIDER);
    expect(target).not.toBeNull();
    expect(target!.apiKey).toBe('stored-secret-key');
    expect(target!.modelName).toBe('glm-5.2');
    // Synthesized rows get identity/isActive from the stored row.
    expect(target!.id).toBe('prov-1');
    expect(target!.isActive).toBe(true);
  });

  it('returns a synthesized target carrying the form key when provided (edit flow)', () => {
    const target = resolveTestTarget(formInput({ apiKey: 'fresh-form-key' }), STORED_PROVIDER);
    expect(target!.apiKey).toBe('fresh-form-key');
  });

  it('returns null when there is no input and no stored row', () => {
    expect(resolveTestTarget(null, null)).toBeNull();
  });

  it('falls back to the stored row verbatim when neither form nor a synthesized key is usable', () => {
    // Edge: a stored row whose apiKey is undefined (e.g. read via get() which
    // strips secrets - the bug). We cannot synthesize a usable target, so fall
    // back to the stored row itself (the handler then surfaces a clear
    // "missing key" error rather than sending an empty key to the API).
    const storedNoKey: ModelProvider = { ...STORED_PROVIDER, apiKey: undefined };
    const target = resolveTestTarget(formInput({ apiKey: undefined }), storedNoKey);
    expect(target).toBe(storedNoKey);
  });

  it('REGRESSION: the decrypted stored key is preserved end-to-end (not stripped)', () => {
    // This is the exact scenario that broke: card "测试" on a model that
    // works in chat. stored.apiKey is the DECRYPTED key from getWithSecret.
    // The target must carry it - if it were undefined, testProviderConnection
    // would receive no key and the Anthropic SDK would throw
    // "API key is missing".
    const target = resolveTestTarget(null, STORED_PROVIDER);
    expect(target!.apiKey).toBe('stored-secret-key');
    expect(target!.apiKey).not.toBeUndefined();
  });
});
