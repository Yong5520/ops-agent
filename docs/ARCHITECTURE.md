# OpsAgent - 项目架构文档

## 1. 系统架构总览

OpsAgent 基于 Electron 构建，采用主进程（Main）+ 渲染进程（Renderer）的 IPC 通信架构。AI Agent Loop 运行在主进程中，通过 ssh2 直接执行 SSH 操作，渲染进程通过 React UI 展示交互。

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Application                       │
│                                                              │
│  ┌─────────────────── Renderer Process ──────────────────┐  │
│  │                                                        │  │
│  │  React 18 + TypeScript                                │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌────────┐ │  │
│  │  │ Chat UI  │ │ Settings │ │ Audit Log │ │ Hosts  │ │  │
│  │  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └───┬────┘ │  │
│  │       └──────────┬──┘             └───────────┘       │  │
│  │                  │                                     │  │
│  │            Zustand Store                               │  │
│  │                  │                                     │  │
│  └──────────────────┼─────────────────────────────────────┘  │
│                     │ IPC (contextBridge)                     │
│  ┌──────────────────┼─────────────────────────────────────┐  │
│  │           Main Process (Node.js)                      │  │
│  │                  │                                     │  │
│  │  ┌───────────────▼────────────────────────────────┐    │  │
│  │  │              IPC Handler Layer                │    │  │
│  │  └───┬────────┬────────┬────────┬────────┬────────┘    │  │
│  │      │        │        │        │        │              │  │
│  │  ┌───▼──┐ ┌───▼───┐ ┌▼──────▼┐ ┌▼──────┐ ┌▼──────┐    │  │
│  │  │Agent │ │SSH    │ │Security │ │Storage│ │Audit  │    │  │
│  │  │Loop  │ │Engine │ │Filter  │ │(SQLite)│ │Logger │    │  │
│  │  └───┬──┘ └───┬───┘ └────────┘ └───────┘ └───────┘    │  │
│  │      │        │                                        │  │
│  │  ┌───▼────────▼───────────────────────────────────┐    │  │
│  │  │         Vercel AI SDK 7.x                       │    │  │
│  │  │   @ai-sdk/anthropic  |  @ai-sdk/openai          │    │  │
│  │  └───────────────────┬───────────────────────────┘    │  │
│  │                      │                                 │  │
│  └──────────────────────┼─────────────────────────────────┘  │
│                         │                                     │
│                    ┌────▼────┐                                 │
│                    │ Model   │  Anthropic / OpenAI / Local    │
│                    │ APIs    │                                 │
│                    └─────────┘                                 │
└─────────────────────────────────────────────────────────────┘
```

## 2. 模块划分

### 2.1 SSH 层（`src/main/ssh/`）

核心 SSH 连接与命令执行引擎，从 ssh-mcp-multi 提取并重构。

| 模块 | 职责 | 复用来源 |
|------|------|----------|
| `connection.ts` | SSHConnectionManager - 单主机连接管理、自动重连、su 提权 | ssh-mcp-multi SSHConnectionManager |
| `pool.ts` | ConnectionPool - 多主机连接池管理 | ssh-mcp-multi ConnectionPool |
| `executor.ts` | 命令执行器 - exec / sudo-exec / su-exec | ssh-mcp-multi execSshCommand |
| `sftp.ts` | SFTP 操作 - 文件读写、上传下载 | ssh-mcp-multi getSftp + file tools |
| `types.ts` | HostConfig, 连接状态类型定义 | ssh-mcp-multi 类型 |

**重构要点：**
- 移除对 MCP Server SDK 的依赖（McpError → 自定义 OpsAgentError）
- 移除 YAML 配置加载，改为从 SQLite 数据库读取主机配置
- 连接池支持连接状态事件（connected/disconnected/error），供 UI 实时展示
- 命令执行支持流式回调（chunk-based），实时返回输出给 UI

### 2.2 安全层（`src/main/security/`）

安全过滤与授权控制系统。

| 模块 | 职责 | 复用来源 |
|------|------|----------|
| `rules.ts` | 18 条默认危险命令拦截规则 + 用户自定义规则 | ssh-mcp-multi DEFAULT_BLOCKED_RULES |
| `engine.ts` | 安全引擎 - 命令检查、白名单/黑名单、按主机覆盖 | ssh-mcp-multi checkCommandSecurity |
| `classifier.ts` | 命令分类器 - 判断命令类型（READ/WRITE/SUDO） | 新增 |
| `modes.ts` | 三级安全模式定义（Sentinel/Operator/Autopilot） | 新增 |

**安全模式实现：**

```typescript
type SafetyMode = 'sentinel' | 'operator' | 'autopilot';

