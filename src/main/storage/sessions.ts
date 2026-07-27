import { getDb } from './database.js';
import { attachmentsStore } from './attachments.js';
import type {
  Session,
  SessionInput,
  Message,
  MessageInput,
  ThinkingBlock,
} from '../../shared/types.js';

interface SessionRow {
  id: string;
  title: string | null;
  host_id: string | null;
  host_ids: string | null;
  safety_mode: string;
  status: string;
  model_provider_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  token_count: number | null;
  thinking_blocks: string | null;
  created_at: string;
}

function parseHostIds(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return parsed.length > 0 ? parsed : undefined;
    }
  } catch {
    // malformed JSON — fall through to undefined
  }
  return undefined;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title ?? undefined,
    hostIds: parseHostIds(row.host_ids),
    safetyMode: row.safety_mode as Session['safetyMode'],
    status: row.status as Session['status'],
    // NULL in DB -> undefined (use the global active default). A stored id
    // is returned verbatim; resolution (does it still exist?) happens in
    // providers.resolveModelProvider at run time.
    modelProviderId: row.model_provider_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Parse the thinking_blocks JSON column. Returns undefined on null/empty/
// malformed so the field is simply absent on the Message (legacy messages).
function parseThinkingBlocks(raw: string | null): ThinkingBlock[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as ThinkingBlock[];
    }
  } catch {
    // malformed JSON - fall through to undefined
  }
  return undefined;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Message['role'],
    content: row.content,
    tokenCount: row.token_count ?? undefined,
    thinkingBlocks: parseThinkingBlocks(row.thinking_blocks),
    createdAt: row.created_at,
  };
}

export const sessionsStore = {
  // ---------- Sessions ----------
  listSessions(): Session[] {
    const rows = getDb()
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all() as SessionRow[];
    return rows.map(rowToSession);
  },

  getSession(id: string): Session | null {
    const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? rowToSession(row) : null;
  },

  createSession(payload: SessionInput): Session {
    const db = getDb();
    const hostIdsJson =
      payload.hostIds && payload.hostIds.length > 0 ? JSON.stringify(payload.hostIds) : null;
    const row = db
      .prepare(
        `
      INSERT INTO sessions (title, host_id, host_ids, safety_mode, status, model_provider_id)
      VALUES (@title, @hostId, @hostIds, @safetyMode, @status, @modelProviderId)
      RETURNING *
    `,
      )
      .get({
        title: payload.title ?? null,
        // Mirror the first host into the legacy host_id column for backward
        // compatibility with older code paths that still read host_id.
        hostId: payload.hostIds?.[0] ?? null,
        hostIds: hostIdsJson,
        safetyMode: payload.safetyMode,
        status: payload.status ?? 'active',
        // New sessions default to the global active model (NULL) unless the
        // caller explicitly sets an override.
        modelProviderId: payload.modelProviderId ?? null,
      }) as SessionRow;
    return rowToSession(row);
  },

  updateSession(id: string, payload: Partial<SessionInput>): Session {
    const db = getDb();
    const existing = this.getSession(id);
    if (!existing) {
      throw new Error(`Session not found: ${id}`);
    }
    const mergedHostIds = payload.hostIds ?? existing.hostIds;
    const hostIdsJson =
      mergedHostIds && mergedHostIds.length > 0 ? JSON.stringify(mergedHostIds) : null;
    // Distinguish "key omitted" (keep existing) from "explicitly provided"
    // (set or clear). null clears the override -> revert to global default.
    // We can't use payload.modelProviderId ?? existing because null (clear)
    // is nullish and would fall through to existing. The `in` check is the
    // only way to tell "clear" apart from "don't touch".
    const modelProviderId =
      'modelProviderId' in payload
        ? (payload.modelProviderId ?? null)
        : (existing.modelProviderId ?? null);
    db.prepare(
      `
      UPDATE sessions
      SET title = @title, host_id = @hostId, host_ids = @hostIds,
          safety_mode = @safetyMode,
          status = @status, model_provider_id = @modelProviderId,
          updated_at = datetime('now')
      WHERE id = @id
    `,
    ).run({
      id,
      title: payload.title ?? existing.title ?? null,
      hostId: mergedHostIds?.[0] ?? null,
      hostIds: hostIdsJson,
      safetyMode: payload.safetyMode ?? existing.safetyMode,
      status: payload.status ?? existing.status,
      modelProviderId,
    });
    return this.getSession(id)!;
  },

  // Read only the per-session model override id for a session. Used by the
  // agent loop's resolveModelProvider so it doesn't need to hydrate the full
  // Session row. Returns undefined when no override is set.
  getModelProviderId(sessionId: string): string | undefined {
    const row = getDb()
      .prepare('SELECT model_provider_id AS id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string | null } | undefined;
    return row?.id ?? undefined;
  },

  deleteSession(id: string): void {
    // Delete in a transaction. audit_logs.session_id lacks ON DELETE CASCADE
    // (legacy schema), so we must manually remove its rows first — otherwise
    // the FOREIGN KEY constraint fails and the session is not deleted.
    // messages and tool_calls have ON DELETE CASCADE but we delete them
    // explicitly too for defense-in-depth across schema versions.
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM audit_logs WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
    tx();
    // Clean up image files on disk now that DB rows are gone.
    attachmentsStore.deleteSessionFiles(id);
  },

  // ---------- Messages ----------
  listMessages(sessionId: string): Message[] {
    const rows = getDb()
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage).map((msg) => ({
      ...msg,
      attachments: attachmentsStore.listByMessage(msg.id),
    }));
  },

  addMessage(payload: MessageInput): Message {
    const db = getDb();
    // Only persist thinking_blocks for assistant messages that have any;
    // NULL otherwise (keeps rows lean for user/system messages).
    const thinkingBlocksJson =
      payload.role === 'assistant' && payload.thinkingBlocks && payload.thinkingBlocks.length > 0
        ? JSON.stringify(payload.thinkingBlocks)
        : null;
    const row = db
      .prepare(
        `
      INSERT INTO messages (session_id, role, content, token_count, thinking_blocks)
      VALUES (@sessionId, @role, @content, @tokenCount, @thinkingBlocks)
      RETURNING *
    `,
      )
      .get({
        sessionId: payload.sessionId,
        role: payload.role,
        content: payload.content,
        tokenCount: payload.tokenCount ?? null,
        thinkingBlocks: thinkingBlocksJson,
      }) as MessageRow;
    // Bump session updatedAt to surface recent sessions in the list.
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(
      payload.sessionId,
    );
    return rowToMessage(row);
  },

  // Delete the given message and every message that came after it in the
  // session. Used by the "re-edit" flow: when a user edits an old user
  // message, we truncate everything that followed and re-send.
  deleteMessagesAfter(sessionId: string, messageId: string): number {
    const db = getDb();
    const anchor = db
      .prepare('SELECT created_at FROM messages WHERE id = ? AND session_id = ?')
      .get(messageId, sessionId) as { created_at: string } | undefined;
    if (!anchor) {
      return 0;
    }
    const info = db
      .prepare(`DELETE FROM messages WHERE session_id = ? AND created_at >= ?`)
      .run(sessionId, anchor.created_at);
    // Bump updatedAt so the session bubbles up in the list.
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);
    return info.changes;
  },
};
