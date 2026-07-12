# OpsAgent 项目架构详解

> 基于代码库实际扫描生成，覆盖所有模块、调用链路和数据流。

## 1. 项目概览

- **路径**: `C:\ProDate\ai-tools\ops-agent`
- **类型**: Electron 31 + React 18 + TypeScript 桌面应用 - AI 驱动的 Linux 运维 Agent
- **定位**: 用户通过自然语言对话，远程诊断、分析、修复多台 Linux 主机
- **技术栈**: Vercel AI SDK 4.x（streamText）、ssh2（SSH）、better-sqlite3（同步 DB）、Zustand（状态）、xterm.js（终端）

---

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React/ESM)                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │ ChatPage │ │ Settings │ │ Terminal │ │ AuditLog     │    │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘    │
│       │            │            │               │            │
│  ┌────┴───────────┴────────────┴───────────────┴──────┐     │
│  │  Zustand Stores (agent/session/host/terminal/ui)   │     │
│  └─────────────────────┬──────────────────────────────┘     │
│                        │ window.opsAgent (contextBridge)    │
└────────────────────────┼────────────────────────────────────┘
                         │ ipcRenderer.invoke / ipcRenderer.on
┌────────────────────────┼────────────────────────────────────┐
│  Electron Preload (preload.ts)                              │
│  contextBridge.exposeInMainWorld('opsAgent', api)           │
└────────────────────────┬────────────────────────────────────┘
                         │ ipcMain.handle / webContents.send
┌────────────────────────┼────────────────────────────────────┐
│  Main Process (Node.js/CJS)                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ IPC Handlers│  │ Agent Loop   │  │ Security Engine   │   │
│  │ (handlers.ts)│  │ (loop.ts)    │  │ (classifier+engine)│   │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬─────────┘   │
│         │                │                     │             │
│  ┌──────┴──────────┐ ┌───┴──────────┐ ┌────────┴────────┐   │
│  │ SSH Pool+Cli    │ │ AI SDK tools │ │ Storage (SQLite)  │   │
│  │ (pool+executor) │ │ (tools.ts)   │ │ (9 tables)        │   │
│  └─────────────────┘ └──────────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 完整目录结构

