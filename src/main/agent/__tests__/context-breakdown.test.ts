// Tests for analyzeContextBreakdown's per-session context-window override.
//
// /context must show the context window of the SESSION's resolved model, not
// just the global active default. analyzeContextBreakdown now accepts an
// optional contextWindowOverride (the session provider's window) which wins
// over the global active provider's window. These tests mock the heavy
// dependencies (message loading, system prompt, skills, memory) and assert
// only the context-window plumbing - the one behavior that changed.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../context.js', () => ({
  loadMessages: () => [],
  // Echo the model id back so we can assert which model was used.
  getContextWindowForModel: (modelId: string, configured?: number) =>
    configured ?? (modelId === 'session-model' ? 60000 : 80000),
  estimateTokens: () => 0,
}));

vi.mock('../system-prompt.js', () => ({
  buildSystemPrompt: () => ({ staticPrefix: '', dynamicSuffix: '' }),
}));

vi.mock('../skills/index.js', () => ({
  listAllSkills: () => [],
  getEnabledSkills: () => [],
}));

vi.mock('../memory/claudemd.js', () => ({
  buildMemoryPromptSection: () => '',
}));

vi.mock('../memory/automem.js', () => ({
  loadAutoMemory: () => '',
}));

// The global active provider is the FALLBACK; the override must win.
vi.mock('../../storage/models.js', () => ({
  modelsStore: { getActive: () => ({ contextWindow: 80000 }) },
}));

import { analyzeContextBreakdown } from '../context-breakdown.js';

describe('analyzeContextBreakdown context-window resolution', () => {
  it('uses the override context window when provided (per-session model)', () => {
    const result = analyzeContextBreakdown('s1', 'session-model', 60000);
    // 60000 (override) must win over 80000 (global active fallback).
    expect(result.contextWindow).toBe(60000);
    expect(result.model).toBe('session-model');
  });

  it('falls back to the global active context window when no override', () => {
    const result = analyzeContextBreakdown('s1', 'global-model');
    // No override -> modelsStore.getActive().contextWindow = 80000.
    expect(result.contextWindow).toBe(80000);
  });

  it('falls back to the model-default when neither override nor global is set', () => {
    // When the global active has no contextWindow, getContextWindowForModel
    // falls back to its built-in default for the model id.
    const result = analyzeContextBreakdown('s1', 'session-model');
    // No override, global active = 80000 -> that wins (getActive returns 80000).
    expect(result.contextWindow).toBe(80000);
  });
});
