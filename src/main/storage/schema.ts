// Database schema (DDL) for all 8 tables defined in ARCHITECTURE.md section 4.
// Executed in a single transaction during initial migration.

export const SCHEMA_STATEMENTS = `
-- 4.1 主机配置
CREATE TABLE IF NOT EXISTS hosts (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name          TEXT NOT NULL UNIQUE,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 22,
  username      TEXT NOT NULL,
  auth_type     TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password', 'key')),
  password      TEXT,
  key_path      TEXT,
  sudo_password TEXT,
  su_password   TEXT,
  group_name    TEXT DEFAULT 'default',
  timeout_ms    INTEGER NOT NULL DEFAULT 120000,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4.2 模型配置
CREATE TABLE IF NOT EXISTS model_providers (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('anthropic', 'openai', 'openai-compatible')),
  endpoint    TEXT NOT NULL,
  api_key     TEXT NOT NULL,
  model_name  TEXT NOT NULL,
  context_window INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4.3 会话
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title       TEXT,
  host_id     TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  host_ids    TEXT,
  safety_mode TEXT NOT NULL DEFAULT 'operator' CHECK (safety_mode IN ('sentinel', 'operator', 'autopilot', 'plan')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at);

-- 4.4 消息
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  token_count INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- 4.5 工具调用记录
CREATE TABLE IF NOT EXISTS tool_calls (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id      TEXT REFERENCES messages(id),
  tool_name       TEXT NOT NULL,
  host_id         TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  command         TEXT,
  description     TEXT,
  command_type    TEXT NOT NULL DEFAULT 'READ' CHECK (command_type IN ('READ', 'WRITE', 'SUDO', 'BLOCKED')),
  authorization   TEXT NOT NULL DEFAULT 'auto' CHECK (authorization IN ('auto', 'approved', 'rejected', 'blocked')),
  exit_code       INTEGER,
  duration_ms     INTEGER,
  output_summary  TEXT,
  output_full     TEXT,
  blocked_reason  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_host ON tool_calls(host_id, created_at);

-- 4.6 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  host_id         TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  host_name       TEXT NOT NULL,
  host_ip         TEXT NOT NULL,
  safety_mode     TEXT NOT NULL,
  command_type    TEXT NOT NULL,
  command         TEXT NOT NULL,
  description     TEXT,
  authorization   TEXT NOT NULL,
  exit_code       INTEGER,
  duration_ms     INTEGER,
  output_summary  TEXT,
  prev_hash       TEXT NOT NULL DEFAULT '',
  row_hash        TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_host ON audit_logs(host_name, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_logs(command_type);

-- 4.7 应用设置
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4.8 自定义安全规则
CREATE TABLE IF NOT EXISTS custom_rules (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  type        TEXT NOT NULL CHECK (type IN ('blocked', 'allowed')),
  pattern     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  host_id     TEXT REFERENCES hosts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custom_rules_host ON custom_rules(host_id);

-- 4.9 任务列表 (TodoWrite)
CREATE TABLE IF NOT EXISTS task_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  todos       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_lists_session ON task_lists(session_id);

-- 4.10 Hooks (PreToolUse / PostToolUse)
CREATE TABLE IF NOT EXISTS hooks (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name        TEXT NOT NULL,
  event       TEXT NOT NULL CHECK (event IN ('PreToolUse', 'PostToolUse')),
  type        TEXT NOT NULL CHECK (type IN ('command', 'http')),
  config      TEXT NOT NULL,
  condition   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hooks_event ON hooks(event, enabled);
`;
