import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { modelsStore } from '../storage/models.js';
import { sessionsStore } from '../storage/sessions.js';
import { OpsAgentError } from '../ssh/connection.js';
import { formatModelError } from './model-errors.js';
import { logger } from '../utils/logger.js';
import type { ModelProvider, ModelProviderInput } from '../../shared/types.js';

// Model provider adapter - converts a ModelProvider DB record into a
// Vercel AI SDK LanguageModel instance. Supports three provider types:
//   - anthropic:          @ai-sdk/anthropic (Claude models)
//   - openai:             @ai-sdk/openai (GPT models)
//   - openai-compatible:  @ai-sdk/openai with custom baseURL (Ollama, vLLM, etc.)

export function createLanguageModel(provider: ModelProvider): LanguageModel {
  switch (provider.type) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: provider.apiKey,
        baseURL: normalizeBaseURL(provider.endpoint, 'https://api.anthropic.com/v1'),
      });
      return anthropic(provider.modelName);
    }

    case 'openai': {
      const openai = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: normalizeBaseURL(provider.endpoint, 'https://api.openai.com/v1'),
      });
      return openai(provider.modelName);
    }

    case 'openai-compatible': {
      if (!provider.endpoint) {
        throw new OpsAgentError(
          `OpenAI-compatible provider "${provider.name}" requires an endpoint URL`,
          'INVALID_PARAMS',
        );
      }
      const baseURL = normalizeBaseURL(provider.endpoint, 'http://localhost:11434/v1');
      const openai = createOpenAI({
        apiKey: provider.apiKey ?? 'not-required',
        baseURL,
        compatibility: 'compatible',
      });
      return openai(provider.modelName);
    }

    default: {
      const exhaustive: never = provider.type;
      throw new OpsAgentError(`Unknown provider type: ${String(exhaustive)}`, 'INVALID_PARAMS');
    }
  }
}

// Load the active model provider from DB and create a LanguageModel.
export function getActiveModel(): LanguageModel {
  const provider = modelsStore.getActive();
  if (!provider) {
    throw new OpsAgentError(
      'No active model provider configured. Please configure one in Settings.',
      'INVALID_PARAMS',
    );
  }
  const keyMasked = provider.apiKey
    ? `${provider.apiKey.slice(0, 8)}...${provider.apiKey.slice(-4)}`
    : '(empty)';
  logger.info(
    `Using model: ${provider.name} (${provider.type}/${provider.modelName}) endpoint=${provider.endpoint} key=${keyMasked}`,
  );
  if (!provider.apiKey) {
    throw new OpsAgentError(
      `Active model "${provider.name}" has an empty API key. Please re-enter the key in Settings.`,
      'INVALID_PARAMS',
    );
  }
  return createLanguageModel(provider);
}

// Resolve the ModelProvider (DB record, with decrypted apiKey) to use for a
// given session. Resolution order:
//   1. explicitId - passed in the run request (the renderer's current view)
//   2. session.model_provider_id - the persisted per-session override
//   3. the global active default - the Settings-page active model
//   4. throws OpsAgentError if none of the above yield a provider
//
// Uses getWithSecret (not get) so the returned provider carries a usable
// apiKey for createLanguageModel / streamText. If an override id points at a
// provider that no longer exists (deleted without the FK cascading), we fall
// through to the global default rather than erroring, so a stale override
// never blocks the session.
export function resolveModelProvider(sessionId: string, explicitId?: string): ModelProvider {
  const overrideId = explicitId ?? sessionsStore.getModelProviderId(sessionId) ?? null;
  const override = overrideId ? modelsStore.getWithSecret(overrideId) : null;
  if (overrideId && !override) {
    // Override points at a provider that no longer exists (deleted, or the
    // FK hasn't cascaded). Fall through to the global default rather than
    // erroring, so a stale override never blocks the session.
    logger.warn(
      `[Providers] Session ${sessionId} override "${overrideId}" not found; falling back to global default`,
    );
  }
  const provider = override ?? modelsStore.getActive();
  if (!provider) {
    throw new OpsAgentError(
      'No model configured. Set a default in Settings or pick a model for this session.',
      'INVALID_PARAMS',
    );
  }
  if (!provider.apiKey) {
    throw new OpsAgentError(
      `Model "${provider.name}" has an empty API key. Re-enter it in Settings.`,
      'INVALID_PARAMS',
    );
  }
  logger.info(
    `Using model: ${provider.name} (${provider.type}/${provider.modelName}) endpoint=${provider.endpoint}`,
  );
  return provider;
}

