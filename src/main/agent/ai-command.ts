// AI command generation for the terminal page.
//
// Users type natural language (e.g., "统计下当前目录的大小") and the AI
// generates a corresponding Linux command + explanation + safety level.
// The user then approves/modifies/rejects before execution.
//
// This module provides:
//   - parseCommandResponse: robust JSON extraction from AI text output
//   - generateCommand: calls the active AI model via generateText
//     with raw HTTP fallback for providers that return non-standard
//     response shapes (e.g., glm-5.2 thinking blocks without signatures)

import { generateText } from 'ai';
import { getActiveModel } from './providers.js';
import { modelsStore } from '../storage/models.js';
import { gatherHostFacts } from './facts.js';
import { hostsStore } from '../storage/hosts.js';
import { logger } from '../utils/logger.js';

export interface GeneratedCommand {
  command: string;
  explanation: string;
  safetyLevel: 'read' | 'write' | 'sudo';
}

export interface GenerateCommandParams {
  naturalLanguage: string;
  hostId?: string;
}

/**
 * Parse the AI's text response into a GeneratedCommand.
 *
 * The AI may wrap JSON in markdown code blocks or surround it with
 * conversational text. We extract the first valid JSON object and
 * parse its fields. If parsing fails, fall back to using the raw text
 * as the command (conservative: treat as write-level for safety).
 */
export function parseCommandResponse(raw: string): GeneratedCommand {
  if (!raw || raw.trim().length === 0) {
    return { command: '', explanation: '', safetyLevel: 'write' };
  }

  // Try to extract a JSON object from the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const command = typeof parsed.command === 'string' ? parsed.command.trim() : '';
      const explanation = typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '';
      const rawSafety =
        typeof parsed.safetyLevel === 'string' ? parsed.safetyLevel.toLowerCase() : '';
      const safetyLevel = normalizeSafetyLevel(rawSafety);
      return { command, explanation, safetyLevel };
    } catch {
      // JSON parse failed - fall through to raw text fallback
    }
  }

  // Fallback: treat raw text as the command itself
  return {
    command: raw.trim(),
    explanation: '',
    safetyLevel: 'write',
  };
}

function normalizeSafetyLevel(raw: string): 'read' | 'write' | 'sudo' {
  if (raw === 'read' || raw === 'write' || raw === 'sudo') return raw;
  return 'write'; // conservative default for unknown levels
}

/**
 * Build the system prompt for command generation.
 * Includes host facts (OS, kernel) if available for context-aware commands.
 */
function buildSystemPrompt(osInfo?: string, kernelInfo?: string): string {
  const hostContext = osInfo
    ? `\n## 目标主机信息\n- 操作系统: ${osInfo}\n- 内核: ${kernelInfo ?? 'unknown'}\n`
    : '';

  return `你是一个 Linux 运维助手。用户用自然语言描述操作意图，你生成对应的 Linux 命令。
${hostContext}
## 规则
1. 只生成一条命令（可用管道 | 或 && 组合多条）
2. 命令必须安全、正确、可直接在 bash 中执行
3. 返回严格的 JSON 格式，不要包含 markdown 代码块标记：
   {"command":"具体命令","explanation":"中文解释每个参数的作用","safetyLevel":"read|write|sudo"}
4. safetyLevel 判定标准：
   - read: 只读操作（ls, cat, ps, df, free, du, top, grep 等）
   - write: 修改文件或系统状态（rm, cp, mv, mkdir, touch, systemctl restart 等）
   - sudo: 需要 root 权限执行的命令
5. 禁止生成 rm -rf /、mkfs、dd if=/dev/zero 等破坏性命令
6. 如果用户意图不明确，生成最接近的命令并在 explanation 中说明假设

## 示例
用户输入: "统计当前目录大小"
输出: {"command":"du -sh .","explanation":"du 统计磁盘使用，-s 汇总不显示子目录，-h 人类可读格式(GB/MB)","safetyLevel":"read"}

用户输入: "查看内存使用"
输出: {"command":"free -h","explanation":"free 显示内存使用情况，-h 以人类可读格式显示","safetyLevel":"read"}

用户输入: "重启 nginx 服务"
输出: {"command":"sudo systemctl restart nginx","explanation":"systemctl restart 重启服务，sudo 获取 root 权限","safetyLevel":"sudo"}`;
}

/**
 * Raw HTTP fallback for providers where the Anthropic SDK's strict
 * response validation fails (e.g., glm-5.2 returns thinking blocks
 * without the `signature` field that @ai-sdk/anthropic requires).
 *
 * Makes a direct POST to the provider's Anthropic-compatible /messages
 * endpoint and extracts text content manually.
 */
async function rawAnthropicGenerate(
  provider: { apiKey: string; endpoint?: string; modelName: string },
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
): Promise<string> {
  const baseURL = (provider.endpoint || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const url = `${baseURL}/messages`;

  const body = {
    model: provider.modelName,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI request failed (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  // Extract text from content blocks, skip thinking blocks
  const textBlocks = (data.content || []).filter((b) => b.type === 'text' && b.text);
  return textBlocks.map((b) => b.text!).join('');
}

/**
 * Generate a Linux command from natural language input.
 * Uses the active AI model provider.
 *
 * Strategy:
 * 1. Try the Vercel AI SDK's generateText (preferred - handles streaming, retries, etc.)
 * 2. If that fails with a type validation error (e.g., glm-5.2 thinking blocks
 *    without signatures), fall back to raw HTTP call that bypasses SDK validation
 */
export async function generateCommand(params: GenerateCommandParams): Promise<GeneratedCommand> {
  const { naturalLanguage, hostId } = params;

  let osInfo: string | undefined;
  let kernelInfo: string | undefined;

  // If hostId is provided, gather host facts for context
  if (hostId) {
    const host = hostsStore.get(hostId);
    if (host) {
      try {
        const facts = await gatherHostFacts(hostId, host.name);
        if (facts) {
          osInfo = facts.os;
          kernelInfo = facts.kernel;
        }
      } catch (err) {
        logger.warn(`[AI Command] Failed to gather host facts: ${(err as Error).message}`);
      }
    }
  }

  const systemPrompt = buildSystemPrompt(osInfo, kernelInfo);
  const model = getActiveModel();

  logger.info(
    `[AI Command] Generating command for: "${naturalLanguage.slice(0, 80)}"${hostId ? ` (host: ${hostId})` : ''}`,
  );

  let text: string;

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: naturalLanguage,
      maxTokens: 1024,
    });
    text = result.text;
  } catch (err) {
    const errMsg = (err as Error).message || '';
    // Check if this is the known glm-5.2 thinking signature validation error
    if (errMsg.includes('Invalid JSON response') || errMsg.includes('signature')) {
      logger.warn(`[AI Command] SDK failed (${errMsg.slice(0, 120)}), falling back to raw HTTP`);
      const provider = modelsStore.getActive();
      if (!provider || !provider.apiKey) {
        throw new Error('No active model provider with API key configured');
      }
      text = await rawAnthropicGenerate(
        { apiKey: provider.apiKey, endpoint: provider.endpoint, modelName: provider.modelName },
        systemPrompt,
        naturalLanguage,
        1024,
      );
    } else {
      throw err;
    }
  }

  return parseCommandResponse(text);
}
