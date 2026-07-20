import { app } from 'electron';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { getDb } from './database.js';
import { logger } from '../utils/logger.js';
import type { MessageAttachment } from '../../shared/types.js';

// Attachment file storage layer.
// Images are stored on disk under %APPDATA%/ops-agent/attachments/{sessionId}/{filename}
// and referenced by the message_attachments table. This keeps large blobs out of SQLite.

function attachmentsRoot(): string {
  return join(app.getPath('userData'), 'attachments');
}

function attachmentFullPath(filePath: string): string {
  // filePath is relative: {sessionId}/{filename}. Join with root.
  // Normalize to prevent path traversal - resolve then verify it's under root.
  const root = attachmentsRoot();
  const full = join(root, filePath);
  return full;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  session_id: string;
  type: string;
  file_path: string;
  mime_type: string;
  original_name: string | null;
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

function rowToAttachment(row: AttachmentRow): MessageAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    sessionId: row.session_id,
    type: row.type as 'image',
    filePath: row.file_path,
    mimeType: row.mime_type,
    originalName: row.original_name ?? undefined,
    sizeBytes: row.size_bytes,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    createdAt: row.created_at,
  };
}

export interface SaveAttachmentInput {
  messageId: string;
  sessionId: string;
  data: string; // base64 data URL: data:image/png;base64,xxxx
  mimeType: string;
  originalName?: string;
}

// Parse a base64 data URL into a Buffer and mime type.
function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL format. Expected: data:<mime>;base64,<data>');
  }
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  return { buffer, mimeType };
}

export const attachmentsStore = {
  // Save an image attachment to disk + DB.
  save(input: SaveAttachmentInput): MessageAttachment {
    const { buffer, mimeType: parsedMime } = parseDataUrl(input.data);
    const mimeType = input.mimeType || parsedMime;

    // Generate filename: {messageId}-{timestamp}.{ext}
    const ext = mimeToExtension(mimeType);
    const filename = `${input.messageId}-${Date.now()}.${ext}`;
    const relativePath = join(input.sessionId, filename);
    const fullPath = attachmentFullPath(relativePath);

    // Ensure parent dir exists
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, buffer);

    const db = getDb();
    const row = db
      .prepare(
        `
      INSERT INTO message_attachments
        (message_id, session_id, type, file_path, mime_type, original_name, size_bytes)
      VALUES
        (@messageId, @sessionId, 'image', @filePath, @mimeType, @originalName, @sizeBytes)
      RETURNING *
    `,
      )
      .get({
        messageId: input.messageId,
        sessionId: input.sessionId,
        filePath: relativePath,
        mimeType,
        originalName: input.originalName ?? null,
        sizeBytes: buffer.length,
      }) as AttachmentRow;

    return rowToAttachment(row);
  },

  // List all attachments for a given message.
  listByMessage(messageId: string): MessageAttachment[] {
    const rows = getDb()
      .prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC')
      .all(messageId) as AttachmentRow[];
    return rows.map(rowToAttachment);
  },

  // Read attachment file as a Buffer (for sending to AI model or renderer).
  readData(filePath: string): Buffer {
    const fullPath = attachmentFullPath(filePath);
    return readFileSync(fullPath);
  },

  // Read attachment as base64 data URL (for IPC to renderer).
  readAsDataUrl(filePath: string, mimeType: string): string {
    const buffer = this.readData(filePath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  },

  // Delete all attachment files for a session (called on session deletion).
  deleteSessionFiles(sessionId: string): void {
    try {
      const sessionDir = join(attachmentsRoot(), sessionId);
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn(`[Attachments] Failed to clean up files for session ${sessionId}:`, err);
    }
  },
};

function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[mimeType.toLowerCase()] ?? 'png';
}
