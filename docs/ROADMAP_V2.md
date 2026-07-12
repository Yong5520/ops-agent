# Ops-Agent v2.0 Roadmap

> 基于 OpsAgent 与 claude-code-best (CCB) 逆向工程的深度对比分析，针对 Agent Loop 韧性、任务规划、上下文工程、记忆系统等核心短板制定的迭代计划。
>
> **制定日期**: 2026-07-12
> **对标项目**: `C:\ProDate\ai-tools\ops-agent\claude-code` (CCB)
> **目标**: 让 Agent 在弱模型 (glm-5.2) 下也能稳定完成多步运维任务，无需用户反复 "继续排查"

---

## 目录

- [P0 - 必须完成（本次迭代核心）](#p0---必须完成本次迭代核心)
- [P1 - 推荐完成（高价值）](#p1---推荐完成高价值)
- [P2 - 中等价值](#p2---中等价值)
- [P3 - 可选增强](#p3---可选增强)
- [总览与排期](#总览与排期)

---

## P0 - 必须完成（本次迭代核心）

> 直接解决用户痛点：弱模型在多步运维任务中迷失、长会话上下文丢失、长任务被迫终止、运维知识无法沉淀。

### P0-1. TodoWrite + Plan Mode（任务规划）

#### 为什么需要

**痛点根因（数据已确认）**：
- OpsAgent 当前完全依赖模型自身能力分解任务，无任何结构化任务列表
- glm-5.2 在 20 轮工具调用后经常输出短过渡语 + `finishReason='stop'`，从不给实质结论
- 用户被迫反复手动输入 "继续排查"，单次会话曾达 20 分钟、41 次工具调用仍无结论
- 现有 `conclusion-nudge` 只是事后补救，不能预防任务迷失

**业务价值**：
- 运维任务天然多步骤（诊断 → 定位 → 修复 → 验证），需显式任务跟踪
- Plan Mode 强制只读诊断阶段，避免模型在未理解问题时就执行写操作
- 用户可看到、修改、回滚 agent 的计划，恢复对自动化的掌控感

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| TodoWriteTool | `packages/builtin-tools/src/tools/TodoWriteTool/` | 任务列表结构、状态机 |
| Task v2 工具集 | `packages/builtin-tools/src/tools/TaskCreateTool/` 等 5 个 | Create/Get/Update/List/Stop 完整 CRUD |
| EnterPlanModeTool | `packages/builtin-tools/src/tools/EnterPlanModeTool/` | 只读模式切换 |
| ExitPlanModeV2Tool | `packages/builtin-tools/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | 退出 + 用户审批流 |
| Plan 持久化 | `src/utils/plans.ts` (getPlan, getPlanFilePath) | 落盘机制 |
| 系统 Prompt 强制 | `src/constants/prompts.ts:269` | "Break down and manage your work with {taskToolName}" |
| VerifyPlanExecution | feature-gated | 计划执行验证 |

#### 如何实现

**阶段 A: TodoWrite 工具（最小可用）**
1. 新增 `src/main/agent/tools/todo-write.ts`，定义 TodoWrite 工具
   - 参数 schema (Zod): `todos: Array<{ id, subject, description, status: 'pending'|'in_progress'|'completed', activeForm? }>`
   - execute: 持久化到 DB 新表 `task_lists`（sessionId, todos JSON, updated_at）
   - 返回当前任务列表给模型
2. 新增 DB 表 `task_lists`（schema.ts 扩展）
3. 系统 Prompt 注入规则（system-prompt.ts）：
   - 复杂任务（≥3 步）必须先 TodoWrite
   - 开始任务前标记 in_progress，完成后立即标记 completed
   - 任务列表变化时实时同步
4. IPC + 渲染层：`src/renderer/components/TaskList.tsx` 显示任务列表，支持手动勾选/编辑

**阶段 B: Plan Mode（完整规划流程）**
1. 新增安全模式 `plan`（modes.ts 扩展），在 plan 模式下：
   - 所有 WRITE/SUDO 工具调用被拒绝（返回 `{ error: 'plan mode: read-only' }`）
   - READ 工具正常执行
   - TodoWrite 工具可用
2. 新增工具 `ExitPlanMode`：
   - 参数: `plan: string`（结构化计划文本）
   - execute: 将 plan 写入 `task_lists` 表，触发 UI 审批弹窗
   - 用户批准 → 切换到 operator/autopilot 模式，开始执行
   - 用户拒绝 → 继续 plan 模式，模型修订计划
3. 渲染层 `PlanApprovalDialog.tsx`：展示 plan，批准/拒绝/编辑
4. 会话级状态：`plan_mode` 字段持久化到 `sessions` 表

**阶段 C: 运维适配**
- TodoWrite 任务的 `subject` 字段适配运维场景：`{hostId, action, target}` 结构化
- Plan 模板预填：基于 skills（nginx-diagnosis 等）自动生成诊断步骤骨架
- 任务完成后自动触发审计日志记录

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 弱模型 (glm-5.2) 不主动调用 TodoWrite | 高 | 系统 Prompt 强制 + 首轮 tool_choice 强制注入 + loop 检测无任务列表时自动注入提醒 |
| Plan Mode 下模型仍尝试写操作 | 中 | 工具 execute 层硬拒绝（不依赖模型遵守 prompt） |
| 任务列表与实际执行不同步 | 中 | 每次 tool_call 后自动更新任务状态（loop.ts hook） |
| DB 迁移影响现有数据 | 低 | task_lists 是新表，无破坏性迁移 |
| 审批 UI 阻塞主流程 | 中 | Plan 审批异步，用户可推迟，agent 暂停在 plan 模式等待 |

#### 预估开发量

**4-5 人天**
- 阶段 A (TodoWrite 工具 + DB + Prompt): 1.5 天
- 阶段 B (Plan Mode + ExitPlanMode + 审批 UI): 2 天
- 阶段 C (运维适配 + 集成测试): 1 天
- 单测 + 联调: 0.5 天

---

### P0-2. 多层 Context Compaction（上下文工程）

#### 为什么需要

**痛点根因**：
- 当前 `compressContext()`（context.ts:123）在 60% 上下文窗口阈值时触发单一 summarize
- 保留首条 + 最后 20 条消息，中间所有运维诊断输出（命令、stdout、分析）被压缩为摘要
- 摘要仅在内存（`summaryCache`），应用重启即丢失
- 弱模型在丢失中间上下文后，无法回溯诊断链路，导致重复执行相同命令

**业务价值**：
- 运维长会话（事故排查、批量巡检）天然产生大量 stdout，需要精细化压缩
- 不同层级压缩保留不同信息粒度，确保关键诊断结论不丢失
- 落盘的 summary 支持会话恢复后快速重建上下文

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| Auto compaction | `src/services/compact/autoCompact.ts` | 预测性压缩，估算本 turn 增长 |
| Reactive compact | `query.ts:1372-1453` (reactiveCompact) | prompt-too-long 错误恢复 |
| Microcompact | `query.ts:600-624` | per-message tool result 替换 |
| Snip compact | `query.ts:589-598` (HISTORY_SNIP) | 移除旧 tool results 释放 token |
| Context collapse | `query.ts:638-645` (CONTEXT_COLLAPSE) | 分阶段压缩旧对话 |
| Compact boundary | `src/utils/messages.ts` (createCompactBoundaryMessage) | 压缩位置标记 |
| Summary 持久化 | `src/services/SessionMemory/sessionMemory.ts` | 落盘 + 恢复 |

#### 如何实现

**分层策略（优先实现前 3 层）**：

1. **Microcompact（per-message tool result 替换）**
   - 新增 `src/main/agent/compaction/microcompact.ts`
   - 对单个 tool result 消息：保留命令 + exitCode + 前 N 行 + 后 M 行 stdout，中间用 `... (省略 X 行) ...` 替代
   - 触发条件：单条 tool result 超过 `MAX_TOOL_RESULT_CHARS = 4000`
   - 持久化：替换后的消息写回 `messages` 表（新增 `compacted` 字段标记）
   - 缓存：利用模型响应的 `usage.cache_deleted_input_tokens` 判断是否生效

2. **Snip compact（移除旧 tool results）**
   - 新增 `src/main/agent/compaction/snip.ts`
   - 触发条件：上下文 token 估算超过 40% 窗口
   - 策略：从最早的消息开始，将 tool result content 替换为 `[snipped: {command}, exitCode={x}, {n} chars output]`
   - 保留命令本身（运维诊断需回溯命令链）

3. **Summary 落盘 + 恢复**
   - 扩展 `sessions` 表：新增 `summary TEXT`, `summary_coverage_index INTEGER`
   - `compressContext()` 生成 summary 后写入 DB
   - 应用重启 / 会话切换时：先加载 summary 作为首条 system 消息，再加载最近 N 条原始消息
   - 移除内存 `summaryCache`，改为 DB 读写

4. **Predictive compaction（可选，P0 后期）**
   - 在每轮 tool_call 结束后，估算下一轮可能增加的 token 数
   - 若预估超阈值，提前触发 snip + summary
   - 避免在 tool_call 中途触发压缩（会打断模型思路）

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Microcompact 破坏诊断链路完整性 | 高 | 保留命令 + exitCode + 首尾行，确保可回溯；对错误输出（exitCode!=0）不压缩 |
| Token 估算不准（当前 CHARS_PER_TOKEN=3） | 中 | 引入 tiktoken 或使用模型 API 返回的 usage 字段校准 |
| Summary 质量不稳定（弱模型） | 中 | Summary 使用固定结构化模板（命令/发现/错误/决策/状态），限制 maxTokens=2000；失败时 fallback 到 snip |
| DB 迁移（sessions 表加列） | 低 | ALTER TABLE ADD COLUMN，向后兼容 |
| Predictive compaction 误判 | 中 | 仅在 P0 后期引入，先观察前 3 层效果 |

#### 预估开发量

**4-5 人天**
- Microcompact: 1.5 天
- Snip compact: 1 天
- Summary 落盘 + 恢复: 1.5 天
- 集成到 loop.ts + 测试: 1 天

---

### P0-3. Agent Loop 韧性增强（max_output_tokens 恢复 + token budget）

#### 为什么需要

**痛点根因**：
- 当前 loop.ts 在 `finishReason='length'`（命中 maxTokens）时仅追加警告文本，不恢复
- 运维诊断输出天然冗长（dmesg、journalctl、nginx error log），8192 tokens 常不够
- `finishReason='tool-calls'`（命中 maxSteps=20）时也仅警告，任务被迫终止
- 无 fallback 模型，单一 API 故障即全停

**业务价值**：
- 运维长任务（深度诊断、批量巡检）不因 token 限制中断
- token budget 机制让模型在预算允许时主动继续，而非被动等待用户 "继续"

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| max_output_tokens 升档 | `query.ts:1475-1539` | 8k → 64k 二级升档 |
| 多轮恢复 | `query.ts:1511-1516` | 注入 "Resume directly..." 消息，最多 3 轮 |
| Token budget continuation | `src/query/tokenBudget.ts` + `query.ts:1598-1645` | 预算允许时注入 nudge 继续循环 |
| max_turns 处理 | `query.ts:2032-2040` | 超限 yield attachment + 返回 reason |
| Fallback 模型 | `query.ts:1152` (FallbackTriggeredError) | 切换备用模型 + tombstone 清理 |
| Stop reason 完整处理 | `query.ts:1349-1648` | 10+ 种终止原因精细化处理 |

#### 如何实现

**1. max_output_tokens 二级恢复**
- 修改 `loop.ts`：
  - 首次 `finishReason='length'`：将 `maxTokens` 从 8192 升档到 32768，重试本轮
  - 第二次仍 `length`：注入 user 消息 "输出被截断，请从上次中断处直接继续，不要重复已输出内容"，maxTokens 保持 32768，继续循环
  - 上限 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` 轮
  - 升档状态记录在 loop 的 state 对象，避免重复升档

**2. maxSteps 提升 + 动态调整**
- 默认 maxSteps 从 20 提升到 30（运维任务通常更深）
- Plan Mode 下 maxSteps 提升到 50（规划阶段工具调用更多）
- 在 settings 中暴露 `maxSteps` 配置项（app_settings 表）

**3. Token budget continuation**
- 新增 `src/main/agent/token-budget.ts`：
  - `createBudgetTracker(totalTokens, contextWindow)` 跟踪已用 token
  - `checkTokenBudget()` 返回 `{ canContinue, remainingTokens }`
- loop.ts 在 `finishReason='stop'` 且有工具调用时：
  - 若剩余预算 > 20% 上下文窗口，注入 nudge 消息继续
  - 若剩余预算 < 20%，先触发 snip compact 再继续
  - 整合现有 conclusion-nudge 逻辑（复用 MAX_NUDGE_ROUNDS=2）

**4. Fallback 模型（P0 可选，若有多模型配置）**
- `model_providers` 表新增 `is_fallback` 字段
- loop.ts 捕获模型 API 错误（非 token 类）时：
  - 标记当前模型故障
  - 加载 fallback 模型配置
  - 清理当前轮 assistant 消息
  - 用 fallback 模型重试本轮
  - 上限 1 次 fallback（避免无限重试）

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 升档到 32k 增加成本 | 中 | 仅在首次 length 时触发，非默认；settings 可配 |
| 多轮恢复导致重复输出 | 高 | nudge 消息明确 "不要重复已输出内容" + 检查已输出文本去重 |
| maxSteps 提升导致 SSH 调用过多 | 中 | 配合 P0-1 TodoWrite 限制，任务完成即停；硬上限 50 |
| Token budget 估算不准 | 中 | 使用 API 返回的 usage 精确值，不依赖估算 |
| Fallback 模型能力差异大 | 中 | 仅在主模型完全不可用时触发；记录 fallback 使用审计 |

#### 预估开发量

**3-4 人天**
- max_output_tokens 二级恢复: 1 天
- maxSteps 提升 + 动态调整: 0.5 天
- Token budget continuation（整合现有 nudge）: 1 天
- Fallback 模型（可选）: 1 天
- 测试: 0.5 天

---

### P0-4. Memory 基础设施（运维知识库铺路）

#### 为什么需要

**痛点根因**：
- OpsAgent 无任何跨会话记忆：每次会话从零开始，不记住用户偏好、主机特性、历史诊断结论
- 用户明确说 "后续会增加运维 skills、运维知识库参考等功能"
- 当前 skills（builtin.ts）是硬编码的 promptFragment，无法动态扩展
- 无 @include 指令，无法引用外部运维手册片段

**业务价值**：
- 运维知识库（CLAUDE.md + @include）沉淀团队运维经验
- Auto-memory 记录主机特性（如 "host-A 的 nginx 日志在 /var/log/nginx/，非默认路径"）
- 历史 diagnostic 记忆让 agent 避免重复诊断

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| CLAUDE.md 层级 | `src/utils/claudemd.ts:789` (getMemoryFiles) | Managed/User/Project/Local/AutoMem 层级 |
| Auto-memory | `src/memdir/memdir.ts` | MEMORY.md 入口，200 行/25KB 限制 |
| @include 指令 | `src/utils/claudemd.ts:450-534` | `@path` `@./relative` 递归加载，深度 5 |
| Frontmatter glob | `src/utils/claudemd.ts:253-278` | 文件可声明 `paths` 限制应用范围 |
| HTML 注释清理 | `src/utils/claudemd.ts:291-333` | block-level `<!-- -->` 移除 |
| 相关记忆预取 | `src/memdir/findRelevantMemories.ts` | 会话开始预取相关文件 |
| Memory 注入 | `src/context.ts:155` (getUserContext) | 注入到系统 prompt |

#### 如何实现

**分层策略（优先实现前 3 层）**：

1. **Project CLAUDE.md 加载**
   - 新增 `src/main/agent/memory/claudemd.ts`
   - 扫描项目根目录 `CLAUDE.md` + `.claude/rules/*.md`（支持 glob）
   - 内容注入到系统 prompt 的 "运维规范" section
   - 优先级：项目 CLAUDE.md > skills promptFragment

2. **Auto-memory（MEMORY.md）**
   - 新增 `src/main/agent/memory/automem.ts`
   - 路径：`%APPDATA%/ops-agent/memory/MEMORY.md`
   - 系统 prompt 注入 auto-memory 内容（截断 200 行 / 25KB）
   - 新增工具 `update_memory`：agent 可主动写入记忆
     - 参数: `content: string`, `section?: string`
     - execute: 追加到 MEMORY.md（带时间戳）
   - 渲染层 Settings 新增 "记忆管理" 页面：查看/编辑 MEMORY.md

3. **@include 指令**
   - 在 CLAUDE.md 加载时解析 `@path` `@./relative` `~/home` `/absolute`
   - 递归加载，深度上限 5，循环引用检测（processedPaths Set）
   - 运维适配：`@/opt/opsagent/runbooks/nginx-troubleshooting.md` 引用外部运维手册

4. **Frontmatter glob 过滤（P0 后期）**
   - 解析 memory 文件 frontmatter 的 `paths: ["host-*", "nginx-*"]`
   - 根据当前会话选中的主机名匹配，仅注入相关规则
   - 运维适配：按主机组/角色过滤知识库

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Memory 文件过大撑爆 prompt | 高 | 硬限制 200 行/25KB，超限截断 + 警告 |
| @include 循环引用 | 中 | processedPaths Set 检测，深度上限 5 |
| 弱模型不主动 update_memory | 中 | 系统 Prompt 指导 + 用户手动编辑入口 |
| 敏感信息泄露到 prompt | 中 | Memory 文件本地存储，不发送到外部；提醒用户不要存敏感信息 |
| 多主机场景记忆混淆 | 中 | Frontmatter glob 过滤（P0 后期）+ 按主机分目录存储 |

#### 预估开发量

**4-5 人天**
- Project CLAUDE.md 加载 + 注入: 1 天
- Auto-memory (MEMORY.md) + update_memory 工具: 1.5 天
- @include 指令解析: 1 天
- Frontmatter glob（可选）: 0.5 天
- UI 管理 + 测试: 1 天

---

## P1 - 推荐完成（高价值）

> 提升性能、降低成本、增强安全控制。可在 P0 完成后并行推进。

### P1-1. 并发工具执行 + 大结果落盘

#### 为什么需要

- 多主机批量巡检场景下，当前串行执行 SSH 命令，10 台主机 × 5 命令 = 50 次串行 SSH，耗时数分钟
- 大日志文件（journalctl 输出 50k+ 行）直接塞入 prompt，浪费 token 且模型难以处理
- 当前 audit log 截断 2000 字符，丢失关键诊断信息

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| 工具并发分区 | `src/services/tools/toolOrchestration.ts:20` (partitionToolCalls) | 并发安全 vs 串行分区 |
| 并发执行 | `src/services/tools/toolOrchestration.ts:49` (runToolsConcurrently) | 默认并发 10 |
| 大结果落盘 | `src/Tool.ts:476` (maxResultSizeChars) | 超限落盘 + 返回 preview + path |
| 工具并发安全标记 | `src/Tool.ts:412` (isConcurrencySafe) | 只读工具可并发 |

#### 如何实现

1. **工具并发安全标记**
   - 在 tools.ts 每个 tool 定义新增 `isConcurrencySafe(input)` 方法
   - `read_file`、`list_hosts`、`exec`（READ 类命令）→ true
   - `write_file`、`rollback`、`exec`（WRITE/SUDO 类）→ false
   - 依赖 classifier 的 READ/WRITE/SUDO 分类结果

2. **并发分区执行**
   - 新增 `src/main/agent/tool-orchestration.ts`
   - `partitionToolCalls(toolCalls)`: 按并发安全性分批
   - 并发安全批次：`Promise.allSettled` 并行，上限 `MAX_CONCURRENCY = 5`（运维场景低于 CCB 的 10，避免 SSH 连接池压力）
   - 串行批次：依次执行
   - 修改 loop.ts：将工具执行从 AI SDK 内部接管，手动调度并发

3. **大结果落盘**
   - 新增 `MAX_TOOL_RESULT_CHARS = 8000` 常量
   - tool execute 返回结果超过阈值时：
     - 写入 `%APPDATA%/ops-agent/tool-results/{sessionId}/{toolCallId}.txt`
     - 返回给模型：`{ preview: 前2000字符, fullResultPath: "C:\\...", totalChars: N }`
     - 新增工具 `read_tool_result`：按 path 读取完整结果

4. **连接池优化**
   - `connectionPool` 扩展：支持单主机多并发连接（当前每主机单连接）
   - 配合并发执行，避免连接复用冲突

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| SSH 连接池压力 | 高 | 单主机并发上限 3，总并发上限 5；连接池扩容 |
| 并发执行破坏运维操作顺序 | 中 | WRITE/SUDO 强制串行；仅 READ 类并发 |
| 落盘文件堆积 | 中 | 会话结束时清理；定期 GC 7 天前文件 |
| 模型不调用 read_tool_result | 中 | Prompt 指导 + 大结果时主动提示 "完整结果已保存，可用 read_tool_result 查看" |
| AI SDK 内部工具调度接管复杂 | 高 | 需要深入研究 AI SDK 的 tool execute 生命周期，可能需要 fork 自定义实现 |

#### 预估开发量

**3-4 人天**
- 工具并发安全标记 + 分区: 1 天
- 并发执行调度（接管 AI SDK 工具执行）: 1.5 天
- 大结果落盘 + read_tool_result 工具: 0.5 天
- 连接池优化 + 测试: 1 天

---

### P1-2. 静态/动态 Prompt 边界分离（Prompt Cache 优化）

#### 为什么需要

- 当前 system-prompt.ts 每次重新拼接全部 7 段（含 host facts、skills），prompt cache 命中率低
- Host facts（主机运行时信息）5 分钟缓存，但每次 facts 变化导致整个 prompt 失效
- API 成本和延迟受 prompt cache 命中率直接影响
- CCB 通过 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记静态/动态边界，让 cache 跨请求复用

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| 动态边界标记 | `src/constants/prompts.ts:113` (SYSTEM_PROMPT_DYNAMIC_BOUNDARY) | 静态/动态分离 |
| Prompt 拆分 | `src/utils/api.ts` (splitSysPromptPrefix) | 按 boundary 拆分 |
| Cache 友好排序 | `src/tools.ts:378` (assembleToolPool) | 内置工具按名排序作为 cache 前缀 |

#### 如何实现

1. **Prompt 分段重构**
   - 静态段（跨请求稳定）：persona + 规则 + 工具描述 + skills promptFragment
   - 动态段（每请求变化）：selected hosts + host facts + all hosts list
   - system-prompt.ts 输出 `{ staticPrefix, dynamicSuffix }` 而非单一字符串

2. **Prompt cache 配置**
   - 使用 AI SDK 的 `providerOptions` 或直接 Anthropic API 的 `cache_control: { type: 'ephemeral' }`
   - 静态段标记为 cacheable
   - 动态段不标记

3. **Host facts 缓存优化**
   - 当前 5 分钟 TTL 缓存导致频繁失效
   - 改为：facts 内容变化时才失效（对比 hash），而非时间过期
   - 或：facts 拆分为 "稳定信息"（OS/kernel/CPU）+ "动态信息"（disk/mem/dmesg），仅动态部分每次更新

4. **工具描述排序**
   - 工具定义按名称字母序排序，确保 cache 前缀稳定

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Prompt cache 命中率无感知 | 中 | 新增 metrics：cache_read_tokens / cache_creation_tokens，记录到 audit_logs |
| 静态段实际不稳定的边界 | 中 | Host facts 中的 OS/kernel 放静态段（极少变），disk/mem/dmesg 放动态段 |
| AI SDK cache_control 支持 | 低 | Vercel AI SDK 4.x 支持 Anthropic providerOptions |
| 收益量化困难 | 中 | A/B 测试：对比 cache 命中前后的 API 成本和延迟 |

#### 预估开发量

**2-3 人天**
- Prompt 分段重构: 1 天
- cache_control 配置 + 测试: 1 天
- Host facts 缓存优化: 0.5 天
- Metrics 记录 + 验证: 0.5 天

---

### P1-3. PreToolUse / PostToolUse Hooks

#### 为什么需要

- 当前 `custom_rules` 仅支持正则 pattern 匹配，无法执行复杂安全逻辑
- 运维场景需要：命令执行前检查是否已备份、执行后自动触发监控告警、危险命令二次确认
- Hooks 让用户注入自定义逻辑（shell / LLM prompt / HTTP webhook），无需改源码
- CCB 的 hooks 系统支持 20+ 事件、4 种 hook 类型，成熟可借鉴

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| Hooks 引擎 | `src/utils/hooks.ts` (200+ 行) | 执行框架 |
| Hook 类型 | `src/schemas/hooks.ts` | command/prompt/http/agent 4 种 |
| Hook 事件 | `src/entrypoints/agentSdkTypes.js` | 20+ 事件类型 |
| Hook 输出 | `src/types/hooks.ts` (HookJSONOutput) | permissionDecision/modifiedToolInput/blockMessage |
| If 条件 | `src/schemas/hooks.ts:19` | `Bash(git *)` 权限规则过滤 |
| 配置来源 | settings.json / session / frontmatter | 多来源合并 |

#### 如何实现

**优先实现 PreToolUse + PostToolUse（运维最常用）**：

1. **Hook 配置存储**
   - 新增 DB 表 `hooks`：id, name, event, type, config(JSON), condition, enabled, created_at
   - 渲染层 Settings 新增 "Hooks 管理" 页面

2. **Hook 类型（先实现 command + http）**
   - `command`: 执行 shell 命令，stdin 传入 hook input JSON，stdout 解析为 hook output
   - `http`: POST 到 webhook URL，body 为 hook input，response body 为 hook output
   - `prompt` / `agent` 类型延后到 P2

3. **Hook 执行引擎**
   - 新增 `src/main/agent/hooks/engine.ts`
   - `executePreToolUseHooks(toolName, input)`: 遍历匹配的 hooks，串行执行
   - Hook output 处理：
     - `permissionDecision: 'deny'` → 阻止工具执行，返回 blockMessage 给模型
     - `permissionDecision: 'allow'` → 跳过正常 authorization 流程
     - `modifiedToolInput` → 替换工具输入
     - `additionalContext` → 注入到工具结果
   - 超时：30s（运维 hook 可能涉及外部系统查询）

4. **If 条件匹配**
   - 实现 `exec(*)`、`write_file(*)`、`sudo_exec(*)` 等工具名 + 参数 pattern 匹配
   - 示例：`exec(rm *)` 仅对 exec 工具中 rm 开头的命令触发 hook

5. **运维场景示例 hooks**
   - PreToolUse `exec(*)`: 调用 CMDB API 检查主机是否生产环境，生产环境额外确认
   - PostToolUse `write_file(*)`: 自动触发配置备份到 Git
   - PreToolUse `sudo_exec(*)`: 检查 sudo 命令是否符合公司运维规范（HTTP webhook 到合规系统）

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Hook 执行阻塞主流程 | 高 | 30s 超时 + 异步选项（不等待结果） |
| Hook 滥用导致安全漏洞 | 中 | Hook 配置需用户明确启用；command hook 在沙箱执行 |
| Hook 输出格式错误 | 中 | 严格 schema 校验，解析失败则忽略 hook |
| 与现有 custom_rules 冲突 | 中 | Hooks 在 custom_rules 之后执行，hooks 可覆盖 rules 决策 |
| 调试困难 | 中 | Hook 执行日志写入 audit_logs，含 input/output/耗时 |

#### 预估开发量

**3-4 人天**
- Hook 配置存储 + UI: 1 天
- Hook 执行引擎（command + http）: 1.5 天
- If 条件匹配 + 集成到 preExec: 0.5 天
- 测试 + 示例 hooks: 1 天

---

### P1-4. AskUserQuestion + Plan Approval（HITL 增强）

#### 为什么需要

- 当前模型无法主动向用户提问，遇到模糊需求只能猜测或终止
- 危险操作前无主动确认机制（仅被动等待 authorization）
- Plan Mode（P0-1）产出计划后，需用户审批才能执行
- CCB 的 AskUserQuestion + ExitPlanMode 审批流是成熟方案

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| AskUserQuestionTool | `packages/builtin-tools/src/tools/AskUserQuestionTool/` | 模型主动提问 |
| ExitPlanModeV2Tool | `packages/builtin-tools/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | 计划审批流 |
| 系统 Prompt 指导 | `src/constants/prompts.ts:337` | "If you do not understand why the user has denied a tool call, use AskUserQuestion" |
| Denial tracking | `src/utils/permissions/denialTracking.ts` | 连续拒绝回退到 prompt |

#### 如何实现

1. **AskUserQuestion 工具**
   - 新增 `src/main/agent/tools/ask-user.ts`
   - 参数 (Zod): `questions: Array<{ question, header, options: Array<{ label, description, preview? }>, multiSelect }>`
   - execute: 通过 IPC 发送到渲染层，显示为模态对话框
   - 用户回答后返回 `{ answers, annotations }` 给模型
   - 渲染层 `AskUserDialog.tsx`：支持单选/多选/自由文本（"Other"）

2. **Plan Approval 流程（配合 P0-1）**
   - ExitPlanMode 工具触发审批弹窗
   - `PlanApprovalDialog.tsx`：展示 plan 文本，支持：
     - 批准：切换到 operator/autopilot 模式，开始执行
     - 拒绝：继续 plan 模式，模型修订
     - 编辑：用户直接修改 plan 文本后批准
   - 审批结果通过 IPC 回传

3. **Denial tracking**
   - 新增 `src/main/agent/denial-tracking.ts`
   - 跟踪连续 authorization 拒绝次数
   - 超过 `DENIAL_LIMITS = 3` 次后，注入 AskUserQuestion 提示模型主动询问用户

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 模型过度使用 AskUserQuestion 打扰用户 | 中 | 系统 Prompt 指导 + 每会话上限 5 次 |
| 审批弹窗阻塞 agent loop | 中 | 异步等待，用户可推迟；超时默认拒绝 |
| 弱模型不主动调用 AskUserQuestion | 中 | Denial tracking 触发提示 |
| UI 复杂度增加 | 低 | 复用现有 AuthDialog 组件样式 |

#### 预估开发量

**2-3 人天**
- AskUserQuestion 工具 + 对话框: 1 天
- Plan Approval 流程（配合 P0-1）: 0.5 天
- Denial tracking: 0.5 天
- 测试: 0.5 天

---

## P2 - 中等价值

> 扩展性能力，可在 P1 完成后视资源情况推进。

### P2-1. Multi-Agent 子 Agent 派发

#### 为什么需要

- 多主机运维（批量巡检、并行诊断）场景下，主 agent context 急剧膨胀
- 单 agent 串行处理多主机，效率低且容易混淆
- 子 agent 可派发到单主机，结果汇总到主 agent，保护主 context

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| AgentTool | `packages/builtin-tools/src/tools/AgentTool/` | 子 agent 派发 |
| 内置 agents | `packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts` | general-purpose/Explore/Plan |
| Fork subagent | `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` | 后台 fork |
| Agent 定义 | `packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts` | `.claude/agents/*.md` frontmatter |
| Agent 执行 | `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` | 递归调用 query() |
| Coordinator mode | `src/coordinator/workerAgent.ts` | coordinator + worker 模式 |

#### 如何实现

1. **内置运维 agents**
   - 新增 `src/main/agent/subagents/` 目录
   - `inspection-agent.ts`: 单主机巡检子 agent（只读工具集）
   - `diagnosis-agent.ts`: 单主机深度诊断子 agent（READ + 受限 WRITE）
   - `summary-agent.ts`: 多主机结果汇总子 agent

2. **Agent 工具**
   - 新增 `src/main/agent/tools/agent.ts` (AgentTool)
   - 参数: `subagent_type, prompt, hostId?, run_in_background?`
   - execute: 递归调用 `runAgentLoop`（loop.ts 抽象为可递归调用）
   - 子 agent 有独立 context、独立 maxSteps、独立工具集
   - 结果返回给主 agent 作为 tool result

3. **并行派发**
   - 主 agent 调用多个 Agent 工具（并发安全标记为 true）
   - 配合 P1-1 并发执行：多主机并行巡检
   - 子 agent 结果自动汇总（summary-agent）

4. **自定义 agent 定义**
   - 支持 `.claude/agents/*.md` frontmatter 定义
   - 字段: agentType, whenToUse, tools, disallowedTools, model, promptFragment
   - 运维适配：用户自定义 "nginx-expert"、"mysql-expert" 等

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| 子 agent context 嵌套过深 | 高 | 深度上限 2 层；子 agent 不能派发子 agent |
| 递归调用 loop.ts 复杂 | 高 | 需重构 loop.ts 为可重入；隔离 AbortController |
| 子 agent 结果质量不稳定 | 中 | 子 agent 完成后主 agent 审核；失败时主 agent 重试 |
| 资源消耗大（多倍 API 调用） | 中 | 仅在多主机场景触发；默认串行，用户主动启用并行 |
| 弱模型不主动使用 Agent 工具 | 中 | 系统 Prompt 指导 + 多主机场景自动建议 |

#### 预估开发量

**5-7 人天**
- loop.ts 重构为可递归: 2 天
- 内置运维 agents + AgentTool: 2 天
- 并行派发 + 结果汇总: 1.5 天
- 自定义 agent 定义 + 测试: 1.5 天

---

### P2-2. MCP 支持

#### 为什么需要

- 运维需对接外部系统：Prometheus 监控、Jira 工单、CMDB、Kubernetes API
- 当前所有操作通过 SSH，无法查询监控数据、工单状态
- MCP 让 agent 通过标准化协议访问外部系统，无需改源码

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| MCP client 包 | `packages/mcp-client/` | 完整实现 |
| Transport | `packages/mcp-client/src/types.ts:30` | 7 种 transport |
| McpManager | `packages/mcp-client/src/manager.ts` | 连接管理 |
| Tool discovery | `packages/mcp-client/src/discovery.ts` | 工具发现 + LRU cache |
| Tool merge | `src/tools.ts:378` (assembleToolPool) | 内置 + MCP 合并 |
| Agent-specific MCP | `packages/builtin-tools/src/tools/AgentTool/runAgent.ts:104` | 子 agent 独立 MCP |

#### 如何实现

1. **MCP client 集成**
   - 引入 `@modelcontextprotocol/sdk` 或参考 CCB 实现
   - 优先支持 stdio + http transport（运维场景最常用）
   - 新增 `src/main/agent/mcp/manager.ts`: 连接管理、工具发现、工具调用

2. **配置存储**
   - 新增 DB 表 `mcp_servers`: id, name, transport, config(JSON), enabled, created_at
   - 渲染层 Settings 新增 "MCP 服务器" 页面

3. **工具合并**
   - `createTools()` 扩展：内置工具 + MCP 工具合并
   - MCP 工具名加前缀 `mcp__{serverName}__{toolName}` 避免冲突
   - 系统 prompt 注入 MCP 服务器说明

4. **运维场景 MCP 服务器**
   - Prometheus MCP: 查询监控指标
   - Jira MCP: 查询/创建工单
   - CMDB MCP: 查询主机元数据
   - 可后续独立开发，MCP 框架先行

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| MCP 服务器质量参差 | 中 | 连接超时 30s + 请求超时 60s + 错误重连 |
| 工具数量爆炸撑爆 prompt | 中 | 延迟加载（配合 P3-1 SearchExtraTools）|
| 安全风险（外部 MCP 服务器） | 高 | 用户明确启用 + 沙箱执行 + 审计日志 |
| Transport 实现复杂 | 中 | 优先 stdio + http，其他延后 |
| 与现有工具冲突 | 低 | 前缀命名 + 优先级（内置 > MCP） |

#### 预估开发量

**4-6 人天**
- MCP client 集成 (stdio + http): 2 天
- 配置存储 + UI: 1 天
- 工具合并 + 系统 prompt 注入: 1 天
- 测试 + 1 个示例 MCP 服务器: 1.5 天

---

### P2-3. Session Resume + Branch

#### 为什么需要

- 事故复盘场景需从历史会话恢复完整上下文
- 当前会话切换时 summary 重建，丢失细节
- Branching 支持从某消息分叉探索不同方案

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| Session 存储 | `src/utils/sessionStorage.ts` | JSONL transcript |
| Session resume | `src/utils/sessionRestore.ts` | 恢复机制 |
| Branch | `src/commands/branch/branch.ts` | 对话分支 |
| Compact boundary | `src/utils/messages.ts` | 压缩位置标记 |
| Session activity | `src/utils/sessionActivity.ts` | 活动追踪 |

#### 如何实现

1. **Session resume 增强**
   - 配合 P0-2 summary 落盘：恢复时加载 summary + 最近 N 条消息
   - 新增 "恢复会话" 入口，展示历史会话列表
   - 恢复后自动重载 host facts、skills 配置

2. **Session branching**
   - 新增 `branch_session` IPC：从指定 message_id 创建分支
   - 原会话保留，新会话复制 message_id 之前的消息
   - 渲染层：消息右键 "从此处分叉"
   - 会话树视图（可选）

3. **Session export 增强**
   - 导出为 Markdown + 附加 metadata（hostIds, safetyMode, toolCalls 统计）
   - 支持导出为 JSON（可重新导入）

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Resume 后上下文不完整 | 中 | Summary + 最近消息 + host facts 三重保障 |
| Branch 导致会话数量膨胀 | 低 | 用户可归档/删除 |
| DB 查询性能（消息多） | 低 | 现有 sessions + messages 表有索引 |
| UI 复杂度 | 中 | 简化为列表 + 右键菜单 |

#### 预估开发量

**3-4 人天**
- Session resume 增强: 1 天
- Branching + UI: 1.5 天
- Export 增强 + 测试: 1 天

---

### P2-4. Fallback 模型切换

#### 为什么需要

- 单一模型 API 故障即全停，无降级路径
- glm-5.2 不可用时应有备用模型（如 GPT-4o / Claude）
- CCB 的 FallbackTriggeredError 机制成熟

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| Fallback 触发 | `query.ts:1152` (FallbackTriggeredError) | 错误检测 + 切换 |
| Tombstone 清理 | query.ts 附近 | 孤儿消息标记 |
| 模型配置 | `src/utils/api.ts` | 多模型管理 |

#### 如何实现

1. **模型配置扩展**
   - `model_providers` 表新增 `is_fallback` 字段
   - 设置页支持配置 "主模型" + "备用模型"

2. **Fallback 逻辑**
   - loop.ts 捕获模型 API 错误（401/429/500/502/503/ECONNRESET）
   - 标记当前模型故障（CircuitBreaker 已有，配合 P0-3）
   - 加载 fallback 模型配置
   - 清理当前轮 assistant 消息（避免半截输出）
   - 用 fallback 模型重试本轮
   - 上限 1 次 fallback

3. **自动恢复**
   - 故障模型 5 分钟后自动尝试恢复（配合 CircuitBreaker half-open 状态）
   - 恢复后切换回主模型

#### 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Fallback 模型能力差异大 | 中 | 仅在主模型完全不可用时触发；记录审计 |
| Fallback 模型成本高 | 中 | 用户配置时明确提示 |
| 上下文不兼容（不同模型 token 限制） | 中 | 触发 fallback 时先检查上下文大小，必要时压缩 |
| 半截输出处理 | 低 | 清理当前轮 assistant 消息 |

#### 预估开发量

**2-3 人天**
- 模型配置扩展 + UI: 0.5 天
- Fallback 逻辑 + 集成到 loop.ts: 1.5 天
- 测试: 0.5 天

---

## P3 - 可选增强

> 锦上添花，资源充裕时推进。

### P3-1. 延迟工具加载（SearchExtraTools + ExecuteTool）

#### 为什么需要

- 后续运维 skills 数量增加时，工具描述膨胀 prompt
- TF-IDF 搜索发现工具，按需加载，节省 token

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| SearchExtraToolsTool | `packages/builtin-tools/src/tools/SearchExtraToolsTool/` | TF-IDF 搜索 |
| ExecuteTool | `packages/builtin-tools/src/tools/ExecuteTool/` | 延迟调用 |
| 工具标记 | `src/Tool.ts:452` (shouldDefer) | 延迟标记 |

#### 如何实现

- 工具定义新增 `shouldDefer` 标记
- 首次只加载核心工具（exec/read_file/write_file/TodoWrite）
- 模型调用 SearchExtraTools 搜索匹配工具
- 找到后通过 ExecuteTool 调用
- 工具描述索引：TF-IDF 向量化，余弦相似度匹配

#### 风险

- 弱模型不主动搜索工具 → 系统 Prompt 指导
- 搜索结果不准 → 持续优化 TF-IDF

#### 预估开发量

**2-3 人天**

---

### P3-2. 流式工具执行（StreamingToolExecutor）

#### 为什么需要

- 当前工具执行等待流结束才开始，延迟高
- 边流边执行可减少总耗时（特别是长输出命令）

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| StreamingToolExecutor | `src/services/tools/StreamingToolExecutor.ts` | 边流边执行 |
| 流式集成 | `query.ts:1095-1120` | 流中触发 |

#### 如何实现

- 监听 `tool-call` 事件，工具 block 到达即开始执行
- 结果队列按完成顺序 yield
- 需要重构 AI SDK 工具执行生命周期

#### 风险

- 实现复杂度高，需深入 AI SDK 内部
- 收益取决于模型输出 tool_call 的速度

#### 预估开发量

**3-4 人天**

---

### P3-3. 后台会话（Background Sessions）

#### 为什么需要

- 长时间巡检任务可放到后台，用户继续其他工作
- 类似 `claude ps` 查看后台任务

#### 参考 claude-code 哪部分

| CCB 模块 | 文件路径 | 借鉴点 |
|---------|---------|--------|
| BG_SESSIONS feature | `src/utils/taskSummary.ts` | 后台会话 |
| Task monitoring | `packages/builtin-tools/src/tools/MonitorTool/` | 任务监控 |

#### 如何实现

- 会话状态新增 `background` 标记
- 后台会话不阻塞 UI
- 定期生成 task summary
- 后台会话列表查看

#### 风险

- 资源消耗（多会话并行）
- UI 复杂度

#### 预估开发量

**2-3 人天**

---

## 总览与排期

### 工作量汇总

| 优先级 | 功能 | 预估人天 |
|--------|------|---------|
| **P0** | P0-1 TodoWrite + Plan Mode | 4-5 |
| **P0** | P0-2 多层 Compaction | 4-5 |
| **P0** | P0-3 Agent Loop 韧性增强 | 3-4 |
| **P0** | P0-4 Memory 基础设施 | 4-5 |
| | **P0 小计** | **15-19 人天** |
| **P1** | P1-1 并发工具执行 + 大结果落盘 | 3-4 |
| **P1** | P1-2 静态/动态 Prompt 边界分离 | 2-3 |
| **P1** | P1-3 PreToolUse / PostToolUse Hooks | 3-4 |
| **P1** | P1-4 AskUserQuestion + Plan Approval | 2-3 |
| | **P1 小计** | **10-14 人天** |
| **P2** | P2-1 Multi-Agent 子 Agent 派发 | 5-7 |
| **P2** | P2-2 MCP 支持 | 4-6 |
| **P2** | P2-3 Session Resume + Branch | 3-4 |
| **P2** | P2-4 Fallback 模型切换 | 2-3 |
| | **P2 小计** | **14-20 人天** |
| **P3** | P3-1 延迟工具加载 | 2-3 |
| **P3** | P3-2 流式工具执行 | 3-4 |
| **P3** | P3-3 后台会话 | 2-3 |
| | **P3 小计** | **7-10 人天** |
| | **总计** | **46-63 人天** |

### 推荐排期

```
Sprint 1 (P0, 3-4 周)
├── Week 1: P0-1 TodoWrite + Plan Mode (阶段 A+B)
├── Week 2: P0-2 多层 Compaction + P0-3 Agent Loop 韧性
├── Week 3: P0-4 Memory 基础设施 + P0-1 阶段 C 运维适配
└── Week 4: 集成测试 + Bug 修复 + 文档更新

Sprint 2 (P1, 2-3 周)
├── Week 5: P1-1 并发工具执行 + P1-2 Prompt 边界分离
├── Week 6: P1-3 Hooks + P1-4 AskUserQuestion
└── Week 7: 集成测试 + 性能验证

Sprint 3 (P2, 3-4 周, 视资源)
├── Week 8-9: P2-1 Multi-Agent
├── Week 10: P2-2 MCP 支持
└── Week 11: P2-3 Session Resume + P2-4 Fallback

Sprint 4 (P3, 2 周, 可选)
└── Week 12-13: P3 按需推进
```

### 依赖关系

```
P0-1 (TodoWrite + Plan Mode) ──┐
                                ├──> P1-4 (Plan Approval)
P0-2 (多层 Compaction) ────────┤
                                ├──> P2-1 (Multi-Agent, 需 loop 可重入)
P0-3 (Agent Loop 韧性) ────────┤
                                ├──> P2-3 (Session Resume, 需 summary 落盘)
P0-4 (Memory 基础设施) ────────┘

P1-1 (并发工具执行) ──> P2-1 (Multi-Agent 并行派发)
P1-3 (Hooks) ──> 可替代部分 custom_rules
P2-2 (MCP) ──> P3-1 (延迟工具加载, 工具数多时)
```

### 验收标准

每个功能完成时需满足：
1. TypeScript 类型检查通过（`npm run typecheck`）
2. 单元测试覆盖率 ≥ 80%（`npm test`）
3. ESLint 0 warnings（`npm run lint`）
4. 构建成功（`npm run build`）
5. Code review（使用 code-reviewer agent）
6. 文档更新（本 Roadmap 标记完成状态）

### 风险与缓解

| 全局风险 | 等级 | 缓解 |
|---------|------|------|
| 弱模型 (glm-5.2) 对新工具/新流程的采纳率低 | 高 | 每个 P0 功能均含 "弱模型适配" 设计；考虑升级到更强模型 |
| AI SDK 4.x 对部分高级特性（如 prompt cache、流式工具执行）支持有限 | 中 | 必要时 fork 自定义；关注 AI SDK 5.x 进展 |
| Electron + better-sqlite3 原生模块在并发场景下的稳定性 | 中 | 并发上限控制；连接池扩容测试 |
| 功能数量多，迭代周期长 | 中 | 严格按 P0→P1→P2→P3 推进；P0 完成后即可发版 |

---

## 变更记录

| 日期 | 版本 | 变更 | 负责人 |
|------|------|------|--------|
| 2026-07-12 | v1.0 | 初始 Roadmap 制定 | - |

---

> **备注**: 本 Roadmap 基于与 claude-code-best (CCB) 逆向工程的深度对比分析制定。CCB 作为 Anthropic Claude Code CLI 的逆向还原，其架构经过大规模生产验证，借鉴价值极高。但 OpsAgent 作为运维垂直场景应用，需在借鉴时做运维适配（如多主机、SSH、安全模式等），不可照搬。
