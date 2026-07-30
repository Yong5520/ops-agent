# OpsAgent

> AI 驱动的 Linux 运维 Agent 桌面客户端

通过自然语言对话让 AI 自动连接 Linux 主机进行诊断、分析与修复，内置交互式终端、SFTP 文件传输、命令片段库。无需 Claude Code，配置 API Key 或本地模型地址即可使用。基于 [ssh-mcp-multi](https://github.com/Yong5520/ssh-mcp-multi) 产品化而来。

## 核心特性

**AI 运维 Agent**
- 自建 Agent Loop（Vercel AI SDK），支持 Anthropic / OpenAI / 任意 OpenAI 兼容端点（Ollama / vLLM / GLM / Qwen 等），每会话可独立切换模型
- 四级安全模式 + 29 条可配置危险命令拦截规则，管道感知 / 命令位置感知 / 子 shell 递归检查防绕过
- 完全审计 + 审计链防篡改；写入前自动备份，一键回滚
- 成本与用量追踪（`/cost`、`get_session_usage`、每模型单价）
- 流式输出 + 在途命令可中止（`stop_tail` + UI 停止按钮）；大文件 / 日志读取参数钳制 + head/tail 预览，防撑爆上下文
- 多主机批量只读执行 `exec_multi`，聚合结果并检测差异
- 上下文压缩（85% 自动 / `/compact`）、任务清单 + 任务续接、循环韧性、思考块可视化、多模态图片附件
- 结构化运维工具：tail_log / search_logs / journal_query / process_list / service_status / disk_analysis / network_connections 等（参数自动转义）

**交互式终端** — 多标签 SSH + 本地终端（node-pty / ConPTY）、Ctrl+F 搜索、MobaXterm 风格右键菜单、导出、广播、命令片段库

**文件传输 (SFTP)** — 远程浏览、拖拽上传 / 下载、进度条、可取消、大文件流式

**多主机管理** — SSH 连接池 + 断路器、堡垒机 / 跳板机（forward TCP 转发 / encoded 用户名编码）、agent 转发、主机密钥验证（TOFU）、主机文件夹分组 + 范围内 `@mention`、CSV/TSV 批量导入

**扩展能力** — 技能系统（SKILL.md 渐进式披露，`/skillName` 调用，AI 自助安装）、Hooks（PreToolUse 拦截 / 改写，PostToolUse 追加上下文，command / http 类型）

## 安全模式

| 层级 | 名称 | 行为 |
|------|------|------|
| A | Sentinel | 严格只读，仅查询 / 诊断 |
| B | Operator | 全部允许，写入需逐条确认 |
| C | Autopilot | AI 自主执行，无需确认 |
| D | Plan | 只读规划，批准后切回 Operator |

## 斜杠命令

`/compact [说明]` 压缩 · `/context` 上下文占用分析 · `/cost` 用量与费用 · `/skillName [参数]` 调用技能 · `/quick-command` 命令片段

## 技术栈

Electron 31 · React 18 + TypeScript + Tailwind · Zustand · Vercel AI SDK 4.x · ssh2 · node-pty (ConPTY) · xterm.js 6 · better-sqlite3 (schema v14) · electron-vite + electron-builder · Vitest (900+ 测试)

## 快速开始

```bash
npm install        # 自动重建 better-sqlite3 Electron 原生模块
npm run dev        # 开发模式
npm run typecheck && npm run lint && npm test
npm run dist:win   # 打包 -> dist/OpsAgent-{version}-x64-setup.exe
```

环境：Node.js 18+、npm 9+、Windows 10+。

## Windows 安装包

- **文件**：`OpsAgent-{version}-x64-setup.exe`（NSIS · Windows x64 · 当前 0.1.0 · 约 89 MB），由 `npm run dist:win` 生成于 `dist/`
- **安装**：双击运行 → 选择安装目录（可更改，按用户安装无需管理员）→ 自动创建桌面快捷方式 + 开始菜单「OpsAgent」
- **语言**：中文 / 英文
- **卸载**：系统「设置 - 应用」或安装目录下的卸载程序
- **首次启动**：在「设置」页配置模型与目标主机（见下文「配置」）
- ⚠️ 未代码签名，首次运行 Windows SmartScreen 可能提示「未知发布者」，点击「更多信息 → 仍要运行」即可

## 配置

应用内 **设置** 页：模型（端点 / Key / 模型名 / 单价，可测试连通性）、目标主机（分组 / 批量导入 / 堡垒机 / agent 转发 / 主机密钥）、安全模式、安全规则（编辑 `security-rules.json`）。主机凭据主密钥加密存于本地 SQLite，`master.key` 切勿提交。

## 文档

[PRD](docs/PRD.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [ARCHITECTURE_DETAILED](docs/ARCHITECTURE_DETAILED.md) · [ROADMAP_V2](docs/ROADMAP_V2.md) · [TASKS](docs/TASKS.md) · [SESSION_ACTIONS](docs/SESSION_ACTIONS.md) · [VERIFICATION_TASKS](docs/VERIFICATION_TASKS.md)

## License

MIT