```
ops-agent/
├── electron/
│   ├── main.ts                         # 主进程入口 (app.whenReady -> initDB -> createWindow -> registerIpc)
│   └── preload.ts                      # contextBridge 桥接层
├── src/
│   ├── main/                           # 主进程 (CJS)
│   │   ├── agent/
│   │   │   ├── loop.ts                 # ★ 核心 Agent 循环 (504 行)
│   │   │   ├── tools.ts                # ★ 工具定义 (976 行, 最大文件)
│   │   │   ├── system-prompt.ts        # 动态系统提示词构建
│   │   │   ├── context.ts              # 上下文管理 + 压缩 + 摘要
│   │   │   ├── providers.ts            # 模型 Provider 适配
│   │   │   ├── facts.ts                # 主机运行时信息采集 (5min 缓存)
│   │   │   ├── token-budget.ts          # Token 预算追踪
│   │   │   ├── ai-command.ts           # 终端 AI 命令生成
│   │   │   ├── export.ts               # 会话导出 Markdown
│   │   │   ├── types.ts                # Agent 类型定义
│   │   │   ├── compaction/
│   │   │   │   ├── microcompact.ts     # 工具结果截断 (head+tail, >4000 字符)
│   │   │   │   └── snip.ts             # 旧工具结果剪贴 (>40% 上下文)
│   │   │   ├── memory/
│   │   │   │   ├── claudemd.ts         # CLAUDE.md + @include 指令解析
│   │   │   │   └── automem.ts           # MEMORY.md 自动记忆
│   │   │   ├── skills/
│   │   │   │   ├── builtin.ts          # 8 个内置诊断技能
│   │   │   │   ├── types.ts
│   │   │   │   └── index.ts
│   │   │   └── tools/
│   │   │       ├── todo-write.ts       # TodoWrite 任务列表工具
│   │   │       ├── exit-plan-mode.ts   # ExitPlanMode 计划审批工具
│   │   │       └── update-memory.ts    # update_memory 记忆写入工具
│   │   ├── ipc/
│   │   │   ├── channels.ts             # 50+ IPC 通道名常量
│   │   │   ├── handlers.ts            # 所有 ipcMain.handle 注册
│   │   │   ├── preload-api.ts          # OpsAgentApi 接口规范
│   │   │   └── terminal.ts             # 交互终端 + SFTP + 文件对话框
│   │   ├── security/
│   │   │   ├── classifier.ts          # ★ 命令分类器 (READ/WRITE/SUDO/BLOCKED)
│   │   │   ├── engine.ts              # ★ 安全决策引擎
│   │   │   ├── rules.ts               # 25 条默认拦截规则
│   │   │   ├── modes.ts               # 4 种安全模式
│   │   │   └── types.ts
│   │   ├── ssh/
│   │   │   ├── connection.ts          # SSHConnectionManager (单主机)
│   │   │   ├── pool.ts                # ConnectionPool (池化 + 空闲超时)
│   │   │   ├── executor.ts            # 命令执行 (exec/sudo_exec/su shell)
│   │   │   ├── circuit-breaker.ts     # 熔断器 (3 失败 -> 60s 熔断)
│   │   │   ├── sftp.ts                # SFTP 文件操作
│   │   │   ├── active-terminals.ts    # 活跃终端追踪
│   │   │   └── reconnect.ts           # 指数退避重连
│   │   ├── storage/
│   │   │   ├── database.ts            # SQLite 初始化 + 迁移 (v1-v3)
│   │   │   ├── schema.ts              # 9 张表 DDL
│   │   │   ├── crypto.ts              # AES-256-GCM 凭证加密
│   │   │   ├── hosts.ts               # 主机 CRUD + 批量 + 分组
│   │   │   ├── models.ts              # 模型 Provider CRUD
│   │   │   ├── sessions.ts            # 会话 + 消息 CRUD
│   │   │   ├── audit.ts              # 审计日志查询
│   │   │   ├── settings.ts           # 应用设置 KV
│   │   │   ├── custom-rules.ts       # 自定义安全规则
│   │   │   └── task-lists.ts         # TodoWrite 持久化
│   │   └── utils/logger.ts
│   ├── renderer/                      # 渲染进程 (React/ESM)
│   │   ├── pages/
│   │   │   ├── Chat/
│   │   │   │   ├── ChatPage.tsx       # ★ 主聊天页 (编排所有组件)
│   │   │   │   ├── MessageInput.tsx   # 输入框 + @mention 主机
│   │   │   │   ├── MessageList.tsx    # 虚拟化消息列表
│   │   │   │   ├── SessionSidebar.tsx # 会话列表 + 主机选择 + 模式
│   │   │   │   └── AuthDialog.tsx    # 授权队列对话框
│   │   │   ├── Settings/
│   │   │   ├── Terminal/
│   │   │   ├── AuditLog/
│   │   │   └── Dashboard/
│   │   ├── components/
│   │   │   ├── AppShell.tsx           # 应用外壳 + 左侧导航
│   │   │   ├── CommandCard.tsx        # 工具调用卡片
│   │   │   ├── PlanApprovalDialog.tsx # 计划审批对话框
│   │   │   ├── TaskList.tsx           # 任务列表显示
│   │   │   ├── ConfirmDialog.tsx      # 全局非阻塞确认框
│   │   │   └── MarkdownRenderer.tsx
│   │   ├── store/
│   │   │   ├── agentStore.ts          # ★ Agent 状态 (流式文本/工具卡/授权)
│   │   │   ├── sessionStore.ts        # 会话/消息/主机/模式
│   │   │   ├── hostStore.ts
│   │   │   ├── modelStore.ts
│   │   │   ├── terminalStore.ts
│   │   │   └── uiStore.ts             # 全局确认对话框状态
│   │   └── types/global.d.ts         # ★ OpsAgentApi 副本 (需与 preload-api.ts 同步)
│   └── shared/types.ts                # 主进程+渲染进程共享类型
├── package.json
├── electron-builder.json
├── electron.vite.config.ts
└── tsconfig.json / tsconfig.node.json
```

---

## 4. 数据库 Schema (9 张表)

