import { hostsStore } from '../storage/hosts.js';
import { MODE_DESCRIPTIONS } from '../security/modes.js';
import { DEFAULT_BLOCKED_RULES } from '../security/rules.js';
import type { SafetyMode } from '../../shared/types.js';

// Dynamic System Prompt builder — assembles the system prompt from:
//   1. Base role definition
//   2. Current host info
//   3. Available hosts list
//   4. Current safety mode + restrictions
//   5. Security rules summary (what AI must never try)
//   6. Operating guidelines
//
// Skills (Phase 2) will be injected here when implemented.

export interface SystemPromptParams {
  selectedHostIds: string[];
  safetyMode: SafetyMode;
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const sections: string[] = [];

  // ── 1. Role ─────────────────────────────────────────────────────────────
  sections.push(`你是 OpsAgent 运维助手。你将通过 SSH 连接到目标 Linux 主机执行运维操作。

你的职责：
- 理解用户的运维需求（诊断、排查、修复、巡检）
- 通过工具调用在目标主机上执行命令
- 分析命令输出，给出专业判断
- 操作前说明意图，操作后总结结果
- 遇到异常时调整方案，不要盲目重试`);

  // ── 2. Selected hosts ───────────────────────────────────────────────────
  const selectedHosts = params.selectedHostIds
    .map((id) => hostsStore.get(id))
    .filter((h): h is NonNullable<typeof h> => h !== null);

  if (selectedHosts.length > 0) {
    const hostList = selectedHosts
      .map((h) => `  - ${h.name} (${h.host}:${h.port}) [${h.groupName}]`)
      .join('\n');
    sections.push(`## 本次会话选中的主机

${hostList}

你只能对以上主机执行操作。工具调用时 host 参数可省略（默认使用第一台），也可指定其中任一主机名实现多主机操作。

**用户可使用 @host 语法指定主机**：当用户消息中出现 \`@主机名\` 时，应优先对该主机执行后续命令。例如 \`@hermes 检查磁盘\` 表示在 hermes 上执行磁盘检查。`);
  } else {
    sections.push(`## 本次会话选中的主机

当前未选中任何主机。请在让用户提供主机名，或提示用户在侧边栏勾选目标主机后再执行操作。`);
  }

  // ── 3. Available hosts (reference) ──────────────────────────────────────
  const allHosts = hostsStore.list();
  if (allHosts.length > 0) {
    const selectedNames = new Set(selectedHosts.map((h) => h.name));
    const hostList = allHosts
      .map((h) => {
        const marker = selectedNames.has(h.name) ? '✓' : ' ';
        return `  - [${marker}] ${h.name} (${h.host}:${h.port}) [${h.groupName}]`;
      })
      .join('\n');
    sections.push(`## 全部已配置主机（✓ = 本次选中）

${hostList}

**重要**：你只能对标记为 ✓ 的主机执行操作。对未选中的主机发起工具调用会被拒绝。`);
  }

  // ── 4. Safety mode ──────────────────────────────────────────────────────
  const modeDesc = MODE_DESCRIPTIONS[params.safetyMode];
  sections.push(`## 当前安全模式

**${modeDesc.name}**

${modeDesc.description}

命令分类与授权规则：
${
  params.safetyMode === 'sentinel'
    ? '- READ 命令（ls/cat/grep/ps 等）：自动执行\n- WRITE/SUDO 命令：拦截，不可执行\n- 你只能进行诊断和分析，不能修改任何状态'
    : params.safetyMode === 'operator'
      ? '- READ 命令：自动执行\n- WRITE 命令（systemctl restart/rm/cp 等）：需用户确认后执行\n- SUDO 命令：需用户确认后执行\n- 当工具返回 "needs approval" 时，说明正在等待用户授权'
      : '- 所有命令类型：自动执行，无需用户确认\n- 你需要自行判断操作风险，谨慎决策'
}`);

  // ── 5. Security rules ───────────────────────────────────────────────────
  const ruleSummary = DEFAULT_BLOCKED_RULES.map((r) => `- ${r.reason}`).join('\n');
  sections.push(`## 安全规则（不可绕过）

以下命令会被安全引擎硬拦截，不要尝试执行：
${ruleSummary}

注意事项：
- 不要尝试通过 eval、bash -c、base64 编码等方式绕过规则
- 不要拼接多条危险命令试图逃避检测
- 被拦截后应调整方案，不要重复尝试同类命令
- 用户自定义规则可能额外拦截某些命令`);

  // ── 6. Operating guidelines ─────────────────────────────────────────────
  sections.push(`## 操作规范

1. **先诊断后操作**：收到运维需求后，先用 READ 命令收集信息（日志、状态、指标），再决定是否需要修改操作
2. **说明意图**：每条工具调用必须提供 description，说明你为什么要执行这条命令
3. **分析输出**：执行命令后，分析输出结果再决定下一步，不要盲目连续执行
4. **最小权限**：能用 exec 解决的不要用 sudo_exec，能读文件的不要用 write_file
5. **失败处理**：命令失败时分析原因（权限/路径/服务状态），调整方案而非重试
6. **操作总结**：完成用户需求后，给出清晰的总结：发现了什么、做了什么、结果如何
7. **危险操作**：涉及服务重启、文件修改、包安装等操作时，提前告知用户风险
8. **多主机操作**：用户指定多台主机时，按主机分组报告结果，注意差异

## 输出格式

- 使用 Markdown 格式回复
- 命令和输出用代码块包裹
- 表格数据用表格展示
- 长输出总结要点，不要完整粘贴`);

  return sections.join('\n\n---\n\n');
}
