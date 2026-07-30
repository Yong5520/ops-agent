# OpsAgent

> AI 驱动的 Linux 运维 Agent 桌面客户端

OpsAgent 是一个独立的 PC 桌面应用，让运维人员通过自然语言对话的方式，让 AI 自动连接目标 Linux 主机进行诊断、分析和修复操作。同时内置交互式终端、文件传输、命令片段库等运维工具。无需安装 Claude Code，配置 API Key 或本地模型地址即可使用。

基于 [ssh-mcp-multi](https://github.com/Yong5520/ssh-mcp-multi) 验证的能力产品化而来。

## 核心特性

### AI 运维 Agent

- **自建 Agent Loop** - 不依赖 Claude Code CLI / SDK，基于 Vercel AI SDK 自行实现工具调用循环
- **多模型后端** - 支持 Anthropic Claude、OpenAI GPT、以及任何 OpenAI 兼容端点（Ollama / vLLM / LM Studio 等本地模型，已验证 GLM / Qwen 系列）
- **每会话模型切换** - 每个会话可独立选择模型（会话级覆盖 > 全局默认），便于在同一项目中针对不同任务使用不同模型；设置页可为每个模型配置上下文窗口与单价
- **思考过程可视化** - Claude Code 风格的 thinking 块，展示模型推理过程，可折叠/展开
- **多模态图片附件** - 对话中可粘贴 / 拖入图片，模型可分析截图、图表、报错画面
- **安全优先** - 四级安全模式（Sentinel / Operator / Autopilot / Plan），从严格只读到完全自主按需切换；Plan 模式只读规划，输出实施计划待批准后执行
- **完全审计** - 所有操作（含被拦截命令）完整记录，支持查询和导出；审计链 (audit-chain) 防篡改
- **成本与用量追踪** - 后端记录每会话 token 用量与估算费用（`session_costs` 表）；`/cost` 命令查看累计用量与费用；`get_session_usage` 工具供 Agent 自查预算
- **主机运行时信息注入** - 自动采集 OS/CPU/内存/磁盘/服务状态等上下文注入 AI
- **流式输出 + 重试** - 工具执行实时流式回传，瞬态错误自动重试
- **在途命令控制** - 运维工具（tail_log / search_logs / journal_query / process_list 等）流式增量回传输出；运行中的命令可一键停止（UI ■ 按钮 + `stop_tail` 工具 + AbortSignal 关闭 SSH 流，返回已收到的部分输出）
- **大文件 / 日志读取保护** - 结构化运维工具参数自动钳制（`tail_log` 行数 ≤2000、grep 上下文 ≤10、`maxResults` ≤500 等）；超长工具结果溢出磁盘并以 head + tail 预览（尾部优先，保留错误堆栈），可通过 `read_tool_result` 取回全文
- **多主机批量执行** - `exec_multi` 工具将只读命令并行扇出到多台主机（`Promise.allSettled`），聚合成功 / 失败计数并检测输出差异（divergence），便于横向对比
- **文件回滚** - 写入操作前自动备份，支持一键回滚
- **上下文压缩** - 85% 阈值自动压缩，手动 `/compact [说明]` 触发；UI 实时显示 token 占用百分比和总量
- **任务清单 + 任务续接** - Agent 可创建结构化任务清单（TodoWrite）并持久化；会话恢复时将未完成清单注入系统提示并附带续接指令，模型从上次进度继续而非重新规划
- **循环韧性** - 空白助手消息导致的孤儿任务自动恢复；停滞检测 (stall detection) 防止 Agent 卡死
- **AskUserQuestion** - Agent 可向用户提问澄清需求，被拒绝的命令进入拒绝跟踪 (Denial Tracking) 用于后续优化
- **并发控制** - 工具调用并发度限制，防止对目标主机造成冲击
- **结构化运维工具** - tail_log / search_logs / journal_query / process_list / service_status / disk_analysis / network_connections 等结构化命令构建器，参数自动转义防注入

### 交互式终端

- **多标签终端** - 同时管理多个主机的 SSH 终端会话，标签可拖拽排序
- **本地终端** - 内置本地 CMD / Bash / PowerShell 终端（基于 node-pty，支持 ConPTY），可从主机列表或标签栏 `+` 快速打开
- **终端搜索** - Ctrl+F 搜索终端输出，支持正则和大小写敏感
- **右键菜单** - 复制 / 粘贴 / 搜索 / 清屏 / 导出 / 上传 / 下载（MobaXterm 风格）
- **导出输出** - 将终端滚动历史导出为 .txt 文件
- **广播模式** - 同时向多个终端发送相同输入
- **命令片段库** - 预置 15+ 常用运维命令，支持自定义命令保存

### 文件传输 (SFTP)

- **远程文件浏览** - 浏览远程主机目录，支持目录导航和路径输入
- **上传/下载** - 原生文件对话框选择本地文件，拖拽上传
- **传输进度** - 实时进度条显示百分比和字节数
- **取消传输** - 支持随时取消正在进行的传输
- **大文件支持** - 流式传输 + 活动超时检测，不会因空闲超时中断

### 多主机管理

- **SSH 连接池** - 连接复用、空闲超时自动关闭、断路器保护；命令超时自动失效僵尸连接
- **SSH 堡垒机 / 跳板机** - 支持经堡垒机连接目标主机，两种跳转模式：
  - **`forward`（默认）** - TCP 转发（`forwardOut`），支持多级跳板（深度上限 5 + 环路检测）
  - **`encoded`** - 用户名编码路由（`bastionUser@targetUser@targetHost`），适用于禁用端口转发的堡垒机
- **Agent 转发** - 可选启用 SSH agent forwarding
- **主机密钥验证** - 首次连接捕获主机密钥指纹（SHA256:base64，OpenSSH 格式，TOFU 信任首次使用），后续连接校验，防止中间人攻击
- **主机文件夹** - 显式 `host_groups` 表，空文件夹持久化；主机选择器按文件夹分组展示；对话中 `@` 提及主机时限定在当前文件夹范围
- **批量导入** - CSV/TSV 格式批量导入主机
- **主机组管理** - 按环境分组、重命名、删除
- **连接状态** - 实时检测连接状态和延迟

## 技能系统 (Skills)

采用**渐进式披露**设计，大幅降低系统提示占用：

- **SKILL.md 格式** - YAML frontmatter (`name` / `description` / `when_to_use`) + Markdown 诊断流程正文
- **元数据加载** - 系统提示仅注入技能名称与描述（约 200 tokens / 技能），不加载完整正文
- **`/skillName` 调用** - 在对话框输入 `/nginx-diagnosis 检查 502 错误`，自动注入完整技能内容到本次消息
- **内置技能** - 系统诊断、nginx 诊断、MySQL 诊断、磁盘 IO 分析、网络排查等
- **用户技能** - 在设置页安装 / 启用 / 禁用 / 删除自定义技能，存储于 `%APPDATA%/ops-agent/skills/{name}/SKILL.md`
- **AI 自助安装** - 用户可对话要求 "帮我安装 X 技能"，Agent 调用 `install_skill` 工具生成并落盘

## Hooks 系统

在工具执行前后注入自定义逻辑（类似 Claude Code Hooks）：

| 事件 | 触发时机 | 用途 |
|------|----------|------|
| **PreToolUse** | 工具执行前 | 拦截 (`deny`) / 放行 (`allow`) / 改写参数 (`pass` + modifiedInput) |
| **PostToolUse** | 工具执行后 | 追加上下文 (`additionalContext`)，影响下一轮决策 |

- **command 类型** - 本地命令，stdin 接收 JSON `{tool, input, hook}`，stdout 返回决策
- **http 类型** - 发送 webhook 请求，响应体作为决策输出
- **失败策略** - 超时或错误时 PreToolUse 默认放行（fail open），保证不阻塞正常流程
- **deny 优先** - 第一个 deny 立即终止，后续 hook 不再执行

## 斜杠命令

在对话框输入 `/` 触发：

| 命令 | 作用 |
|------|------|
| `/compact [说明?]` | 立即压缩上下文，可选传入压缩重点说明 |
| `/context` | 输出上下文使用分析（系统提示 / 工具定义 / 技能元数据 / 消息历史 / 记忆文件 / 自动压缩缓冲 分项 token 占用） |
| `/cost` | 查看当前会话累计 token 用量与估算费用 |
| `/skillName [参数]` | 调用技能，注入完整诊断流程到本次消息 |
| `/quick-command` | 快速执行预置运维命令片段 |

## 安全模式

| 层级 | 名称 | 行为 |
|------|------|------|
| A | **诊断模式 (Sentinel)** | 严格只读，仅允许查询/诊断类命令，任何写入操作均被拦截 |
| B | **标准模式 (Operator)** | 允许全部操作，写入类命令需用户逐条确认授权后执行 |
| C | **自主模式 (Autopilot)** | AI 自行决定并执行全部命令，无需人工确认 |
| D | **计划模式 (Plan)** | 只读规划，Agent 输出实施方案与步骤清单，用户批准后切回 Operator 执行 |

安全过滤系统内置 **29 条**危险命令拦截规则（文件系统破坏、系统控制、网络危险操作等），并支持用户自定义黑/白名单。规则现已可通过配置文件自定义：`{userData}/security-rules.json`（可在设置页 **安全** 标签页打开 / 重载 / 恢复默认）。

分类器与绕过防护：

- **命令位置感知** - 系统控制规则（shutdown / reboot / halt / init 等）要求危险词处于命令位，避免 `last reboot`（reboot 是参数）、`grep -E "shutdown|halt"`（引号内）等误判；同时拦截 `env reboot`、`FOO=bar reboot`、`sudo -u root reboot`、`exec reboot`、`chroot / reboot` 等包装形式
- **管道感知** - 对 `|`、`;`、`&&`、`||` 分段独立判定（引号感知拆分），取最高严重级别
- **重定向识别** - `/dev/null` 重定向不会误判为写入操作
- **子 shell 递归检查** - 递归检查 `$()` 子 shell 内容，防止通过 `eval`、`bash -c`、`base64` 等方式绕过过滤
- **容错** - 单条非法正则规则会被跳过并告警，不会使整个引擎失效

## 运维工具集

Agent 可调用的结构化工具（参数自动转义 / 钳制）：

| 工具 | 用途 |
|------|------|
| `exec` / `sudo_exec` | 在目标主机执行命令（sudo 自动剥离前缀） |
| `exec_multi` | 只读命令并行扇出到多台主机，聚合结果并检测输出差异 |
| `read_file` / `write_file` / `restore_file` | 远程文件读 / 写 / 从备份回滚 |
| `tail_log` | 读取日志尾部，支持 `follow`（tail -f），可用 `stop_tail` 停止 |
| `search_logs` | 多文件正则搜索，带上下文行 |
| `journal_query` | systemd journal 查询（单元 / 优先级 / 时间范围） |
| `process_list` | 进程列表（按 CPU / 内存排序） |
| `service_status` | systemd 服务状态 / 失败服务列表 |
| `disk_analysis` | 磁盘占用分析 |
| `network_connections` | 网络连接查询（按端口 / 状态过滤） |
| `stop_tail` | 停止运行中的 tail_log 命令 |
| `read_tool_result` | 取回溢出到磁盘的完整工具结果 |
| `get_session_usage` | 查询当前会话累计 token 用量与费用 |
| `install_skill` | 生成并落盘自定义技能 |
| `todo_write` | 创建 / 更新结构化任务清单 |
| `AskUserQuestion` / `exit_plan_mode` | 向用户提问 / 退出计划模式 |

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | Electron 31 |
| 前端 | React 18 + TypeScript + Tailwind CSS |
| 状态管理 | Zustand |
| AI SDK | Vercel AI SDK 4.x（`@ai-sdk/anthropic`、`@ai-sdk/openai`） |
| SSH | ssh2 |
| 本地终端 | node-pty（ConPTY，N-API 预编译） |
| 终端 UI | xterm.js 6.0 + SearchAddon + SerializeAddon |
| 本地存储 | better-sqlite3（schema v14） |
| 构建 | electron-vite + electron-builder |
| 测试 | Vitest（900+ 测试） |

## 架构总览

```
┌─────────────── Renderer (React) ───────────────┐
│  Chat UI · Terminal · Settings · Audit · Host  │
│                  Zustand Store                  │
└──────────────────────┬─────────────────────────┘
                       │ IPC (contextBridge)
┌──────────────────────▼─────────────────────────┐
│                  Main Process                   │
│  Agent Loop · SSH Engine · Security Filter      │
│  Terminal (PTY) · SFTP · Storage · Audit · Cost │
└──────────────────────┬─────────────────────────┘
                       │
        Anthropic / OpenAI / Local Model APIs
```

模块划分：

- `src/main/ssh/` - SSH 连接池、命令执行器、SFTP、断路器、堡垒机 / 跳板机、主机密钥验证、在途命令注册表
- `src/main/security/` - 安全规则、命令分类器、模式控制、可配置规则文件
- `src/main/agent/` - Agent 循环、工具定义、System Prompt、上下文管理、多主机聚合
- `src/main/agent/skills/` - 技能加载器、frontmatter 解析、渐进式披露
- `src/main/agent/hooks/` - Hook 引擎、command/http 执行器、条件匹配
- `src/main/agent/ops-commands.ts` - 结构化运维命令构建器（参数钳制）
- `src/main/agent/multi-host.ts` - 多主机批量执行结果聚合
- `src/main/agent/context-breakdown.ts` - `/context` 上下文占用分析
- `src/main/ipc/` - IPC 通道与处理器（终端、SFTP、文件对话框、技能、Hooks、成本）
- `src/main/storage/` - SQLite 持久化、加密、审计日志、审计链、Hooks 存储、会话成本
- `src/renderer/pages/Terminal/` - 交互式终端（xterm.js）、文件传输、命令片段
- `src/renderer/pages/Chat/` - AI 对话界面、斜杠命令解析、图片附件
- `src/renderer/pages/Settings/` - 主机/模型/安全模式/技能/Hooks/安全规则配置

## 目录结构

```
ops-agent/
├── electron/          # Electron 主进程入口 (main.ts / preload.ts)
├── src/
│   ├── main/          # 主进程业务代码
│   │   ├── ssh/       # SSH 连接池、执行器、SFTP、断路器、堡垒机、主机密钥
│   │   │   ├── build-ssh-config.ts        # SSH 配置构建（跳板机 / agent 转发）
│   │   │   ├── connection.ts              # 连接、主机密钥验证 (TOFU)
│   │   │   └── running-command-registry.ts # 在途命令注册 + 中止
│   │   ├── security/  # 安全过滤、命令分类器、授权、可配置规则
│   │   │   ├── rules.ts                   # 默认拦截规则
│   │   │   ├── rules-config.ts            # {userData}/security-rules.json 读写
│   │   │   ├── classifier.ts              # 引号感知管道拆分 + 严重级别判定
│   │   │   └── engine.ts                  # 规则编译 + 生效配置
│   │   ├── agent/     # AI Agent Loop、工具、上下文
│   │   │   ├── skills/    # 技能加载、frontmatter 解析
│   │   │   ├── hooks/     # Hook 引擎、command/http 执行器
│   │   │   ├── ops-commands.ts     # 结构化运维命令构建器（参数钳制）
│   │   │   ├── multi-host.ts        # 多主机批量结果聚合
│   │   │   ├── context-breakdown.ts # /context 上下文分析
│   │   │   ├── concurrency.ts       # 并发控制
│   │   │   ├── quick-command.ts     # 快速命令解析
│   │   │   └── tool-results.ts      # 工具结果处理（溢出 + head/tail 预览）
│   │   ├── ipc/       # IPC 通信（终端、SFTP、对话框、技能、Hooks、成本）
│   │   ├── storage/   # 数据持久化（SQLite + 加密 + 审计链 + Hooks + 成本）
│   │   └── utils/     # 工具函数
│   ├── renderer/      # 渲染进程 (React UI)
│   │   ├── pages/     # Chat / Terminal / Settings / AuditLog
│   │   │   ├── Terminal/  # 终端、文件传输、命令片段
│   │   │   ├── Chat/      # 对话界面 + slash-commands.ts + 图片附件
│   │   │   └── Settings/  # 主机/模型/安全/技能/Hooks/安全规则
│   │   ├── components/
│   │   └── store/     # Zustand 状态（agent/host/terminal/session/ui）
│   └── shared/        # 主进程与渲染进程共享类型
├── docs/              # 项目文档 (PRD / ARCHITECTURE / TASKS)
└── resources/         # 应用资源（图标等）
```

## 快速开始

### 环境要求

- Node.js 18+
- npm 9+
- Windows 10+ (ConPTY 支持)

### 安装依赖

```bash
npm install
```

> 安装会自动重建 `better-sqlite3` 的 Electron 原生模块（通过 `postinstall` 脚本）；`node-pty` 使用 N-API 预编译，无需额外重建。打包时 electron-builder 会再次确保原生依赖匹配 Electron 版本。

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
npm run dist:win    # Windows 安装包 (NSIS)
npm run dist        # 当前平台
npm run pack        # 仅打包目录（不生成安装包）
```

Windows 安装包输出于 `dist/OpsAgent-{version}-x64-setup.exe`。

## 配置

首次启动后，在应用内 **设置** 页面完成配置：

1. **模型配置** - 选择供应商类型，填写 API 端点、API Key、模型名称，可一键测试连通性；可为每个模型配置上下文窗口与输入 / 输出 / 缓存读 / 缓存创建单价（$/百万 token），用于成本估算
2. **目标主机** - 添加主机（别名 / IP / 端口 / 用户名 / 认证方式 / sudo 密码），支持文件夹分组、批量导入；可配置堡垒机（跳板机模式 / agent 转发 / 主机密钥验证）
3. **安全模式** - 选择当前会话的安全级别
4. **安全规则** - 在 **安全** 标签页查看 / 编辑 `security-rules.json` 拦截规则

主机凭据使用主密钥加密后存储于本地 SQLite 数据库，`master.key` 文件切勿提交（已在 `.gitignore` 中忽略）。

## 终端功能说明

| 功能 | 操作方式 |
|------|----------|
| 打开 SSH 终端 | 点击左侧主机列表 |
| 打开本地终端 | 点击标签栏 `+` 按钮 / 主机列表本地终端入口 |
| 新增同主机终端 | 右键标签 -> "复制当前窗口" |
| 关闭终端 | 标签 `×` 按钮 / 右键 -> "关闭标签" |
| 拖拽排序 | 拖动标签到目标位置 |
| 搜索终端 | Ctrl+F / 右键 -> "搜索" |
| 复制/粘贴 | Ctrl+Shift+C / Ctrl+Shift+V / 右键菜单 |
| 清屏 | 右键 -> "清屏" |
| 导出输出 | 右键 -> "导出" / 底部 💾 按钮 |
| 文件传输 | 工具栏 📁 按钮 / 右键 -> "上传/下载" |
| 命令片段 | 工具栏 ⌘ 按钮 |
| 广播模式 | 工具栏 📡 按钮（需 2+ 已连接终端）|

## 文档

- [docs/PRD.md](docs/PRD.md) - 产品需求文档
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - 架构设计文档
- [docs/ARCHITECTURE_DETAILED.md](docs/ARCHITECTURE_DETAILED.md) - 详细架构文档
- [docs/ROADMAP_V2.md](docs/ROADMAP_V2.md) - V2 路线图
- [docs/TASKS.md](docs/TASKS.md) - 任务清单
- [docs/SESSION_ACTIONS.md](docs/SESSION_ACTIONS.md) - 会话动作说明
- [docs/VERIFICATION_TASKS.md](docs/VERIFICATION_TASKS.md) - 验证任务清单

## License

MIT