DB 路径: `%APPDATA%/ops-agent/ops-agent.db` (WAL 模式, 外键开启)

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `hosts` | SSH 主机配置 | id, name, host:port, username, auth_type, password(加密), sudo_password(加密), group_name, timeout_ms |
| `model_providers` | AI 模型配置 | id, type(anthropic/openai/openai-compatible), endpoint, api_key(加密), model_name, is_active |
| `sessions` | 聊天会话 | id, host_ids(JSON数组), safety_mode, status, plan_mode, summary, summary_coverage_index |
| `messages` | 聊天消息 | session_id(FK), role(user/assistant/system), content, token_count |
| `audit_logs` | 审计日志(实际使用) | session_id, host_id, command_type, command, authorization, exit_code |
| `tool_calls` | 工具调用记录(**已废弃**, 0行) | - (recordAudit 只写 audit_logs) |
| `app_settings` | 应用设置 KV | key, value (safetyMode/activeModelId/maxSteps 等) |
| `custom_rules` | 自定义安全规则 | type(blocked/allowed), pattern(正则), host_id(NULL=全局) |
| `task_lists` | TodoWrite 持久化 | session_id, todos(JSON) |

**加密**: AES-256-GCM, 主密钥用 Electron `safeStorage`(OS keychain) 加密后存 `master.key` 文件

---

## 5. 复杂运维请求的完整流程追踪

以用户输入 **"帮我排查 web-01 主机上 nginx 服务无法访问的问题，检查配置、日志、端口"** 为例（operator 模式，多步骤工具调用）。

### 阶段 A: 用户输入 (Renderer)

```
用户在 MessageInput 输入 "@web-01 帮我排查 nginx 无法访问..."
  │
  ├─ MessageInput.tsx: detectMention() 检测到 @web-01
  │   └─ insertMention() -> onMentionHost(hostId) -> ChatPage 添加到 sessionStore.hostIds
  │
  ├─ 用户按 Enter -> ChatPage.handleSend(text)
  │   ├─ 若无 session: sessionStore.createSession({ hostIds, safetyMode }) [IPC: sessions:create]
  │   ├─ sessionStore.addMessage({ role:'user', content:text })  // UI 立即显示
  │   └─ agentStore.startRun({ sessionId, userMessage, hostIds, safetyMode })
  │
  └─ agentStore.startRun():
      ├─ 设置 isRunning=true, 清空 streamingText/toolCards/error
      ├─ 注册 7 个 IPC 事件监听器 (onTextStream/onToolCall/onToolResult/...)
      └─ window.opsAgent.agent.run(request)  // ipcRenderer.invoke('agent:run')
```

### 阶段 B: IPC 桥接

```
ipcRenderer.invoke('agent:run', request)
  │
  └─ handlers.ts: ipcMain.handle('agent:run')
      ├─ 检查该 session 是否已有 loop 在跑 (activeLoops Map)
      ├─ 创建 AbortController, 存入 activeLoops
      ├─ 异步调用 runAgentLoop(params) - 立即返回, 不阻塞 IPC
      └─ loop 通过回调推送事件:
          onTextStream  -> webContents.send('agent:text-stream', {sessionId, text})
          onToolCall    -> webContents.send('agent:tool-call', {...info})
          onToolResult  -> webContents.send('agent:tool-result', {...result})
          onAuthReq     -> webContents.send('agent:authorization-request', {...req})
          onTodosUpdate -> webContents.send('agent:todos-update', {sessionId, todos})
          onPlanApproval-> webContents.send('agent:plan-approval-request', {...})
          onModeChange  -> webContents.send('agent:mode-change', {sessionId, mode})
          onComplete    -> webContents.send('agent:complete', {sessionId, finalMessage})
          onError       -> webContents.send('agent:error', {sessionId, message})
```

### 阶段 C: Agent 循环启动 (loop.ts)

