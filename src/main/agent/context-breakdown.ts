// Context breakdown analyzer for the /context command.
//
// Analyzes the current session's context window usage by category:
// system prompt sections, tool definitions, skill metadata, messages,
// memory files, and free space. Returns a structured breakdown that the
// renderer renders as a markdown table.
//
// Token counts are char-based estimates (1 token ≈ 3 chars). This is
// approximate but sufficient for a "what's eating my context" overview.
// When the API returns actual usage (promptTokens), the caller can use
// that for a more accurate total.

import { loadMessages, getContextWindowForModel, estimateTokens } from './context.js';
import { buildSystemPrompt } from './system-prompt.js';
import { listAllSkills, getEnabledSkills } from './skills/index.js';
import { buildMemoryPromptSection } from './memory/claudemd.js';
import { loadAutoMemory } from './memory/automem.js';
import { modelsStore } from '../storage/models.js';

const CHARS_PER_TOKEN = 3;

export interface ContextCategory {
  name: string;
  tokens: number;
  percentage: number;
}

export interface ContextSection {
  name: string;
  tokens: number;
}

export interface ContextBreakdown {
  model: string;
  contextWindow: number;
  totalUsed: number;
  percentage: number;
  categories: ContextCategory[];
  systemPromptSections: ContextSection[];
  tools: ContextSection[];
  skills: Array<{ name: string; tokens: number; enabled: boolean }>;
  messageBreakdown: {
    userMessages: number;
    assistantMessages: number;
    systemMessages: number;
    totalTokens: number;
  };
}

// Approximate token count for a string.
function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Known tool names (from createTools). We estimate each tool's token cost
// from its description + parameter schema. Since the actual tool definitions
// are created inside createTools (which requires a SessionContext), we use
// a static estimate table based on the tool's complexity.
const TOOL_TOKEN_ESTIMATES: Record<string, number> = {
  exec: 450,
  sudo_exec: 500,
  read_file: 250,
  write_file: 350,
  list_hosts: 150,
  rollback: 200,
  tail_log: 200,
  search_logs: 250,
  journal_query: 300,
  process_list: 200,
  service_status: 200,
  disk_analysis: 200,
  network_connections: 200,
  read_tool_result: 150,
  todo_write: 400,
  update_memory: 300,
  exit_plan_mode: 350,
  ask_user: 400,
};

export function analyzeContextBreakdown(sessionId: string, modelId: string): ContextBreakdown {
  // Get DB-configured context window if available
  const activeProvider = modelsStore.getActive();
  const contextWindow = getContextWindowForModel(modelId, activeProvider?.contextWindow);

  // ── System prompt sections ──────────────────────────────────────────
  const { staticPrefix, dynamicSuffix } = buildSystemPrompt({
    selectedHostIds: [],
    safetyMode: 'operator',
  });

  // Split static prefix by the section separator used in buildSystemPrompt
  const staticSections = staticPrefix.split('\n\n---\n\n').filter((s) => s.length > 0);
  const systemPromptSections: ContextSection[] = staticSections.map((section) => {
    // Extract a readable name from the first markdown heading
    const headingMatch = section.match(/^#+\s+(.+)$/m);
    const name = headingMatch ? headingMatch[1]!.trim() : section.slice(0, 40);
    return { name, tokens: countTokens(section) };
  });

  // Add dynamic suffix as a section
  if (dynamicSuffix) {
    systemPromptSections.push({
      name: '运行时动态上下文',
      tokens: countTokens(dynamicSuffix),
    });
  }

  const systemPromptTokens = systemPromptSections.reduce((sum, s) => sum + s.tokens, 0);

  // ── Tools ────────────────────────────────────────────────────────────
  const tools: ContextSection[] = Object.entries(TOOL_TOKEN_ESTIMATES).map(([name, tokens]) => ({
    name,
    tokens,
  }));
  const toolsTokens = tools.reduce((sum, t) => sum + t.tokens, 0);

  // ── Skills (metadata only - progressive disclosure) ─────────────────
  const allSkills = listAllSkills();
  const enabledSkills = getEnabledSkills();
  const enabledNames = new Set(enabledSkills.map((s) => s.name));

  const skills = allSkills.map((skill) => {
    // Estimate frontmatter tokens: name + description + whenToUse
    const frontmatterText = [skill.displayName, skill.name, skill.description].join(' ');
    return {
      name: skill.name,
      tokens: countTokens(frontmatterText),
      enabled: enabledNames.has(skill.name),
    };
  });
  // Only count enabled skills in the total (disabled ones are not loaded)
  const skillsTokens = skills.filter((s) => s.enabled).reduce((sum, s) => sum + s.tokens, 0);

  // ── Messages ────────────────────────────────────────────────────────
  const messages = loadMessages(sessionId);
  let userMessages = 0;
  let assistantMessages = 0;
  let systemMessages = 0;

  for (const msg of messages) {
    if (msg.role === 'user') userMessages++;
    else if (msg.role === 'assistant') assistantMessages++;
    else if (msg.role === 'system') systemMessages++;
  }
  const messageTokens = estimateTokens(messages);

  // ── Memory files ────────────────────────────────────────────────────
  const memoryContent = buildMemoryPromptSection();
  const autoMemory = loadAutoMemory() ?? '';
  const memoryTokens = countTokens(memoryContent) + countTokens(autoMemory);

  // ── Autocompact buffer (reserved for 85% threshold) ──────────────────
  const autocompactBuffer = Math.floor(contextWindow * 0.15);

  // ── Total used (excludes free space and autocompact buffer) ──────────
  const totalUsed = systemPromptTokens + toolsTokens + skillsTokens + messageTokens + memoryTokens;
  const percentage = Math.round((totalUsed / contextWindow) * 100);
  const freeSpace = Math.max(0, contextWindow - totalUsed - autocompactBuffer);

  const categories: ContextCategory[] = [
    {
      name: '系统提示',
      tokens: systemPromptTokens,
      percentage: Math.round((systemPromptTokens / contextWindow) * 100),
    },
    {
      name: '工具定义',
      tokens: toolsTokens,
      percentage: Math.round((toolsTokens / contextWindow) * 100),
    },
    {
      name: '技能元数据',
      tokens: skillsTokens,
      percentage: Math.round((skillsTokens / contextWindow) * 100),
    },
    {
      name: '消息历史',
      tokens: messageTokens,
      percentage: Math.round((messageTokens / contextWindow) * 100),
    },
    {
      name: '记忆文件',
      tokens: memoryTokens,
      percentage: Math.round((memoryTokens / contextWindow) * 100),
    },
    {
      name: '自动压缩缓冲',
      tokens: autocompactBuffer,
      percentage: Math.round((autocompactBuffer / contextWindow) * 100),
    },
    {
      name: '剩余空间',
      tokens: freeSpace,
      percentage: Math.round((freeSpace / contextWindow) * 100),
    },
  ];

  return {
    model: modelId,
    contextWindow,
    totalUsed,
    percentage: Math.min(percentage, 100),
    categories,
    systemPromptSections,
    tools,
    skills,
    messageBreakdown: {
      userMessages,
      assistantMessages,
      systemMessages,
      totalTokens: messageTokens,
    },
  };
}
