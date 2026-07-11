import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { modelsStore } from '../storage/models.js';
import { OpsAgentError } from '../ssh/connection.js';
import { logger } from '../utils/logger.js';
import type { ModelProvider } from '../../shared/types.js';

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

// Validate that a provider config can actually connect. Used by the Settings
// UI "Test connection" button. Makes a real generateText call with maxTokens=1
// to verify the endpoint, API key, and model name are all correct.
export async function testProviderConnection(
  provider: ModelProvider,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await validateModelExists(provider);

    const model = createLanguageModel(provider);
    await generateText({
      model,
      prompt: 'hi',
      maxTokens: 1,
    });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message || 'Unknown error';
    if (msg.includes('不存在') || msg.includes('可用模型')) {
      return { ok: false, error: msg };
    }
    if (
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed')
    ) {
      return {
        ok: false,
        error: `无法连接到 API 端点: ${msg}\n提示: 请检查端点 URL 和模型名称是否正确。端点需以 /v1 结尾（如 http://host:port/v1）。`,
      };
    }
    if (msg.includes('404') || msg.includes('Not Found')) {
      return {
        ok: false,
        error: `API 返回 404 - 端点路径不正确。\n提示: 端点 URL 应包含 /v1 路径（如 http://host:port/v1）。`,
      };
    }
    return { ok: false, error: msg };
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
// end with a version segment (e.g., /v1, /v2). This handles the common
// case where users enter a bare host URL like "http://10.114.22.18:3000".
export function normalizeBaseURL(endpoint: string | undefined, defaultURL: string): string {
  const url = endpoint?.trim() || defaultURL;
  const trimmed = url.replace(/\/+$/, '');
  if (!/\/v\d+$/.test(trimmed)) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}