```
runAgentLoop(params)
  │
  ├─ 1. 解析会话上下文
  │   └─ SessionContext: 默认 host = hostIds[0], 持久化 safetyMode
  │
  ├─ 2. 采集主机运行时信息 (facts.ts)
  │   └─ gatherMultipleHostFacts(hostIds) [并行 Promise.allSettled]
  │       ├─ 每个 host: connectionPool.get(hostId) -> execCommand(GATHER_COMMAND)
  │       └─ 单次 SSH 往返采集: OS/kernel/CPU/内存/磁盘/失败单元/dmesg
  │       └─ 5 分钟缓存 (factsCache Map), 结果注入系统提示词
  │
  ├─ 3. 构建系统提示词 (system-prompt.ts: buildSystemPrompt)
  │   └─ 7+ 段落拼接:
  │       ① 角色定义 (OpsAgent 运维助手)
  │       ② 选中主机列表 (name, IP:port, group, @host 语法)
  │       ③ 主机运行时信息 (facts: OS/内核/CPU/内存/失败服务)
  │       ④ 全部主机列表 (✓ 标记选中)
  │       ⑤ 安全模式说明 (sentinel/operator/autopilot/plan)
  │       ⑥ 安全规则 (25 条默认拦截规则)
  │       ⑦ CLAUDE.md (claudemd.ts: @include 递归解析, 25KB 限制)
  │       ⑧ MEMORY.md (automem.ts: 200 行/25KB 限制)
  │       ⑨ 启用的技能 (8 个内置诊断技能的 promptFragment)
  │       ⑩ 18 条操作准则 (诊断优先、必须给 description、必须给结论等)
  │
  ├─ 4. 校验模型 + 获取实例 (providers.ts)
  │   ├─ validateModelExists() [预检: 查询 /v1/models 避免代理 ECONNRESET]
  │   └─ getActiveModel() -> createAnthropic() / createOpenAI() [根据 type]
  │
  ├─ 5. 加载 + 压缩消息历史 (context.ts)
  │   ├─ loadMessages(sessionId): 从 DB 读取, 前置已持久化的 summary
  │   ├─ compressContext(): 若 token > 60% 上下文窗口 -> generateText 生成结构化摘要
  │   │   └─ 摘要持久化到 sessions.summary 列
  │   └─ buildMessagesForCall(history, newUserMessage): 追加新消息 + 微压缩
  │
  ├─ 6. 创建工具集 (tools.ts: createTools)
  │   ├─ 工具闭包: context, safetyMode, modeHolder, 所有回调函数
  │   ├─ modeHolder = { mode: safetyMode }  // 可变对象, ExitPlanMode 可中途切换
  │   └─ 工具列表: exec, sudo_exec, read_file, write_file, list_hosts, rollback,
  │                todo_write, update_memory, exit_plan_mode(条件)
  │
  └─ 7. 主流式循环 (while stalled)
      │
      ├─ compactMessages(): 每次调用前压缩
      │   ├─ microcompactToolResults(): 单条工具结果 >4000 字符 -> head 20 + tail 20 行
      │   └─ snipCompactIfNeeded(): token >40% -> 旧工具结果替换为 [snipped: N chars]
      │
      ├─ streamText({ model, system, messages, tools, maxSteps:50, maxTokens:8192 })
      │   │
      │   └─ for await (part of result.fullStream):
      │       ├─ text-delta: 累积 roundText, onTextStream(delta) -> UI 流式显示
      │       ├─ tool-call:  toolCallCount++
      │       ├─ error:     若瞬时错误 -> 抛 __RETRY__ (重试, 最多 2 次, 2s/5s 退避)
      │       └─ finish:    记录 finishReason, 更新 token 预算追踪器
      │
      └─ 流结束后 stall 检测 + nudge:
          ├─ finishReason='length': maxTokens 升级 8k->32k + 恢复 nudge (max 3)
          ├─ finishReason='stop' + 有工具调用 + 文本<150字符 + 匹配过渡词
          │   ("让我|我来|继续|我先|接下来|下一步"):
          │   └─ nudge 循环 (max 2): 追加 "请给出分析结论" 提示, 重跑 streamText
          │   └─ ★ 关键: 使用 await result.response.messages (含工具调用上下文)
          │      而非裸 roundText, 防止模型幻觉
          └─ 其他: stalled=false, 循环退出
```

### 阶段 D: 工具调用执行 (tools.ts) - 以 exec 工具为例

AI 决定调用 `exec({ host: "web-01", command: "systemctl status nginx", description: "检查 nginx 服务状态" })`:

```
tool.execute(params)
  │
  ├─ 1. resolveHost(hostName)
  │   └─ 验证 hostName 在 session.hostIds 允许列表内, 返回 HostConfig
  │
  ├─ 2. sanitizeCommand(command)
  │   └─ 校验: 非空, <=10000 字符
  │
  ├─ 3. preExec() - 安全管道
  │   │
  │   ├─ 3a. checkCommandSecurity(command, hostId, config) [engine.ts]
  │   │   ├─ classifyCommand(command): 分类为 READ/WRITE/SUDO/BLOCKED
  │   │   │   ├─ splitChain(): 引号感知的管道分割 (|, ;, &&, ||)
  │   │   │   ├─ 每段独立分类, 取最高严重级别
  │   │   │   ├─ NULL_REDIRECTION_PATTERN: 全局剥离 /dev/null (修复 lspci 误判)
  │   │   │   ├─ REDIRECTION_PATTERN: 真实文件重定向 -> WRITE
  │   │   │   ├─ SHELL_METACHAR_PATTERN: heredoc/$()/backtick -> WRITE
  │   │   │   ├─ DUAL_PURPOSE: apt/systemctl/docker 等 (install/start/rm -> WRITE)
  │   │   │   └─ READ_COMMANDS(135条) / WRITE_COMMANDS(50条) 静态列表
  │   │   │
  │   │   ├─ 检查 1: 完整命令匹配 blocked 规则 (catches base64|bash)
  │   │   ├─ 检查 2: 每段命令匹配 blocked 规则
  │   │   ├─ 检查 3: 提取 $() 和 backtick 内容, 递归检查 (extractSubshellCommands)
  │   │   ├─ 检查 4: allowed 规则可降级 WRITE->READ (SUDO 永不降级)
  │   │   └─ 返回 { allowed, commandType, reason? }
  │   │
  │   ├─ 3b. decideByMode(modeHolder.mode, commandType) [modes.ts]
  │   │   ├─ sentinel: READ=auto, WRITE/SUDO=blocked
  │   │   ├─ operator: READ=auto, WRITE/SUDO=needsApproval
  │   │   ├─ autopilot: 全部 auto
  │   │   └─ plan: READ=auto, WRITE/SUDO=blocked (需先 exit_plan_mode)
  │   │
  │   └─ 3c. 若 needsApproval=true:
  │       ├─ onAuthorizationRequired(request) -> IPC: agent:authorization-request
  │       │   └─ Renderer: AuthDialog 弹出, 显示命令/类型/风险/备份选项
  │       ├─ 用户选择: 批准/拒绝/批准全部/拒绝全部 (5 分钟超时自动拒绝)
  │       └─ IPC: agent:authorization-response -> handlers.ts 解析 Promise
  │
  ├─ 4. 备份 (若用户勾选 backup)
  │   └─ execCommand: cp -p ${path} ${path}.opsagent-bak-${Date.now()}
  │
  ├─ 5. withRetry(execCommand(manager, command, onStream))
  │   │
  │   ├─ connectionPool.get(hostId)
  │   │   ├─ 熔断器检查: 若 open -> 立即抛错 (避免 30s SSH 超时)
  │   │   ├─ 若已连接且健康: 返回 SSHConnectionManager
  │   │   └─ 否则: 创建新连接 (host config + 解密密码 -> SSHConnectionManager.connect)
  │   │
  │   ├─ execCommand(manager, command, onStream)
  │   │   ├─ 若 su shell 激活: execViaSuShell (写入持久 root shell)
  │   │   └─ 否则: conn.exec(command) 打开通道
  │   │       ├─ stream.on('data'): stdout 累积 + onStream({stream:'stdout', data})
  │   │       ├─ stream.stderr.on('data'): stderr 累积 + onStream({stream:'stderr', data})
  │   │       └─ 超时: manager.timeout (默认 120s)
  │   │
  │   ├─ onStream 回调 -> onToolResult({ partial:true, stdout/stderr })
  │   │   └─ IPC: agent:tool-result (partial=true)
  │   │       └─ agentStore: 追加到现有工具卡片 (非替换)
  │   │           └─ UI: CommandCard 实时显示流式输出
  │   │
  │   └─ 重试逻辑:
  │       ├─ 仅重试瞬时错误 (SSH_TIMEOUT/ECONNRESET/EPIPE/Keepalive timeout)
  │       ├─ 若 hasStreamedOutput=true: 不重试 (避免副作用重复执行)
  │       └─ 最多 2 次重试, 1s/2s 退避
  │
  ├─ 6. 连接错误处理
  │   └─ 若 isConnectionError(err): connectionPool.invalidate(hostId) 强制关闭僵尸连接
  │
  ├─ 7. onToolResult(final)
  │   └─ IPC: agent:tool-result (partial=false, success, exitCode, durationMs)
  │       └─ agentStore: 替换工具卡片为最终结果, 设置 status=success/blocked/failed
  │
  ├─ 8. recordAudit() [auditStore]
  │   └─ INSERT INTO audit_logs (session_id, host_id, command_type, command, authorization, exit_code, ...)
  │       └─ 注意: 写 audit_logs, 不写 tool_calls (后者已废弃)
  │
  └─ 9. 返回结果给 AI -> AI 决定下一步 (可能继续调用工具或给出结论)
```