// Resolve a complete provider config for connection testing. The model form
// lets the user leave the API Key field blank when editing an existing
// provider ("留空不修改"). To actually test, we need a real key - so a blank
// form key falls back to the stored provider's key, while a provided form key
// overrides it. Endpoint/modelName fall back to the stored values too, so a
// user can hit "测试连接" on a freshly-opened edit form without re-typing.
//
// Pure function (no DB / network) so it is straightforward to unit-test.
export function resolveTestProvider(
  input: ModelProviderInput | null,
  stored: ModelProvider | null,
): ModelProviderInput {
  const blank = (v: string | number | undefined | null): boolean => {
    if (v === undefined || v === null) return true;
    return typeof v === 'string' && v.trim() === '';
  };
  return {
    name: input?.name || stored?.name || '',
    type: input?.type || stored?.type || 'openai-compatible',
    endpoint: blank(input?.endpoint) ? stored?.endpoint || '' : input!.endpoint,
    apiKey: blank(input?.apiKey) ? stored?.apiKey : input!.apiKey,
    modelName: blank(input?.modelName) ? stored?.modelName || '' : input!.modelName,
    contextWindow: blank(input?.contextWindow) ? stored?.contextWindow : input!.contextWindow,
  };
}

// Build the final ModelProvider to probe, from form input + a stored row that
// ALREADY has its apiKey decrypted (the handler must pass getWithSecret(id),
// not get(id) - get() strips the secret and would cause "API key is missing").
//
// If the resolved config has a real apiKey (form key, or stored decrypted key),
// synthesize a full ModelProvider row. Otherwise fall back to the stored row
// verbatim (which carries the decrypted key when one exists). Returns null
// only when there is no stored row AND no input at all.
//
// Pure function so the key-preservation contract is unit-testable.
export function resolveTestTarget(
  input: ModelProviderInput | null,
  stored: ModelProvider | null,
): ModelProvider | null {
  const resolved = resolveTestProvider(input, stored);
  if (resolved.apiKey) {
    return {
      ...resolved,
      id: stored?.id ?? '',
      isActive: stored?.isActive ?? false,
      createdAt: stored?.createdAt ?? '',
      updatedAt: stored?.updatedAt ?? '',
    };
  }
  // No usable key in the form OR the stored row was read without decrypting
  // (shouldn't happen if the handler uses getWithSecret). Fall back to the
  // stored row, which carries its decrypted key when present.
  return stored;
}

// Pattern matching SDK response-parse failures that should trigger the raw
// HTTP fallback. Two known shapes:
//   - "Invalid JSON response" - the SDK could not parse the body at all.
//   - "signature" - glm-5.2 thinking blocks omit the signature field the SDK
//     validates, so the SDK rejects an otherwise-200 response.
// Either means the connection itself is fine; the chat path (streamText)
// tolerates these bodies, so the test button must too.
const SDK_PARSE_ERROR_PATTERN = /Invalid JSON response|signature/i;

// SDK-bypass connectivity probe. Some models (e.g. glm-5.2) return response
// bodies the Vercel AI SDK refuses to parse ("Invalid JSON response" - their
// thinking blocks omit the `signature` field the SDK requires). The chat path
// uses streamText and tolerates this, but generateText throws, so the
// "测试连接" button would report a failure on a model that actually works.
//
// This function sends a minimal HTTP request straight to the provider's chat
// endpoint and looks ONLY at the HTTP status code. A 200 means the endpoint is
// reachable, the API key is valid, and the model name is accepted - i.e. the
// connection is healthy regardless of whether the SDK can parse the body. A
// non-200 is thrown with its status code so formatModelError can classify it.
//
// Bounded by a 15s timeout so a dead endpoint cannot hang the UI.
export async function rawProbeConnection(provider: ModelProvider): Promise<void> {
  const isAnthropic = provider.type === 'anthropic';
  const defaultURL = isAnthropic
    ? 'https://api.anthropic.com/v1'
    : provider.type === 'openai'
      ? 'https://api.openai.com/v1'
      : 'http://localhost:11434/v1';
  const baseURL = normalizeBaseURL(provider.endpoint, defaultURL);
  const url = isAnthropic ? `${baseURL}/messages` : `${baseURL}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = provider.apiKey ?? '';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${provider.apiKey ?? 'not-required'}`;
  }
  const body = JSON.stringify({
    model: provider.modelName,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const snippet = errText ? `: ${errText.slice(0, 200)}` : '';
    throw new Error(`HTTP ${response.status}${snippet}`);
  }
}

