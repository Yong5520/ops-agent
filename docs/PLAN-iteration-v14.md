# OpsAgent 迭代 v14 — 四项优化执行计划

> 状态：**已实现（2026-07-29，全部 TDD，851 测试通过，typecheck/lint/build 通过）**
> 编写日期：2026-07-29
> 范围：用户提出的 4 项优化/新增需求
> 关联文档：`docs/{PRD,ARCHITECTURE,TASKS,SESSION_ACTIONS}.md`、`.claude/plan/ops-iteration-v3.md`、记忆 `iteration-v14.md`

---

## 0. 需求复述

| # | 需求 | 一句话目标 |
|---|------|-----------|
| 1 | 拦截规则配置文件化 | 当前 10+（实测 27）条**硬编码默认拦截**规则改为可在外部**配置文件**中查看与编辑；配置文件默认仍拦截这些命令，用户可增删 |
| 2 | 设置页支持创建主机文件夹 | 当前仅有 `default` 分组，缺少**主动新建文件夹**的能力 |
| 3 | 任务断点续做 | 任务规划并执行一半后意外中断，重新在会话中“继续”时，应**从中断处续做**，而非从头重新规划（参考 Claude Code 的 TodoWrite 行为） |
| 4 | 误拦截修复 | 4 条诊断命令被误拦截，需放行（见 §3.4） |

> 需求 1 与 4 高度耦合（都作用于“拦截规则”），需联合实施；需求 2、3 相互独立。

---

## 1. 总体结论（TL;DR）

- **需求 4（先做，基础设施）**：根因有二——①`engine.ts:30` 的 `splitCommandChain` **不感知引号**，会把 `grep -E "a|b|c"` 的引号内 `|` 当成管道切开，产生裸 `halt`/`reboot`/`poweroff` 段误命中规则；②`rules.ts:30,35` 系统控制规则用 `(^|\s|;|&&|\|\|)\s*` 前缀，匹配“任意位置、前面是空白”的危险词，无法区分**命令名 vs 参数**（`last reboot` 的 `reboot` 是参数）。修复：复用 classifier 已有的**引号感知** `splitChain`；系统控制规则改为**命令位置感知**。
- **需求 1**：把 `DEFAULT_BLOCKED_RULES`（`rules.ts:6-178`）迁移到 `{userData}/security-rules.json`，首次启动用**工厂默认**（含需求 4 修正后的模式）播种；运行时从文件加载；DB `custom_rules` 保留用于 per-host 覆盖 + UI 增补。Settings 增加“打开文件/重载/恢复默认”入口。
- **需求 2**：新增 `host_groups` 表（migration v12）让**空文件夹可持久化**；`listGroups` 改为 `UNION`；UI 加“新建文件夹”按钮。
- **需求 3**：根因 = `task_lists` 已正确持久化，但 resume 路径（`loadMessages`/`buildSystemPrompt`）**从不回读**。修复 = 在系统提示注入“当前任务列表进度 + 断点续做指令”，并让压缩摘要保留任务状态。

---

## 2. 现状分析与根因（含 file:line 证据）

### 2.1 拦截规则体系（需求 1、4 共用）

- 硬编码默认规则：`src/main/security/rules.ts:6-178` `DEFAULT_BLOCKED_RULES`，共 **27 条**（非 10+），每条 `{ pattern, reason, severity }`，`pattern` 在 `engine.ts:16-22` 编译为 `new RegExp(pattern, 'i')`。
- DB 自定义规则：`custom_rules` 表（`schema.ts:115-122`，列 `type∈('blocked','allowed')`、`pattern`、`reason`、`host_id` nullable FK）；访问层 `src/main/storage/custom-rules.ts:24-93`。`host_id IS NULL` 为全局，否则为 per-host 覆盖。
- 装配：`engine.ts:78-112` `buildEffectiveConfig` 合并 `DEFAULT_BLOCKED_RULES` + DB 全局 blocked + per-host 覆盖；**每次调用重建**（DB 改动即时生效，无需重启）。
- 调用点：`src/main/agent/tools.ts:95` 取 `getEffectiveConfig(safetyMode)`；`tools.ts:173` 在 `preExec` 调 `checkCommandSecurity`，命中即 `BLOCKED` 短路，命令不进 SSH 层。
- **结论**：当前**无任何外部配置文件**承载安全规则；全局默认只在代码里硬编码、DB 里增补。需求 1 要的就是“把硬编码默认搬到一个可手编的文件”。