### 阶段 E: 多轮工具调用 (AI 自主决策)

对于复杂排查，AI 可能连续调用：
```
1. exec: systemctl status nginx              -> READ, 自动执行
2. exec: nginx -t                            -> READ, 自动执行
3. exec: ss -tlnp | grep :80                -> READ, 自动执行
4. exec: tail -100 /var/log/nginx/error.log -> READ, 自动执行
5. sudo_exec: systemctl restart nginx       -> SUDO, 需用户授权 (AuthDialog 弹出)
6. exec: curl -I http://localhost           -> READ, 验证修复
7. todo_write: 更新任务状态                   -> 无需授权
8. 最终文本: 给出诊断结论和修复结果            -> onComplete
```

每轮工具调用都经过完整的安全管道，流式输出实时推送到 UI。

### 阶段 F: 完成 (Renderer)

```
onComplete(finalMessage)
  └─ IPC: agent:complete
      └─ agentStore.onComplete handler:
          ├─ 保存 streamingText || finalMessage 为 assistant 消息 [sessionStore]
          ├─ isRunning = false, 清空 streamingText/toolCards
          ├─ 取消所有 IPC 事件监听 (unsubscribers)
          ├─ autoNameSession(): 若会话无标题, 用用户消息前 40 字符命名
          └─ MessageInput 自动聚焦 (window.restoreFocus IPC)
```

---

## 6. 核心模块职责速查

| 模块 | 文件 | 职责 |
|------|------|------|
| **Agent 循环** | `loop.ts` | streamText 调用、stall 检测、nudge、token 预算、错误恢复 |
| **工具工厂** | `tools.ts` | 6 个 SSH 工具 + 3 个内部工具, 闭包封装会话上下文 |
| **系统提示词** | `system-prompt.ts` | 10 段落动态拼接, 注入 facts/memory/skills/rules |
| **上下文管理** | `context.ts` | 消息加载、3 级压缩(microcompact/snip/summary)、摘要持久化 |
| **命令分类器** | `classifier.ts` | 管道感知分割、DUAL_PURPOSE 识别、135+50 条静态列表 |
| **安全引擎** | `engine.ts` | blocked/allowed 规则匹配、子命令递归检查、allowed 降级 |
| **安全模式** | `modes.ts` | 4 模式决策矩阵 (sentinel/operator/autopilot/plan) |
| **连接池** | `pool.ts` | 池化复用、10min 空闲超时、熔断器集成、健康检查 |
| **执行器** | `executor.ts` | exec/sudo_exec/su shell, sudo 自动剥离前缀, 双密码策略 |
| **熔断器** | `circuit-breaker.ts` | 3 次失败 -> 60s 熔断 -> half-open 试探 |
| **IPC 注册** | `handlers.ts` | 50+ 通道, 授权/计划审批 Promise 桥接, activeLoops 管理 |
| **终端管理** | `terminal.ts` | xterm.js SSH PTY, node-pty 本地 shell, SFTP, 重连 |
| **Agent Store** | `agentStore.ts` | 流式文本累积、工具卡片状态机、7 事件监听生命周期 |
| **计划审批** | `exit-plan-mode.ts` | 提交计划 -> 用户审批 -> modeHolder 中途切换模式 |

---

## 7. 关键架构决策