// Validate that a provider config can actually connect. Used by the Settings
// UI "测试连接" button. Makes a real generateText call to verify the endpoint,
// API key, and model name are all correct.
//
// Returns ok + the round-trip latencyMs on success, or a friendly error
// (reusing formatModelError so test-button messages match run-time error
// messages) PLUS the raw underlying cause on failure - so the user can actually
// diagnose WHY it failed (e.g. "ECONNREFUSED" not just "无法连接").
//
// maxTokens=16 (not 1): reasoning/thinking models (glm-5.2 etc.) count
// thinking tokens against max_tokens, and max_tokens=1 makes them reject the
// request with a 400. 16 is enough to pass their minimum while staying cheap
// for a connectivity probe. The generateText call is bounded by a 15s timeout
// so a dead endpoint cannot hang the UI indefinitely.
export async function testProviderConnection(
  provider: ModelProvider,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await validateModelExists(provider);

    const model = createLanguageModel(provider);
    await generateText({
      model,
      prompt: 'hi',
      maxTokens: 16,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (err) {
    const error = err as Error;
    const msg = error.message || 'Unknown error';
    logger.warn(`[Providers] Connection test failed for "${provider.name}": ${msg}`);
    const latencyMs = Date.now() - start;

    // SDK-bypass fallback: some models (glm-5.2, etc.) return response bodies
    // the AI SDK refuses to parse ("Invalid JSON response" / "signature"
    // validation errors), even though the endpoint is reachable, the key is
    // valid, and the model works fine via streamText in chat. Re-probe with a
    // raw HTTP request that only checks the status code; a 200 means the
    // connection is healthy. (Mirrors the fallback already used in ai-command.)
    if (SDK_PARSE_ERROR_PATTERN.test(msg)) {
      try {
        await rawProbeConnection(provider);
        logger.info(
          `[Providers] SDK rejected "${provider.name}" response body, but raw HTTP probe succeeded (connection healthy)`,
        );
        return { ok: true, latencyMs };
      } catch (probeErr) {
        // The raw probe also failed - surface THAT error (it carries the real
        // HTTP status code, which is more actionable than the SDK parse error).
        const probeMsg = (probeErr as Error).message;
        logger.warn(`[Providers] Raw probe also failed: ${probeMsg}`);
        const probeFriendly = formatModelError(probeErr as Error);
        const probeWithCause =
          probeFriendly !== probeMsg ? `${probeFriendly}\n（原因：${probeMsg}）` : probeMsg;
        return { ok: false, latencyMs, error: probeWithCause };
      }
    }

    // OpsAgentError from validateModelExists (model name not found, etc.) -
    // already a friendly, self-explanatory message. Surface verbatim.
    if (error.name === 'OpsAgentError' || msg.includes('不存在') || msg.includes('可用模型')) {
      return { ok: false, latencyMs, error: msg };
    }
    // Reuse the shared classifier so "测试连接" failures read identically to
    // run-time loop failures (same wording, same nudge toward Settings) - but
    // ALSO append the raw cause so the user can diagnose the specific problem
    // (which friendly message alone hides).
    const friendly = formatModelError(error);
    const errorWithCause = friendly !== msg ? `${friendly}\n（原因：${msg}）` : msg;
    return { ok: false, latencyMs, error: errorWithCause };
  }
}

// Validate that the configured model name actually exists on the provider's
// endpoint. Some proxies (New API) reset the TCP connection instead of
// returning a clean HTTP error when the model name is invalid.
export async function validateModelExists(provider: ModelProvider): Promise<void> {
  if (provider.type !== 'openai-compatible' && provider.type !== 'openai') return;

  const baseURL = normalizeBaseURL(provider.endpoint, 'https://api.openai.com/v1');
  const apiKey = provider.apiKey ?? 'not-required';

  try {
    const response = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return;

    const data = (await response.json()) as { data?: Array<{ id: string }> };
    const models = data.data ?? [];
    if (models.length === 0) return;

    const modelExists = models.some((m) => m.id === provider.modelName);
    if (!modelExists) {
      const available = models
        .map((m) => m.id)
        .slice(0, 10)
        .join(', ');
      throw new OpsAgentError(
        `模型 "${provider.modelName}" 在端点上不存在。可用模型: ${available}${models.length > 10 ? '...' : ''}\n请在设置页更正模型名称。`,
        'INVALID_PARAMS',
      );
    }
  } catch (err) {
    if (err instanceof OpsAgentError) throw err;
    logger.warn(`[Providers] Model validation skipped: ${(err as Error).message}`);
  }
}

// Normalize an endpoint URL. Auto-appends /v1 if the URL doesn't already
// contain a version segment (e.g., /v1, /v2, /v3) anywhere in the path.
// This handles:
//   - Bare host URLs: "http://10.114.22.18:3000" -> ".../v1"
//   - URLs with version in path: "https://ark.../api/v3" -> no append
//   - URLs with version mid-path: "https://ark.../api/v3/responses" -> no append
//   - Trailing slashes are stripped.
export function normalizeBaseURL(endpoint: string | undefined, defaultURL: string): string {
  const url = endpoint?.trim() || defaultURL;
  const trimmed = url.replace(/\/+$/, '');
  // Check if any path segment matches v\d+ (e.g., v1, v2, v3)
  const pathSegments = trimmed.split('/').filter(Boolean);
  const hasVersionSegment = pathSegments.some((seg) => /^v\d+$/.test(seg));
  if (!hasVersionSegment) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}