### 2.2 安全引擎检查流程（需求 4 根因）

`checkCommandSecurity`（`engine.ts:119-195`）四步：
1. **全命令 blocked 检查**（`engine.ts:138-147`）：整条原始串对每条规则 `test`。
2. **分段 blocked 检查**（`engine.ts:150-162`）：`splitCommandChain` 切段后逐段 `test`。
3. **子命令替换递归**（`engine.ts:169-180`）：`extractSubshellCommands` 抽 `$(...)`/`` `...` `` 递归检查。
4. **allowed 降级**（`engine.ts:185-192`）：WRITE 命中 allowed 规则降为 READ。

**根因 A — 分段器不感知引号**（`engine.ts:29-32`）：
```js
const segments = command.split(/\s*(?:;|\|\||&&|\|&|\|)\s*/);
```
纯正则切分，**不跟踪引号状态**。引号内 `grep -E "shutdown|halt|power"` 的 `|` 被误当管道，切成裸 `halt`/`reboot`/`poweroff` 段，恰好命中 blocked 规则。
> 对照：classifier 自己的 `splitChain`（`classifier.ts:321-388`）是**引号感知**的手写字符扫描器（跟踪 `inSingle`/`inDouble`），不会切引号内 `|`。**引擎偏偏没用它，而是另写了一个朴素版。**

**根因 B — 系统控制规则匹配“任意位置的词”**（`rules.ts:30,35`）：
```
(^|\s|;|&&|\|\|)\s*(shutdown|poweroff|halt)\b
(^|\s|;|&&|\|\|)\s*reboot\b
```
前缀集合含 `\s`（空白），于是“前面是空格的危险词”就命中，不区分它是命令名还是参数。`last reboot` 的 `reboot` 是 `last` 的参数（`last reboot` 列历史重启登录记录，并非执行重启），却因前面是空格被命中。

### 2.3 主机文件夹（需求 2）

- “文件夹”=“分组”=`hosts.group_name` 列（`schema.ts:17` `TEXT DEFAULT 'default'`）。**没有独立 folders/groups 表**。
- `default` 是隐式的：列默认值 + UI 兜底（`HostConfigSection.tsx:133`）+ 删除时主机归 `default`（`hosts.ts:195,199`）。
- 已有分组操作：`renameGroup`（`hosts.ts:185-191`）、`deleteGroup`（`hosts.ts:194-203`，拒删 `default`、主机归 `default`）、`listGroups`（`hosts.ts:206-211`，`SELECT DISTINCT group_name`，**只返回有主机的分组**）。**`createGroup` 全链路不存在**。
- 设置页 UI：`src/renderer/pages/Settings/HostConfigSection.tsx`（764 行）。**无“新建文件夹”按钮**；新分组仅靠 `HostForm` 里“分组”自由文本框（`HostConfigSection.tsx:463-469`，非下拉）保存主机时隐式产生。UI 直接调 `window.opsAgent.hosts.renameGroup/deleteGroup`（`HostConfigSection.tsx:113,126`），**绕过** Zustand action。
- **结论**：因分组是“派生值”，**空文件夹无处持久化**——`listGroups` 只列有主机的分组。要支持“主动新建（可能为空）文件夹”，必须给分组一个真实存储。

### 2.4 任务规划与续做（需求 3）

- 任务模型：`task_lists` 表（`schema.ts:126-132`），**每会话一行**，`todos` 为 JSON 数组，`UPSERT`（只存最新快照，`task-lists.ts:8-20`）。`TodoItem`（`shared/types.ts:185-191`）`{ id, subject, description, status: pending|in_progress|completed, activeForm? }`。
- 工具：`todo_write`（`src/main/agent/tools/todo-write.ts`）整表替换、**同步落库**（`todo-write.ts:51`）、推 UI（`onTodosUpdate`→`handlers.ts:323`→`sessionStore.setTodos`）。状态机 pending→in_progress→completed，同一时刻仅一个 in_progress。
- 主循环：`runAgentLoop`（`loop.ts:57`）包 `streamText`（`loop.ts:324-331`，`maxSteps:50`），SDK 内部跑多轮工具循环。
- **根因 — 已持久化但不回读**：
  - `loadMessages`（`context.ts:147-182`）只读 `messages` 表 + 可选摘要，**全程不碰 `task_lists`**。
  - `buildSystemPrompt`（`system-prompt.ts:42-257`）每次重建，含角色/主机/规则等，**从不注入当前 todo 列表**；规则 14（`system-prompt.ts:237`）只要求“用 todo_write”，不展示已有列表。
  - `taskListsStore.get(sessionId)` 全局仅两处调用：`todo-write.ts:42`（校验报错时）、`handlers.ts:654`（给 **UI** 的 `Tasks.list`）。**`loop.ts`/`context.ts`/`system-prompt.ts` 从不调用。**
  - **雪上加霜 — 压缩抹掉痕迹**：`compressContext`（`context.ts:231-304`，阈值 85%）对旧消息做摘要，摘要 prompt（`context.ts:321-340`）保留“命令/发现/错误/决策/当前状态”，**但不保留任务列表状态**。压缩后连消息正文里残留的 `todo_write` 文本也被抹掉，模型彻底失去任务上下文 → 重新规划。