1. **modeHolder 可变对象**: `ExitPlanMode` 工具执行时设置 `modeHolder.mode='operator'`, 后续工具调用立即生效, 无需重建工具集
2. **response.messages 而非裸文本**: nudge 时追加 `await result.response.messages`(含工具调用上下文), 防止模型幻觉
3. **3 级上下文压缩**: microcompact(最廉价, 截断单条) -> snip(中等, 剪贴旧结果) -> summary(最贵, generateText 摘要)
4. **流式 + 重试互斥**: `hasStreamedOutput` 标志防止已产生副作用的命令重试
5. **管道感知分类**: `splitChain()` 引号感知分割, 每段独立分类取最高级别
6. **/dev/null 特殊处理**: `NULL_REDIRECTION_PATTERN` 全局剥离, 修复 `lspci 2>/dev/null` 误判为 WRITE
7. **dual OpsAgentApi 类型**: `preload-api.ts`(主) 和 `global.d.ts`(渲染) 必须同步维护
8. **tool_calls 表已废弃**: `recordAudit` 只写 `audit_logs`, 不写 `tool_calls`
9. **凭证加密**: AES-256-GCM + Electron safeStorage(OS keychain) 双层保护
10. **授权队列**: `pendingAuthorizations` Map + Promise, 5 分钟超时, 支持批量批准

---

## 8. 事件流总览

```
用户输入 ──> ChatPage.handleSend ──> agentStore.startRun ──> IPC agent:run
                                                         │
                    ┌────────────────────────────────────┘
                    ▼
              runAgentLoop (主进程)
                    │
        ┌───────────┼───────────────────────┐
        ▼           ▼                       ▼
   gatherHostFacts  buildSystemPrompt   createTools
        │           │                       │
        └─────┬─────┘                       │
              ▼                             │
        streamText ◄────────────────────────┘
              │
   ┌──────────┼──────────────┬─────────────┐
   ▼          ▼              ▼             ▼
text-delta  tool-call      finish       error
   │          │              │             │
   │          ▼              ▼             ▼
   │     preExec()      stall检测      重试/错误
   │     (分类+模式+授权)  │
   │          │          ▼
   │          ▼       nudge?
   │     execCommand      │
   │     (SSH+流式)       │
   │          │
   ▼          ▼
onTextStream  onToolResult(partial/final)
   │          │
   └────┬─────┘
        ▼
   IPC 事件推送 (webContents.send)
        │
        ▼
   agentStore 事件监听器
   ├─ streamingText 累积
   ├─ toolCards 状态更新
   ├─ pendingAuths 队列
   ├─ todos 更新
   └─ onComplete: 保存消息 + 清理
        │
        ▼
   React 重渲染 -> 用户看到结果
```

---

## 9. 安全模式决策矩阵

| 模式 | READ | WRITE | SUDO | BLOCKED | 用途 |
|------|------|-------|------|---------|------|
| `sentinel` | 自动执行 | 拦截 | 拦截 | 拦截 | 只读诊断模式 |
| `operator` | 自动执行 | 需授权 | 需授权 | 拦截 | 标准模式 (默认) |
| `autopilot` | 自动执行 | 自动执行 | 自动执行 | 拦截 | 全自动模式 |
| `plan` | 自动执行 | 拦截 | 拦截 | 拦截 | 计划模式 (exit_plan_mode 切换到 operator) |

---

## 10. 命令分类器流程

```
classifyCommand(command)
  │
  ├─ 1. splitChain(): 引号感知管道分割
  │   └─ 分割符: |, ;, &&, ||, |&
  │   └─ 不分割引号内的管道符 (如 grep "a|b")
  │
  ├─ 2. 单段或多段:
  │   └─ 多段取最高严重级别 (READ=0 < WRITE=1 < SUDO=2 < BLOCKED=3)
  │
  └─ classifySegment(trimmed):
      ├─ sudo 前缀 -> SUDO
      ├─ su 前缀 -> SUDO
      ├─ /dev/null 剥离 (NULL_REDIRECTION_PATTERN)
      ├─ 文件重定向 (>file) -> WRITE
      ├─ Shell 元字符 (heredoc/$()/backtick) -> WRITE
      ├─ DUAL_PURPOSE 检查 (apt/systemctl/docker 等)
      ├─ mount 特殊处理 (bare/-l=READ, else=WRITE)
      ├─ ifconfig 特殊处理 (<=2 tokens=READ)
      ├─ READ_COMMANDS 静态列表 (135 条)
      ├─ WRITE_COMMANDS 静态列表 (50 条)
      └─ 未知命令 -> WRITE (保守安全)
```

---

## 11. 上下文压缩三级机制

