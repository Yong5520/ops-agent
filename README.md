# OpsAgent

> AI 驱动的 Linux 运维 Agent 桌面客户端

OpsAgent 是一个独立的 PC 桌面应用，让运维人员通过自然语言对话的方式，让 AI 自动连接目标 Linux 主机进行诊断、分析和修复操作。无需安装 Claude Code，配置 API Key 或本地模型地址即可使用。

基于 [ssh-mcp-multi](https://github.com/Yong5520/ssh-mcp-multi) 验证的能力产品化而来。

## 核心特性

- **自建 Agent Loop** — 不依赖 Claude Code CLI / SDK，基于 Vercel AI SDK 自行实现工具调用循环
- **多模型后端** — 支持 Anthropic Claude、OpenAI GPT、以及任何 OpenAI 兼容端点（Ollama / vLLM / LM Studio 等本地模型）
- **安全优先** — 三级安全模式（Sentinel / Operator / Autopilot），从严格只读到完全自主按需切换
- **完全审计** — 所有操作（含被拦截命令）完整记录，支持查询和导出
- **多主机管理** — SSH 连接池、连接状态实时检测、按环境分组
- **本地加密存储** — 主机凭据使用 better-sqlite3 + 主密钥加密保存

## 安全模式

| 层级 | 名称 | 行为 |
|------|------|------|
| A | **诊断模式 (Sentinel)** | 严格只读，仅允许查询/诊断类命令，任何写入操作均被拦截 |
| B | **标准模式 (Operator)** | 允许全部操作，写入类命令需用户逐条确认授权后执行 |
| C | **自主模式 (Autopilot)** | AI 自行决定并执行全部命令，无需人工确认 |

安全过滤系统内置 18 条危险命令拦截规则，支持用户自定义黑/白名单，并防止通过 `eval`、`bash -c`、`base64` 等方式绕过过滤。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 31 |
| 前端 | React 18 + TypeScript + Tailwind CSS |
| 状态管理 | Zustand |
| AI SDK | Vercel AI SDK 4.x（`@ai-sdk/anthropic`、`@ai-sdk/openai`） |
| SSH | ssh2 |
| 本地存储 | better-sqlite3 |
| 构建 | electron-vite + electron-builder |
| 测试 | Vitest |

## 架构总览

```
┌─────────────── Renderer (React) ───────────────┐
│  Chat UI · Settings · Audit Log · Host Manager  │
│                  Zustand Store                  │
└──────────────────────┬─────────────────────────┘
                       │ IPC (contextBridge)
┌──────────────────────▼─────────────────────────┐
│                  Main Process                   │
│  Agent Loop · SSH Engine · Security Filter     │
│  Storage (SQLite) · Audit Logger               │
└──────────────────────┬─────────────────────────┘
                       │
        Anthropic / OpenAI / Local Model APIs
```

模块划分：

- `src/main/ssh/` — SSH 连接池、命令执行器、SFTP
- `src/main/security/` — 安全规则、命令分类、模式控制
- `src/main/agent/` — Agent 循环、工具定义、System Prompt、上下文管理
- `src/main/ipc/` — IPC 通道与处理器
- `src/main/storage/` — SQLite 持久化、加密、审计日志
- `src/renderer/` — React UI（Chat / Settings / AuditLog）

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 目录结构

```
ops-agent/
├── electron/          # Electron 主进程入口 (main.ts / preload.ts)
├── src/
│   ├── main/          # 主进程业务代码
│   │   ├── ssh/       # SSH 连接与执行引擎
│   │   ├── security/  # 安全过滤与授权
│   │   ├── agent/     # AI Agent Loop
│   │   ├── ipc/       # IPC 通信
│   │   ├── storage/   # 数据持久化
│   │   └── utils/     # 工具函数
│   ├── renderer/      # 渲染进程 (React UI)
│   │   ├── pages/     # Chat / Settings / AuditLog
│   │   ├── components/
│   │   └── store/     # Zustand 状态
│   └── shared/        # 主进程与渲染进程共享类型
├── docs/              # 项目文档 (PRD / ARCHITECTURE / TASKS)
└── resources/         # 应用资源
```

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+

### 安装依赖

```bash
npm install
```

> 安装会自动重建 `better-sqlite3` 的 Electron 原生模块（通过 `postinstall` 脚本）。

### 开发模式

```bash
npm run dev
```

启动 electron-vite 开发服务器，热重载修改。

### 类型检查 / Lint / 测试

```bash
npm run typecheck
npm run lint
npm test
```

### 打包

```bash
npm run dist:win    # Windows
npm run dist       # 当前平台
npm run pack       # 仅打包目录（不生成安装包）
```

## 配置

首次启动后，在应用内 **设置** 页面完成配置：

1. **模型配置** — 选择供应商类型，填写 API 端点、API Key、模型名称，可一键测试连通性
2. **目标主机** — 添加主机（别名 / IP / 端口 / 用户名 / 认证方式 / sudo 密码），支持分组管理
3. **安全模式** — 选择当前会话的安全级别

主机凭据使用主密钥加密后存储于本地 SQLite 数据库，`master.key` 文件切勿提交（已在 `.gitignore` 中忽略）。

## 文档

- [docs/PRD.md](docs/PRD.md) — 产品需求文档
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构设计文档
- [docs/TASKS.md](docs/TASKS.md) — 任务清单
- [docs/SESSION_ACTIONS.md](docs/SESSION_ACTIONS.md) — 会话动作说明

## License

MIT