- v12 orphan-task 修复（`message-text.ts` + `loop.ts:672-688,695-711,716-738`）只防止“空白轮被误当作未完成 → 错误续做幽灵任务”，**并不**解决“真实半截任务正确续做”——正是本需求要补的洞。

---

## 3. 方案设计

### 3.1 需求 4 — 误拦截修复（先行，作为需求 1 的播种基础）

**修 A（覆盖 cases 2/3/4）**：让引擎复用 classifier 的引号感知分段器。
- 把 `classifier.ts` 的 `splitChain` 导出（若未导出），在 `engine.ts:150` 用 `splitChain(command)` 替换 `splitCommandChain(command)`。
- `splitCommandChain` 保留为内部兜底或删除（确认无其它引用后）。注意两者对 `|&`、`;`、`&&`、`||` 的切分语义需一致（核对 `classifier.ts:321-388`）。
- 效果：`grep -E "shutdown|halt|power"` 整段不再被切散，裸 `halt` 段消失 → cases 2/3/4 放行。

**修 B（覆盖 case 1 + 一般“参数 vs 命令名”）**：系统控制规则改为命令位置感知。两个方案：

- **方案 B1（推荐先做，轻量）**：收紧前缀，去掉裸 `\s`，并允许 `sudo/nohup/time` 前缀；另补 `systemctl` 包装规则。
  - 新规则（示意）：
    ```
    (^|;|&&|\|\||\|)\s*((sudo|nohup|time)\s+)*(shutdown|poweroff|halt)\b
    (^|;|&&|\|\||\|)\s*((sudo|nohup|time)\s+)*reboot\b
    (^|;|&&|\|\||\|)\s*((sudo|nohup|time)\s+)*init\s+[06]\b
    新增：(^|;|&&|\|\||\|)\s*systemctl\s+(\S+\s+)*(reboot|poweroff)\b
    ```
  - `last reboot`：`reboot` 前是 `last`（非分隔符、非 sudo/nohup/time）→ 不命中 ✓
  - `reboot` / `sudo reboot` / `shutdown -h now` / `systemctl reboot` → 命中 ✓
  - 残留风险：`wall reboot`、其它包装器漏判——可接受，靠后续补规则；真正高危的裸命令已覆盖。
- **方案 B2（稳健，可选增强）**：在 `checkCommandSecurity` 增加“命令 token 提取”——对每个引号感知段，剥离前导 `sudo/nohup/time/env`/环境变量赋值，取首个 token 为命令名，对“命令名类”规则按命令名匹配；结构化规则（`rm /`、`dd of=`）仍按原正则。更彻底但改动更大。

> 决策点见 §7-①：先做 B1 还是直接上 B2。

**测试**：`src/main/security/__tests__/bypass.test.ts` 新增 4 条用例（**必须 ALLOWED**），并新增“真正危险命令仍 BLOCKED”用例：`reboot`、`sudo reboot`、`shutdown -h now`、`systemctl reboot`、`init 6`、`echo "halt" | grep halt`（参数态不误杀）、`grep -E "reboot" /var/log/messages`（引号内不误杀）。

### 3.2 需求 1 — 拦截规则配置文件化