| 级别 | 模块 | 触发条件 | 机制 | 成本 |
|------|------|---------|------|------|
| 1. Microcompact | `compaction/microcompact.ts` | 单条工具结果 >4000 字符 | head 20 + tail 20 行, 中间替换占位符 | 最低 (纯截断) |
| 2. Snip | `compaction/snip.ts` | token >40% 上下文窗口 | 旧工具结果替换为 `[snipped: N chars]`, 保留最近 10 条 | 低 (纯截断) |
| 3. Summary | `context.ts:compressContext` | token >60% 上下文窗口 | `generateText` 生成结构化摘要 (命令/发现/错误/决策/状态), 持久化到 DB | 最高 (模型调用) |

---

## 12. 工具列表

### SSH 工具 (6 个)

| 工具 | 分类 | 用途 | 授权 |
|------|------|------|------|
| `exec` | 按命令分类 | 执行普通 SSH 命令 | READ=auto, WRITE/SUDO=需授权 |
| `sudo_exec` | SUDO | sudo 执行命令 (自动剥离 sudo 前缀) | 需授权 |
| `read_file` | READ | SFTP 读取文件 (默认 1000 行) | 自动执行 |
| `write_file` | WRITE | SFTP 写入文件 (可选备份) | 需授权 |
| `list_hosts` | - | 列出所有主机及连接状态 | 无需授权 |
| `rollback` | WRITE | 从最新 `.opsagent-bak-*` 备份恢复文件 | 需授权 |

### 内部工具 (3 个)

| 工具 | 用途 | 条件 |
|------|------|------|
| `todo_write` | 任务列表管理 (TodoWrite) | 始终可用 |
| `update_memory` | 写入 MEMORY.md 持久记忆 | 始终可用 |
| `exit_plan_mode` | 提交计划, 切换 plan->operator 模式 | 仅 `onPlanApproval` 提供时 |

---

## 13. 内置诊断技能 (8 个)

| 技能 | 默认启用 | 用途 |
|------|---------|------|
| `system-diagnosis` | ✓ | 全系统检查 (磁盘/内存/CPU/网络/进程/日志/内核) |
| `nginx-diagnosis` | ✓ | Nginx 配置测试/状态/日志/upstream |
| `docker-diagnosis` | ✓ | 容器状态/资源/日志/网络 |
| `systemd-diagnosis` | ✓ | 失败单元/journal/依赖 |
| `disk-full` | ✓ | 大文件/inode/日志清理 |
| `mysql-diagnosis` | ✗ | 进程/连接/慢查询/复制 |
| `redis-diagnosis` | ✗ | ping/内存/slowlog/客户端 |
| `security-audit` | ✗ | 防火墙/SSH 配置/用户/端口 |

每个技能的 `promptFragment` 包含结构化诊断步骤和具体命令, 注入系统提示词。

---

## 14. NPM 脚本

| 脚本 | 命令 | 用途 |
|------|------|------|
| `dev` | `electron-vite dev` | 开发服务器 + HMR |
| `build` | `electron-vite build` | 构建 3 个 bundle (main + preload + renderer) |
| `dist:win` | `electron-vite build && electron-builder --win` | Windows 安装包 |
| `lint` | `eslint . --max-warnings 0` | 零警告策略 |
| `typecheck` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json` | 双项目类型检查 |
| `test` | `vitest run` | 运行测试 (323+ 测试) |
| `rebuild:native` | `prebuild-install -r electron -p better-sqlite3` | 重建原生模块 |

---

## 15. 关键依赖

| 包 | 版本 | 用途 |
|---|------|------|
| `ai` | ^4.0.0 | Vercel AI SDK (streamText, tool) |
| `@ai-sdk/anthropic` | ^1.0.0 | Claude Provider |
| `@ai-sdk/openai` | ^1.0.0 | OpenAI Provider |
| `ssh2` | ^1.15.0 | SSH 客户端 |
| `better-sqlite3` | ^11.3.0 | 同步 SQLite |
| `zustand` | ^4.5.0 | 状态管理 |
| `@xterm/xterm` | ^6.0.0 | 终端模拟器 |
| `@tanstack/react-virtual` | ^3.14.5 | 消息列表虚拟化 |
| `zod` | ^3.23.0 | 工具参数校验 |
| `react-markdown` | ^9.0.1 | Markdown 渲染 |
| `node-pty` | ^1.1.0 | 本地终端 PTY |
| `electron` | ^31.3.0 | 桌面框架 |