interface CommandCheckResult {
  allowed: boolean;
  blockedBy?: string;       // 拦截规则原因
  needsApproval: boolean;    // 是否需要用户确认（operator 模式）
  commandType: 'READ' | 'WRITE' | 'SUDO' | 'BLOCKED';
  severity: 'critical' | 'high' | 'medium' | 'low';
}
```

### 2.3 Agent 层（`src/main/agent/`）

AI Agent Loop 核心，基于 Vercel AI SDK 7.x。

| 模块 | 职责 |
|------|------|
| `loop.ts` | Agent 主循环 - 消息处理、工具调用编排、流式响应 |
| `tools.ts` | 工具定义（exec, sudo_exec, read_file, write_file, list_hosts） |
| `system-prompt.ts` | System Prompt 构造器 - 根据上下文动态生成 |
| `context.ts` | 上下文管理器 - 消息历史、摘要压缩、Skill 注入 |
| `providers.ts` | 多模型提供商适配（Anthropic/OpenAI/兼容端点） |

### 2.4 IPC 层（`src/main/ipc/`）

主进程与渲染进程的通信桥梁。

| 模块 | 职责 |
|------|------|
| `handlers.ts` | IPC 通道注册 - 所有 ipcMain.handle 处理器 |
| `channels.ts` | 通道名称常量定义 |
| `preload.ts` | contextBridge 暴露 API 给渲染进程 |

### 2.5 存储层（`src/main/storage/`）

本地数据持久化，使用 better-sqlite3。

| 模块 | 职责 |
|------|------|
| `database.ts` | SQLite 连接管理、Schema 初始化 |
| `hosts.ts` | 主机配置 CRUD |
| `models.ts` | 模型配置 CRUD |
| `sessions.ts` | 会话存储与恢复 |
| `audit.ts` | 审计日志写入与查询 |
| `settings.ts` | 应用设置（安全模式、UI 偏好等） |

### 2.6 UI 层（`src/renderer/`）

基于 React 18 + TypeScript + Tailwind CSS + Shadcn UI。

| 模块 | 职责 |
|------|------|
| `pages/Chat/` | 对话界面 - 消息列表、输入框、授权确认弹窗 |
| `pages/Settings/` | 设置页 - 模型配置、主机管理、安全模式 |
| `pages/AuditLog/` | 审计日志查询界面 |
| `components/` | 通用组件 - Markdown 渲染、代码高亮、命令展示 |
| `hooks/` | 自定义 Hooks - useIPC、useAgent、useHosts |
| `store/` | Zustand 全局状态 |

## 3. 目录结构

```
ops-agent/
├── docs/                          # 项目文档
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── TASKS.md
│   └── SESSION_ACTIONS.md
├── electron/                      # Electron 主进程入口
│   ├── main.ts                    # 主进程启动
│   └── preload.ts                 # preload 脚本
├── src/
│   ├── main/                      # 主进程业务代码
│   │   ├── ssh/                   # SSH 连接引擎
│   │   │   ├── types.ts          # 类型定义
│   │   │   ├── connection.ts     # SSHConnectionManager
│   │   │   ├── pool.ts           # ConnectionPool
│   │   │   ├── executor.ts       # 命令执行器
│   │   │   └── sftp.ts           # SFTP 操作
│   │   ├── security/              # 安全过滤
│   │   │   ├── types.ts          # 安全类型定义
│   │   │   ├── rules.ts          # 默认拦截规则（18条）
│   │   │   ├── engine.ts         # 安全检查引擎
│   │   │   ├── classifier.ts     # 命令分类器
│   │   │   └── modes.ts          # 安全模式定义
│   │   ├── agent/                 # AI Agent
│   │   │   ├── loop.ts           # Agent 主循环
│   │   │   ├── tools.ts          # 工具定义
│   │   │   ├── system-prompt.ts  # System Prompt 构造
│   │   │   ├── context.ts        # 上下文管理
│   │   │   └── providers.ts      # 模型提供商适配
│   │   ├── ipc/                   # IPC 通信
│   │   │   ├── channels.ts       # 通道名称
│   │   │   ├── handlers.ts       # IPC 处理器
│   │   │   └── preload-api.ts    # preload 暴露的 API
│   │   ├── storage/               # 数据持久化
│   │   │   ├── database.ts       # SQLite 连接管理
│   │   │   ├── schema.ts         # Schema 定义
│   │   │   ├── hosts.ts          # 主机配置 CRUD
│   │   │   ├── models.ts         # 模型配置 CRUD
│   │   │   ├── sessions.ts       # 会话存储
│   │   │   ├── audit.ts          # 审计日志
│   │   │   └── settings.ts       # 应用设置
│   │   └── utils/                # 工具函数
│   │       ├── crypto.ts         # 加密/解密
│   │       └── logger.ts         # 日志工具
│   └── renderer/                  # 渲染进程（React）
│       ├── App.tsx                # 应用入口
│       ├── main.tsx               # React 挂载点
│       ├── pages/
│       │   ├── Chat/             # 对话页
│       │   │   ├── ChatPage.tsx
│       │   │   ├── MessageList.tsx
│       │   │   ├── MessageInput.tsx
│       │   │   ├── AuthDialog.tsx      # 授权确认弹窗
│       │   │   └── CommandCard.tsx     # 命令执行卡片
│       │   ├── Settings/         # 设置页
│       │   │   ├── SettingsPage.tsx
│       │   │   ├── ModelConfig.tsx
│       │   │   ├── HostConfig.tsx
│       │   │   └── SafetyMode.tsx
│       │   └── AuditLog/         # 审计日志页
│       │       ├── AuditPage.tsx
│       │       ├── AuditFilter.tsx
│       │       └── AuditTimeline.tsx
│       ├── components/
│       │   ├── MarkdownRenderer.tsx   # Markdown 渲染
│       │   ├── CodeBlock.tsx          # 代码高亮
│       │   ├── CollapsibleOutput.tsx # 长输出折叠
│       │   └── HostSelector.tsx       # 主机选择器
│       ├── hooks/
│       │   ├── useIPC.ts
│       │   ├── useAgent.ts
│       │   └── useHosts.ts
│       └── store/
│           ├── agentStore.ts
│           ├── hostStore.ts
│           └── settingsStore.ts
├── package.json
├── tsconfig.json
├── electron-builder.json          # Electron 打包配置
├── tailwind.config.ts
└── vite.config.ts                 # Vite 构建配置
```

## 4. 数据模型（SQLite Schema）

### 4.1 主机配置表

```sql
CREATE TABLE hosts (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL UNIQUE,           -- 自定义别名
  host        TEXT NOT NULL,                  -- IP 或域名
  port        INTEGER NOT NULL DEFAULT 22,
  username    TEXT NOT NULL,
  auth_type   TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password', 'key')),
  password    TEXT,                           -- AES 加密存储
  key_path    TEXT,                           -- SSH 密钥文件路径
  sudo_password TEXT,                         -- AES 加密存储
  su_password  TEXT,                          -- AES 加密存储
  group_name  TEXT DEFAULT 'default',
  timeout_ms  INTEGER NOT NULL DEFAULT 60000,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.2 模型配置表

```sql
CREATE TABLE model_providers (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL UNIQUE,           -- 显示名称
  type        TEXT NOT NULL CHECK (type IN ('anthropic', 'openai', 'openai-compatible')),
  endpoint    TEXT NOT NULL,                   -- API 端点
  api_key     TEXT NOT NULL,                   -- AES 加密存储
  model_name  TEXT NOT NULL,                  -- 模型 ID
  is_active   INTEGER NOT NULL DEFAULT 0,     -- 当前活跃模型
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.3 会话表

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title       TEXT,                            -- 会话标题（AI 自动生成或用户设置）
  host_id     TEXT REFERENCES hosts(id),      -- 关联主机
  safety_mode TEXT NOT NULL DEFAULT 'operator' CHECK (safety_mode IN ('sentinel', 'operator', 'autopilot')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.4 消息表

```sql
CREATE TABLE messages (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,                   -- 消息内容（Markdown）
  token_count INTEGER,                         -- token 数量
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
```

### 4.5 工具调用记录表

```sql
CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id),
  tool_name       TEXT NOT NULL,               -- exec / sudo_exec / read_file / write_file / list_hosts
  host_id         TEXT REFERENCES hosts(id),
  command         TEXT,                         -- 执行的命令
  description     TEXT,                         -- AI 对命令的描述
  command_type    TEXT NOT NULL DEFAULT 'READ' CHECK (command_type IN ('READ', 'WRITE', 'SUDO', 'BLOCKED')),
  authorization   TEXT NOT NULL DEFAULT 'auto' CHECK (authorization IN ('auto', 'approved', 'rejected', 'blocked')),
  exit_code       INTEGER,
  duration_ms     INTEGER,                      -- 执行耗时
  output_summary  TEXT,                         -- 命令输出摘要（截取前 2000 字符）
  output_full     TEXT,                         -- 完整输出（可选存储）
  blocked_reason  TEXT,                         -- 拦截原因
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tool_calls_session ON tool_calls(session_id, created_at);
CREATE INDEX idx_tool_calls_host ON tool_calls(host_id, created_at);
```

### 4.6 审计日志表（增强版）

```sql
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT REFERENCES sessions(id),
  host_id         TEXT REFERENCES hosts(id),
  host_name       TEXT NOT NULL,               -- 冗余存储，便于查询
  host_ip         TEXT NOT NULL,               -- 冗余存储
  safety_mode     TEXT NOT NULL,
  command_type    TEXT NOT NULL,
  command         TEXT NOT NULL,
  description     TEXT,
  authorization   TEXT NOT NULL,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  output_summary  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_host ON audit_logs(host_name, created_at);
CREATE INDEX idx_audit_time ON audit_logs(created_at);
CREATE INDEX idx_audit_type ON audit_logs(command_type);
```

### 4.7 应用设置表

```sql
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.8 自定义安全规则表

```sql
CREATE TABLE custom_rules (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  type        TEXT NOT NULL CHECK (type IN ('blocked', 'allowed')),
  pattern     TEXT NOT NULL,                  -- 正则表达式
  reason      TEXT NOT NULL,
  host_id     TEXT REFERENCES hosts(id),       -- NULL 表示全局规则
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 5. Agent Loop 详细设计

### 5.1 技术选型：Vercel AI SDK 7.x

选择 Vercel AI SDK 而非直接调用 Anthropic/OpenAI SDK 的原因：
- 统一的工具调用接口，不依赖特定模型提供商的 tool calling 格式
- 内置流式响应处理（textStream / toolCallStream）
- 多步工具调用编排（maxSteps 自动循环）
- 模型切换无需改动 Agent Loop 代码
- 生产级稳定性，已被 Vercel、Next.js 等大型项目验证

### 5.2 工具定义

```typescript
import { z } from 'zod';
import { tool } from 'ai';
import { execOnHost, sudoExecOnHost, readFileOnHost, writeFileOnHost, listAllHosts } from '../ssh';

export const tools = {
  exec: tool({
    description: 'Execute a shell command on a remote SSH server.',
    parameters: z.object({
      host: z.string().describe('Target host name'),
      command: z.string().describe('Shell command to execute'),
      description: z.string().describe('Purpose of this command'),
    }),
    execute: async ({ host, command, description }) => {
      return execOnHost(host, command, description);
    },
  }),

  sudo_exec: tool({
    description: 'Execute a command with sudo privileges on a remote SSH server.',
    parameters: z.object({
      host: z.string().describe('Target host name'),
      command: z.string().describe('Shell command to execute with sudo'),
      description: z.string().describe('Purpose of this command'),
    }),
    execute: async ({ host, command, description }) => {
      return sudoExecOnHost(host, command, description);
    },
  }),

  read_file: tool({
    description: 'Read a file on a remote host via SFTP.',
    parameters: z.object({
      host: z.string().describe('Target host name'),
      path: z.string().describe('Remote file path'),
      offset: z.number().optional().describe('Start line (1-based)'),
      limit: z.number().optional().describe('Max lines to read'),
    }),
    execute: async ({ host, path, offset, limit }) => {
      return readFileOnHost(host, path, offset, limit);
    },
  }),

  write_file: tool({
    description: 'Write content to a file on a remote host via SFTP.',
    parameters: z.object({
      host: z.string().describe('Target host name'),
      path: z.string().describe('Remote file path'),
      content: z.string().describe('Content to write'),
      description: z.string().optional().describe('Purpose of this write'),
    }),
    execute: async ({ host, path, content, description }) => {
      return writeFileOnHost(host, path, content, description);
    },
  }),

  list_hosts: tool({
    description: 'List all configured SSH hosts and their connection status.',
    parameters: z.object({}),
    execute: async () => {
      return listAllHosts();
    },
  }),
};
```

### 5.3 Agent Loop 流程

```typescript
import { generateText, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

async function runAgentLoop(params: {
  sessionId: string;
  userMessage: string;
  hostId?: string;
  safetyMode: SafetyMode;
  modelProvider: ModelProvider;
  onTextStream: (text: string) => void;
  onToolCall: (toolCall: ToolCallInfo) => Promise<ToolCallApproval>;
  onToolResult: (result: ToolCallResult) => void;
  onComplete: (finalMessage: string) => void;
}) {
  // 1. 构造 System Prompt
  const systemPrompt = buildSystemPrompt({
    hosts: getActiveHosts(),
    currentHost: params.hostId,
    safetyMode: params.safetyMode,
    enabledSkills: getEnabledSkills(params.sessionId),
    securityRules: getEffectiveRules(),
  });

  // 2. 加载会话历史
  const messages = await loadSessionMessages(params.sessionId);

  // 3. 创建模型实例
  const model = createModelInstance(params.modelProvider);

  // 4. 执行 Agent 循环（maxSteps 实现自动循环）
  const result = streamText({
    model,
    system: systemPrompt,
    messages: [...messages, { role: 'user', content: params.userMessage }],
    tools,
    maxSteps: 20,
    onStepFinish: async ({ toolCalls, toolResults }) => {
      // 每步完成后：记录审计日志、保存消息
      for (const tc of toolCalls) {
        await recordToolCall(params.sessionId, tc, toolResults);
      }
      await saveSessionMessages(params.sessionId, messages);
    },
  });

  // 5. 流式输出处理
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        params.onTextStream(part.textDelta);
        break;
      case 'tool-call':
        // 安全检查 + 用户授权
        const approval = await handleToolCallApproval(
          part.toolCallId,
          part.toolName,
          part.args,
          params.safetyMode,
          params.onToolCall
        );
        if (approval.rejected) {
          // 返回拒绝信息给模型
        }
        break;
      case 'tool-result':
        params.onToolResult(part.result);
        break;
    }
  }

  params.onComplete(result.text);
}
```

### 5.4 安全检查集成点

安全检查在两个层面进行：

**层面 1：工具执行前（hard block）**
```typescript
async function preToolCheck(toolName: string, args: any, safetyMode: SafetyMode) {
  const command = args.command;

  // 1. 安全规则过滤 - 所有模式下生效
  const secResult = checkCommandSecurity(command, args.host);
  if (!secResult.allowed) {
    return { allowed: false, reason: secResult.reason, commandType: 'BLOCKED' };
  }

  // 2. 命令分类
  const cmdType = classifyCommand(command);

  // 3. 按安全模式决定是否需要用户确认
  if (safetyMode === 'sentinel') {
    // 诊断模式：只允许 READ
    if (cmdType !== 'READ') {
      return { allowed: false, reason: 'Sentinel 模式仅允许只读操作', commandType: cmdType };
    }
    return { allowed: true, needsApproval: false, commandType: 'READ' };
  }

  if (safetyMode === 'operator') {
    // 标准模式：READ 自动，WRITE/SUDO 需确认
    return { allowed: true, needsApproval: cmdType !== 'READ', commandType: cmdType };
  }

  // autopilot：全部自动执行
  return { allowed: true, needsApproval: false, commandType: cmdType };
}
```

**层面 2：用户授权（UI 交互）**
```typescript
// IPC handler 处理授权请求，渲染进程弹出确认对话框
// 使用 Electron dialog 或自定义 React 弹窗
// 结果通过 IPC 返回主进程
```

## 6. 安全模型设计

### 6.1 凭据加密

使用 AES-256-GCM 加密存储敏感信息：

- **密钥来源**：首次启动时生成随机主密钥，存储在系统密钥链（Windows DPAPI / macOS Keychain / Linux libsecret）
- **加密对象**：主机密码、sudo 密码、su 密码、API Key
- **加密流程**：`plaintext → IV(random) + AES-GCM(plaintext, masterKey) → base64 存储`
- **解密流程**：`base64 → IV + ciphertext → AES-GCM-decrypt(ciphertext, IV, masterKey) → plaintext`

### 6.2 IPC 安全

- 使用 `contextBridge` 严格暴露 API，不直接暴露 Node.js API 到渲染进程
- 所有 IPC 通信通过 `ipcMain.handle` / `ipcRenderer.invoke` 双向验证
- 渲染进程启用 `contextIsolation: true` 和 `nodeIntegration: false`

### 6.3 配置导出安全

- 导出文件使用 AES 加密，需密码才能导入
- API Key 和密码默认脱敏显示（仅显示后 4 位）

## 7. 可复用代码清单

以下代码从 ssh-mcp-multi（`C:\ProDate\sshserver\src\index.ts`）提取并重构：

### 7.1 直接复用（需小幅修改）

| 原始代码 | 行号 | 目标模块 | 修改内容 |
|---------|------|---------|---------|
| `SSHConnectionManager` 类 | 329-449 | `src/main/ssh/connection.ts` | 移除 McpError，改用自定义错误类 |
| `ConnectionPool` 类 | 453-490 | `src/main/ssh/pool.ts` | 主机配置从数据库读取，添加事件发射 |
| `execSshCommand` 函数 | 520-569 | `src/main/ssh/executor.ts` | 添加流式回调支持 |
| `getSftp` 函数 | 575-583 | `src/main/ssh/sftp.ts` | 几乎无需修改 |
| `DEFAULT_BLOCKED_RULES` 数组 | 158-184 | `src/main/security/rules.ts` | 提取为独立模块 |
| `checkCommandSecurity` 函数 | 252-302 | `src/main/security/engine.ts` | 添加按主机 ID 覆盖 |
| `compileRules` 函数 | 188-194 | `src/main/security/engine.ts` | 直接复用 |
| `splitCommandChain` 函数 | 246-250 | `src/main/security/engine.ts` | 直接复用 |
| `sanitizeCommand` 函数 | 308-316 | `src/main/ssh/executor.ts` | 移除 McpError |

### 7.2 需重构

| 原始代码 | 行号 | 重构原因 |
|---------|------|---------|
| `loadSecurityConfig` | 196-244 | 配置来源从 YAML 改为 SQLite |
| `appendLog` | 500-516 | 从文件日志改为 SQLite 数据库写入 |
| 主机配置加载 | 116-154 | 从 YAML 解析改为数据库查询 |
| CLI 参数解析 | 68-104 | 桌面应用不需要 CLI 参数 |

### 7.3 可参考但不直接复用

| 功能 | 说明 |
|------|------|
| MCP Server 注册 | 使用 Vercel AI SDK tool 定义替代 |
| StdioTransport | Electron IPC 替代 |
| YAML 解析 | SQLite CRUD 替代 |

## 8. 关键技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 桌面框架 | Electron | ssh2 库成熟度是决定性因素，ssh2 是生产级久经验证的 Node.js SSH 库 |
| Agent Loop | Vercel AI SDK 7.x | 统一多模型接口，内置流式处理和多步工具调用，社区活跃 |
| 前端框架 | React 18 + TypeScript | 生态成熟，组件丰富，团队熟悉度高 |
| UI 组件库 | Shadcn UI | 基于 Radix，可定制性强，不引入运行时依赖 |
| 样式方案 | Tailwind CSS | 原子化 CSS，开发效率高，配合 Shadcn 使用 |
| 状态管理 | Zustand | 轻量（~1KB），API 简洁，无 Provider 嵌套 |
| 本地数据库 | better-sqlite3 | 同步 API，性能优秀，无需异步复杂性 |
| Markdown 渲染 | react-markdown + remark-gfm | 支持表格、任务列表等 GFM 扩展 |
| 代码高亮 | Shiki | 支持语言广泛，主题丰富，使用 TextMate 语法 |
| 构建工具 | Vite | 快速 HMR，原生 TypeScript 支持，Electron 生态兼容 |
| 打包工具 | electron-builder | 成熟的 Windows/macOS/Linux 打包方案 |