**配置文件**：`{app.getPath('userData')}/security-rules.json`
```json
{
  "version": 1,
  "blockedRules": [
    { "id": "rm-root", "pattern": "...", "reason": "禁止删除根目录", "severity": "critical", "enabled": true }
  ],
  "allowedRules": [ /* 可选 */ ]
}
```
- 新增 `src/main/security/rules-config.ts`：
  - `getRulesFilePath()`、`loadSecurityRulesConfig()`（带格式/字段校验与容错：解析失败或缺失字段时回退工厂默认并记日志）、`seedFactoryDefaults()`（文件不存在时写入工厂默认 = **需求 4 修正后的** `FACTORY_DEFAULT_BLOCKED_RULES`）、`reload()`（清缓存重读）、`resetToFactoryDefaults()`（覆盖写回工厂默认）。
  - 内存缓存 + mtime 校验；`fs.watch` 可选（先做手动 reload）。
- 重构 `engine.ts:78-87` `buildEffectiveConfig`：`blocked` 来源由 `DEFAULT_BLOCKED_RULES` 改为 `loadSecurityRulesConfig()` 返回的 `blockedRules`（过滤 `enabled!==false`）。`DEFAULT_BLOCKED_RULES` 重命名 `FACTORY_DEFAULT_BLOCKED_RULES`，仅用于播种与兜底。DB `custom_rules` 继续作为 per-host 覆盖 + UI 全局增补**叠加**在其上（语义不变）。
- 启动钩子：app ready 时调 `seedFactoryDefaults()`（已有用户首次升级即生成文件，行为与现状一致，无回归）。
- Settings UI 新增“安全规则”区块（`HostConfigSection.tsx` 同级或新 `SecurityRulesSection.tsx`）：显示文件路径 + “打开文件位置”（`shell.openPath`）、“重新加载”、“恢复默认”按钮；可选只读列出当前规则条数/概览。
- IPC（`channels.ts`/`handlers.ts`/`preload-api.ts`/`global.d.ts`/`preload.ts` 五处同步）：`security:openRulesFile`、`security:reloadRules`、`security:resetRules`、`security:listRules`（只读）。

> 决策点见 §7-②③：配置文件 vs 纯 DB UI；是否需要 UI 内置编辑器。

### 3.3 需求 2 — 主机文件夹创建

**新增 `host_groups` 表**（migration v12，`database.ts` 迁移块续编）：
```sql
CREATE TABLE IF NOT EXISTS host_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```
- 迁移时把现有 `SELECT DISTINCT group_name FROM hosts WHERE group_name<>'default'` 播种进 `host_groups`（保证既有分组可被空文件夹语义管理；不播种 `default`，它始终隐式存在）。
- `hosts.ts`：
  - `createGroup(name)`：插入 `host_groups`（`name` 唯一约束兜底重复）；拒绝空名；`default` 视为已存在直接返回。
  - `listGroups()` 改为 `SELECT name FROM host_groups UNION SELECT DISTINCT group_name FROM hosts`（去重，含 `default`）。
  - `deleteGroup(name)`：删 `host_groups` 行 + 主机归 `default`（拒删 `default`）。
  - `renameGroup(old,new)`：改 `hosts.group_name` + 改 `host_groups.name`（事务）。
- IPC + preload 五处同步新增 `hosts:createGroup`。
- `hostStore.ts` 新增 `createGroup` action；`load()` 时可选加载 `groups`（供下拉）。
- `HostConfigSection.tsx`：顶部“批量导入”旁加“+ 新建文件夹”按钮 → 弹窗输名称 → `createGroup` → reload；“分组”输入框可升级为“下拉（已有分组）+ 允许输入新名”组合。

**测试**：`host_groups` CRUD 单测；空文件夹可见；删文件夹主机归 `default`；重命名联动 hosts；`default` 不可删/不可重复创建。

### 3.4 需求 3 — 任务断点续做（对齐 Claude Code）

Claude Code 做法：TodoWrite 持久化于会话状态、**每轮注入**系统上下文、压缩时独立存活、模型被要求“推进而非重建”。本方案据此补齐“回读”半边（持久化半边已就绪）。

- **D1 系统提示注入任务列表**：`buildSystemPrompt` 读取 `taskListsStore.get(sessionId)`，渲染段：
  ```
  ## 当前任务列表进度
  - [x] 已完成项 subject
  - [▶] 进行中项 subject
  - [ ] 待办项 subject
  ```
  需把 `sessionId`（或直接 `todos`）经 `SystemPromptParams` 传入（核对 `system-prompt.ts:42` 当前 params 字段，`loop.ts` 调用处补传）。空列表则省略该段。
- **D2 断点续做指令**：当 todos 非空且含未完成项时，追加：
  > “检测到未完成任务列表。请从第一个未完成（in_progress/pending）项继续；**不要重建列表、不要重做已完成项**；仅用 `todo_write` 推进状态。”
