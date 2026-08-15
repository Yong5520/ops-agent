// Model vendor presets for the Settings "添加模型" form.
//
// The stored ModelProvider record only carries `type` (anthropic | openai |
// openai-compatible) + `endpoint` + `modelName` - there is no `vendor` column,
// so this table is a renderer-only helper that saves the user from typing
// well-known endpoint URLs. Selecting a vendor auto-fills `type` + `endpoint`
// (+ a modelName placeholder hint). The endpoint stays editable for vendors
// with workspace-specific URLs (e.g. DashScope) or self-hosted deployments.
//
// URLs verified against vendor docs (2026-08): OpenAI, Anthropic, Ark (in
// code), DeepSeek, DashScope, Moonshot, SiliconFlow confirmed via WebFetch.
// 智谱/千帆/混元 are the documented OpenAI-compatible endpoints; all endpoints
// are user-editable and the "测试连接" button validates them before save.

import type { ModelProviderType } from '../../../shared/types.js';

export interface ModelVendorPreset {
  id: string;
  label: string;
  /** The SDK provider type this vendor maps to. */
  type: ModelProviderType;
  /** Default endpoint URL. Empty string for 'custom' (user must fill in). */
  defaultEndpoint: string;
  /** Suggested model name shown as a placeholder hint. Optional. */
  defaultModel?: string;
  /** Link to the vendor's API-key / docs page. Optional. */
  docUrl?: string;
}

export const MODEL_VENDOR_PRESETS: ModelVendorPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    type: 'anthropic',
    defaultEndpoint: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    docUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    type: 'openai',
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    docUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'ark',
    label: '火山引擎 Ark (豆包/Doubao)',
    type: 'openai-compatible',
    defaultEndpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    // Ark uses per-model endpoint IDs (ep-xxx), not model names.
    docUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    defaultEndpoint: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    docUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'dashscope',
    label: '阿里通义千问 (DashScope)',
    type: 'openai-compatible',
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    docUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    type: 'openai-compatible',
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    docUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    type: 'openai-compatible',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    docUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    type: 'openai-compatible',
    defaultEndpoint: 'https://api.siliconflow.cn/v1',
    docUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai-compatible',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    docUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'qianfan',
    label: '百度千帆 (Baidu Qianfan)',
    type: 'openai-compatible',
    defaultEndpoint: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-8k-latest',
    docUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元 (Tencent Hunyuan)',
    type: 'openai-compatible',
    defaultEndpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-pro',
    docUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    type: 'openai-compatible',
    defaultEndpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    docUrl: 'https://ollama.com/',
  },
  {
    id: 'vllm',
    label: 'vLLM (本地)',
    type: 'openai-compatible',
    defaultEndpoint: 'http://localhost:8000/v1',
    docUrl: 'https://docs.vllm.ai/',
  },
  {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    type: 'openai-compatible',
    defaultEndpoint: '',
  },
];

/** The 'custom' preset id - the fallback when no preset matches. */
export const CUSTOM_VENDOR_ID = 'custom';

/**
 * Look up a preset by id. Returns undefined for an unknown id.
 * Pure + exported for unit testing.
 */
export function getVendorPreset(id: string): ModelVendorPreset | undefined {
  return MODEL_VENDOR_PRESETS.find((p) => p.id === id);
}

/**
 * Resolve the vendor id from a stored endpoint URL. Used on edit to show the
 * right vendor in the dropdown even though only type+endpoint are persisted.
 * Matches the endpoint exactly against preset defaults; any customized or
 * unknown endpoint falls back to 'custom'. Pure + exported for unit testing.
 */
export function resolveVendorFromEndpoint(endpoint: string | undefined | null): string {
  const normalized = (endpoint ?? '').trim();
  if (!normalized) return CUSTOM_VENDOR_ID;
  const match = MODEL_VENDOR_PRESETS.find(
    (p) => p.defaultEndpoint !== '' && p.defaultEndpoint === normalized,
  );
  return match ? match.id : CUSTOM_VENDOR_ID;
}
