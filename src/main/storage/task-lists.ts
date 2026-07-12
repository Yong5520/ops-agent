import { getDb } from './database.js';
import type { TodoItem } from '../../shared/types.js';

// Storage layer for task lists (TodoWrite tool).
// Stores per-session todo items as JSON in the task_lists table.

export const taskListsStore = {
  save(sessionId: string, todos: TodoItem[]): void {
    const db = getDb();
    const existing = this.get(sessionId);
    if (existing) {
      db.prepare(
        `UPDATE task_lists SET todos = ?, updated_at = datetime('now') WHERE session_id = ?`,
      ).run(JSON.stringify(todos), sessionId);
    } else {
      db.prepare(
        `INSERT INTO task_lists (session_id, todos) VALUES (?, ?)`,
      ).run(sessionId, JSON.stringify(todos));
    }
  },

  get(sessionId: string): TodoItem[] | null {
    const db = getDb();
    const row = db
      .prepare('SELECT todos FROM task_lists WHERE session_id = ?')
      .get(sessionId) as { todos: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.todos);
      if (Array.isArray(parsed)) return parsed as TodoItem[];
    } catch {
      // malformed JSON
    }
    return null;
  },

  delete(sessionId: string): void {
    const db = getDb();
    db.prepare('DELETE FROM task_lists WHERE session_id = ?').run(sessionId);
  },
};