- **D3 压缩后仍注入**：`compressContext`（`context.ts:231-304`）返回的消息序列里，确保任务列表段不受摘要影响——最稳妥是**摘要完成后追加一条独立的 system 消息**承载当前 `task_lists` 快照（任务列表本就独立持久化，天然抗压缩）。同时给 `generateSummary` prompt（`context.ts:321`）补“## 任务列表进度”段作为二级保险。
- **D4 规则强化**：`system-prompt.ts:237` 规则 14 追加“会话恢复时依据上下文中的当前任务列表续做，不得重新规划已完成步骤”。
- **D5 UI 回读**：确认打开会话时 UI 加载持久化 todos（`handlers.ts:654` `Tasks.list` 已存在；核对 `sessionStore` openSession 是否调用并 `setTodos`，缺失则补）。

**测试**：构造 todos（completed+in_progress+pending）→ 新一轮 `runAgentLoop` → 断言系统提示含“当前任务列表进度”段 + 续做指令；触发压缩 → 断言任务列表仍以独立 system 消息注入。

---

## 4. 实施阶段与任务分解

> 排序原则：**A→B**（B 播种需 A 修正后的模式）；C、D 与 A/B 独立，可并行。建议落地顺序 **A → B → D → C**。

### Phase A — 安全引擎误拦截修复（需求 4）·复杂度 中
- A1 `engine.ts` 用 classifier 的 `splitChain` 替换 `splitCommandChain`（核对引号/操作符语义一致）
- A2 系统控制规则命令位置感知（B1 收紧前缀 + 补 `systemctl` 规则；或 B2 token 提取）
- A3 `bypass.test.ts` 增 4 条放行用例 + 危险命令仍拦截用例
- 触点：`src/main/security/{engine.ts,rules.ts,classifier.ts}`、`__tests__/bypass.test.ts`

### Phase B — 拦截规则配置文件化（需求 1）·复杂度 高
- B1 新建 `src/main/security/rules-config.ts`（路径/加载/校验/播种/重载/重置）
- B2 重构 `engine.ts buildEffectiveConfig` 读配置文件；`DEFAULT_BLOCKED_RULES`→`FACTORY_DEFAULT_BLOCKED_RULES`
- B3 app ready 钩子播种；mtime 缓存/重载
- B4 Settings UI“安全规则”区块（路径/打开/重载/恢复默认）
- B5 IPC 五处同步：`security:{openRulesFile,reloadRules,resetRules,listRules}`
- B6 测试：rules-config 加载/容错/播种/重置；engine 用文件规则集成
- 触点：`src/main/security/{rules-config.ts,engine.ts,rules.ts}`、`src/main/{index.ts,ipc/channels.ts,ipc/handlers.ts}`、`src/main/ipc/preload-api.ts`、`src/renderer/types/global.d.ts`、`electron/preload.ts`、`src/renderer/pages/Settings/*`、测试

### Phase C — 主机文件夹创建（需求 2）·复杂度 中
- C1 migration v12 + `host_groups` 表 + 现有分组播种
- C2 `hosts.ts` 增 `createGroup`，改 `listGroups/deleteGroup/renameGroup`
- C3 IPC 五处同步 `hosts:createGroup`
- C4 `hostStore.ts` 增 `createGroup` action
- C5 `HostConfigSection.tsx` “+ 新建文件夹”按钮 + 分组下拉
- C6 测试：`host_groups` CRUD/空文件夹/归 default/重命名联动
- 触点：`src/main/storage/{schema.ts,database.ts,hosts.ts}`、`src/main/ipc/{channels.ts,handlers.ts,preload-api.ts}`、`src/renderer/types/global.d.ts`、`electron/preload.ts`、`src/renderer/store/hostStore.ts`、`src/renderer/pages/Settings/HostConfigSection.tsx`、测试

### Phase D — 任务断点续做（需求 3）·复杂度 中高
- D1 `buildSystemPrompt` 注入“当前任务列表进度”段（`SystemPromptParams` 传 sessionId/todos）
- D2 非空未完成时追加断点续做指令
- D3 `compressContext` 摘要后追加独立 system 消息承载 `task_lists` 快照；`generateSummary` prompt 补任务段
- D4 规则 14 强化续做约束
- D5 核对/补全 openSession 时 UI todos 回读
- D6 测试：续做系统提示注入 + 压缩后仍注入
- 触点：`src/main/agent/{system-prompt.ts,context.ts,loop.ts}`、`src/main/storage/task-lists.ts`、`src/renderer/store/sessionStore.ts`、测试

