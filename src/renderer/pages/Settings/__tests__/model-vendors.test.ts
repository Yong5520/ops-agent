// Tests for the model vendor preset table (model-vendors.ts).
//
// The preset table is a renderer-only helper (no DB column), so the contract
// is: unique ids, every preset has a valid SDK type, every concrete preset has
// a non-empty endpoint, and resolveVendorFromEndpoint round-trips the preset
// defaults back to their ids.

import { describe, it, expect } from 'vitest';
import {
  MODEL_VENDOR_PRESETS,
  getVendorPreset,
  resolveVendorFromEndpoint,
  CUSTOM_VENDOR_ID,
} from '../model-vendors.js';
import type { ModelProviderType } from '../../../../shared/types.js';

const VALID_TYPES: ModelProviderType[] = ['anthropic', 'openai', 'openai-compatible'];

describe('MODEL_VENDOR_PRESETS', () => {
  it('has unique ids', () => {
    const ids = MODEL_VENDOR_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the key vendors + custom fallback', () => {
    const ids = MODEL_VENDOR_PRESETS.map((p) => p.id);
    for (const id of [
      'anthropic',
      'openai',
      'ark',
      'deepseek',
      'dashscope',
      'zhipu',
      'moonshot',
      'siliconflow',
      'openrouter',
      'ollama',
      'vllm',
      CUSTOM_VENDOR_ID,
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('every preset has a valid SDK type', () => {
    for (const p of MODEL_VENDOR_PRESETS) {
      expect(VALID_TYPES).toContain(p.type);
    }
  });

  it('every concrete (non-custom) preset has a non-empty endpoint', () => {
    for (const p of MODEL_VENDOR_PRESETS) {
      if (p.id === CUSTOM_VENDOR_ID) continue;
      expect(p.defaultEndpoint.length).toBeGreaterThan(0);
    }
  });

  it('the custom preset has an empty endpoint', () => {
    const custom = getVendorPreset(CUSTOM_VENDOR_ID);
    expect(custom).toBeDefined();
    expect(custom!.defaultEndpoint).toBe('');
  });
});

describe('getVendorPreset', () => {
  it('returns the preset for a known id', () => {
    expect(getVendorPreset('deepseek')?.defaultEndpoint).toBe('https://api.deepseek.com/v1');
  });

  it('returns undefined for an unknown id', () => {
    expect(getVendorPreset('does-not-exist')).toBeUndefined();
  });
});

describe('resolveVendorFromEndpoint', () => {
  it('resolves a preset default endpoint back to its vendor id', () => {
    expect(resolveVendorFromEndpoint('https://api.anthropic.com/v1')).toBe('anthropic');
    expect(resolveVendorFromEndpoint('https://ark.cn-beijing.volces.com/api/v3')).toBe('ark');
    expect(resolveVendorFromEndpoint('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(resolveVendorFromEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(
      'dashscope',
    );
  });

  it('round-trips every concrete preset endpoint', () => {
    for (const p of MODEL_VENDOR_PRESETS) {
      if (p.id === CUSTOM_VENDOR_ID) continue;
      expect(resolveVendorFromEndpoint(p.defaultEndpoint)).toBe(p.id);
    }
  });

  it('falls back to custom for a user-customized endpoint', () => {
    expect(resolveVendorFromEndpoint('https://my-proxy.internal:8080/v1')).toBe(CUSTOM_VENDOR_ID);
  });

  it('falls back to custom for an empty / undefined endpoint', () => {
    expect(resolveVendorFromEndpoint('')).toBe(CUSTOM_VENDOR_ID);
    expect(resolveVendorFromEndpoint(undefined)).toBe(CUSTOM_VENDOR_ID);
    expect(resolveVendorFromEndpoint(null)).toBe(CUSTOM_VENDOR_ID);
    expect(resolveVendorFromEndpoint('   ')).toBe(CUSTOM_VENDOR_ID);
  });

  it('is not confused by a version-less variant of a preset URL', () => {
    // DeepSeek's docs sometimes show https://api.deepseek.com (no /v1); that
    // customized form should resolve to 'custom', not 'deepseek', since the
    // preset stores the /v1 form. The user can still connect (normalizeBaseURL
    // appends /v1) - this only affects which vendor the dropdown shows on edit.
    expect(resolveVendorFromEndpoint('https://api.deepseek.com')).toBe(CUSTOM_VENDOR_ID);
  });
});
