import { getDb } from './database.js';
import type { Session, SessionInput, Message, MessageInput } from '../../shared/types.js';

interface SessionRow {
  id: string;
  title: string | null;
  host_id: string | null;
  host_ids: string | null;
  safety_mode: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  token_count: number | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Message['role'],
    content: row.content,
    tokenCount: row.token_count ?? undefined,
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
      INSERT INTO sessions (title, host_id, host_ids, safety_mode, status)
      VALUES (@title, @hostId, @hostIds, @safetyMode, @status)
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
    db.prepare(
      `
      UPDATE sessions
      SET title = @title, host_id = @hostId, host_ids = @hostIds,
          safety_mode = @safetyMode,
          status = @status, updated_at = datetime('now')
      WHERE id = @id
    `,
    ).run({
      id,
      title: payload.title ?? existing.title ?? null,
      hostId: mergedHostIds?.[0] ?? null,
      hostIds: hostIdsJson,
      safetyMode: payload.safetyMode ?? existing.safetyMode,
      status: payload.status ?? existing.status,
    });
    return this.getSession(id)!;
  },

  deleteSession(id: string): void {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  },

  // ---------- Messages ----------
  listMessages(sessionId: string): Message[] {
    const rows = getDb()
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as MessageRow[];
    return rows.map(rowToMessage);
  },

  addMessage(payload: MessageInput): Message {
    const db = getDb();
    const row = db
      .prepare(
        `
      INSERT INTO messages (session_id, role, content, token_count)
      VALUES (@sessionId, @role, @content, @tokenCount)
      RETURNING *
    `,
      )
      .get({
        sessionId: payload.sessionId,
        role: payload.role,
        content: payload.content,
        tokenCount: payload.tokenCount ?? null,
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