---

## 5. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| A：换 `splitChain` 后与原 `splitCommandChain` 操作符语义不一致（`|&`/`;`）导致漏拦或过拦 | **高** | 核对 `classifier.ts:321-388`；扩充 `bypass.test.ts` 双向用例（危险必拦、诊断必放） |
| A：B1 收紧前缀漏判包装命令（`wall reboot` 等） | 中 | 补 `systemctl` 规则；高危裸命令已覆盖；保留 B2 作为后续增强 |
| B：用户手编配置文件损坏/误删规则 → 安全防护失效 | **高** | 加载校验 + 字段缺失回退工厂默认 + 日志告警 + UI“恢复默认”；`enabled` 字段支持临时禁用而非删除 |
| B：配置文件（全局默认）与 DB `custom_rules`（全局增补）两套全局来源语义混淆 | 中 | 文档化分层：文件=可手编默认基线，DB=per-host 覆盖 + UI 增补；UI“恢复默认”仅重置文件 |
| C：`host_groups` 与 `hosts.group_name` 双写一致性 | 中 | `listGroups` UNION 保证一致；`rename/delete` 事务联动；迁移播种既有分组 |
| D：每轮注入任务列表增 token 开销 | 低 | 列表通常小；空列表省略段；可设上限截断 |
| D：续做指令依赖模型遵循 | 中 | 规则 14 强化 + 系统提示显式列出已完成项；必要时 UI 展示续做提示 |

---

## 6. 测试计划（vitest，`npm test`）

- **Phase A**：`__tests__/bypass.test.ts` — 4 条误拦截命令 ALLOWED；`reboot/sudo reboot/shutdown -h now/systemctl reboot/init 6` BLOCKED；引号内危险词不误杀。
- **Phase B**：`__tests__/rules-config.test.ts`（新建）— 播种/加载/容错（损坏 JSON 回退）/重置；`engine` 用文件规则集成（含 `enabled:false` 跳过）。
- **Phase C**：`__tests__/host-groups.test.ts`（新建或扩 hosts 测试）— CRUD/空文件夹可见/归 default/重命名联动/`default` 保护。
- **Phase D**：`__tests__/task-resume.test.ts`（新建）— todos 含未完成项 → 系统提示含进度段+续做指令；压缩后任务列表仍注入。
- 全量回归：`npm test`（当前 803 通过，目标新增后全绿）；`npm run typecheck`（双 tsconfig）；`npm run lint`（0 warning）。

---

## 7. 待确认的设计决策（请审批时一并确认）

1. **需求 4 修法**：先做轻量 **B1**（收紧前缀 + 补 `systemctl` 规则），还是直接上稳健 **B2**（命令 token 提取）？→ *推荐先 B1，B2 作后续增强。*
2. **需求 1 载体**：确认采用**外部 JSON 配置文件**（用户明确要“配置文件”），而非纯 DB+UI 管理？→ *推荐配置文件。*
3. **需求 1 UI 编辑能力**：本期仅“打开文件/重载/恢复默认”+只读概览，还是顺带做 UI 内置规则编辑器（启用/禁用/增删）？→ *推荐前者（轻量），编辑器作 Phase 2。*
4. **需求 2 空文件夹持久化**：确认新建 `host_groups` 表（推荐），还是仅 UI 占位（不持久化空文件夹）？→ *推荐建表。*
5. **需求 3 注入位置**：任务列表注入**系统提示**（每轮可见，推荐），还是仅 resume 时注入？→ *推荐系统提示。*

---

## 8. 复杂度与工作量估算

| 阶段 | 复杂度 | 估时 |
|------|--------|------|
| Phase A（误拦截修复） | 中 | 3–5h |
| Phase B（配置文件化） | 高 | 6–9h |
| Phase C（主机文件夹） | 中 | 3–5h |
| Phase D（断点续做） | 中高 | 5–7h |
| 测试 + 联调 + typecheck/lint | — | 3–4h |
| **合计** | — | **20–30h** |

---

## 9. 落地后记忆更新

完成后更新 `MEMORY.md` 与新增 `iteration-v14.md`：记录配置文件路径与格式、`host_groups` 表（schema v12）、系统提示任务列表注入、`splitChain` 复用与规则前缀收紧等关键决策与 file:line。
