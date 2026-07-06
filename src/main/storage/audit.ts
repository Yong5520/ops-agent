import { getDb } from './database.js';
import type { AuditLog, AuditLogInput, AuditFilter } from '../../shared/types.js';

interface AuditRow {
  id: string;
  session_id: string | null;
  host_id: string | null;
  host_name: string;
  host_ip: string;
  safety_mode: string;
  command_type: string;
  command: string;
  description: string | null;
  authorization: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_summary: string | null;
  created_at: string;
}

function rowToLog(row: AuditRow): AuditLog {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    hostId: row.host_id ?? undefined,
    hostName: row.host_name,
    hostIp: row.host_ip,
    safetyMode: row.safety_mode as AuditLog['safetyMode'],
    commandType: row.command_type as AuditLog['commandType'],
    command: row.command,
    description: row.description ?? undefined,
    authorization: row.authorization as AuditLog['authorization'],
    exitCode: row.exit_code ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    createdAt: row.created_at,
  };
}

function buildQuery(filter: AuditFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.hostId) {
    where.push('host_id = ?');
    params.push(filter.hostId);
  }
  if (filter.hostName) {
    where.push('host_name = ?');
    params.push(filter.hostName);
  }
  if (filter.safetyMode) {
    where.push('safety_mode = ?');
    params.push(filter.safetyMode);
  }
  if (filter.commandType) {
    where.push('command_type = ?');
    params.push(filter.commandType);
  }
  if (filter.keyword) {
    where.push('(command LIKE ? OR description LIKE ?)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  if (filter.startTime) {
    where.push('created_at >= ?');
    params.push(filter.startTime);
  }
  if (filter.endTime) {
    where.push('created_at <= ?');
    params.push(filter.endTime);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filter.limit ?? 500;
  const offset = filter.offset ?? 0;
  const sql = `SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return { sql, params };
}

export const auditStore = {
  create(payload: AuditLogInput): AuditLog {
    const db = getDb();
    const row = db
      .prepare(
        `
      INSERT INTO audit_logs (session_id, host_id, host_name, host_ip, safety_mode,
                              command_type, command, description, authorization,
                              exit_code, duration_ms, output_summary)
      VALUES (@sessionId, @hostId, @hostName, @hostIp, @safetyMode,
              @commandType, @command, @description, @authorization,
              @exitCode, @durationMs, @outputSummary)
      RETURNING *
    `,
      )
      .get({
        sessionId: payload.sessionId ?? null,
        hostId: payload.hostId ?? null,
        hostName: payload.hostName,
        hostIp: payload.hostIp,
        safetyMode: payload.safetyMode,
        commandType: payload.commandType,
        command: payload.command,
        description: payload.description ?? null,
        authorization: payload.authorization,
        exitCode: payload.exitCode ?? null,
        durationMs: payload.durationMs ?? null,
        outputSummary: payload.outputSummary ?? null,
      }) as AuditRow;
    return rowToLog(row);
  },

  list(filter: AuditFilter = {}): AuditLog[] {
    const { sql, params } = buildQuery(filter);
    const rows = getDb()
      .prepare(sql)
      .all(...params) as AuditRow[];
    return rows.map(rowToLog);
  },

  count(filter: AuditFilter = {}): number {
    const { sql, params } = buildQuery(filter);
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as cnt');
    const row = getDb()
      .prepare(countSql)
      .get(...params) as { cnt: number };
    return row.cnt;
  },
};
