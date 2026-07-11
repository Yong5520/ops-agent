import { createWriteStream, createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { PassThrough } from 'node:stream';
import { OpsAgentError } from './connection.js';
import type { SSHConnectionManager } from './connection.js';
import type { SFTPWrapper } from 'ssh2';
import type { ConnectionPool } from './pool.js';

// SFTP operations — extracted from ssh-mcp-multi getSftp (lines 575-583) plus
// the read-file / write-file / upload / download MCP tool implementations.

// Open an SFTP session over the existing SSH connection.
export async function getSftp(manager: SSHConnectionManager): Promise<SFTPWrapper> {
  await manager.ensureConnected();
  const conn = manager.getConnection();
  return new Promise<SFTPWrapper>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        reject(new OpsAgentError(`SFTP error: ${err.message}`, 'SSH_ERROR'));
      } else {
        resolve(sftp);
      }
    });
  });
}

// ── read_file ─────────────────────────────────────────────────────────────

export interface ReadFileOptions {
  encoding?: 'utf8' | 'base64';
  offset?: number; // 1-based line number to start from (utf8 only)
  limit?: number; // max lines to read (utf8 only)
}

export interface ReadFileResult {
  content: string;
  encoding: 'utf8' | 'base64';
  truncated: boolean;
  totalLines?: number;
}

// Read a remote file. For utf8, supports line offset/limit pagination.
// For base64 (binary), reads the entire file.
export async function readFile(
  manager: SSHConnectionManager,
  remotePath: string,
  options: ReadFileOptions = {},
): Promise<ReadFileResult> {
  const sftp = await getSftp(manager);
  const encoding = options.encoding ?? 'utf8';
  const offset = options.offset ?? 1;
  const limit = options.limit ?? 1000;

  if (encoding === 'base64') {
    return readBase64(sftp, remotePath, manager);
  }

  return readUtf8(sftp, remotePath, offset, limit, manager);
}

function readBase64(
  sftp: SFTPWrapper,
  remotePath: string,
  manager: SSHConnectionManager,
): Promise<ReadFileResult> {
  return new Promise<ReadFileResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(remotePath);
    let isResolved = false;
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        stream.destroy();
        reject(new OpsAgentError(`Read timed out after ${manager.timeout}ms`, 'SSH_TIMEOUT'));
      }
    }, manager.timeout);

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = () => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      resolve({
        content: Buffer.concat(chunks).toString('base64'),
        encoding: 'base64',
        truncated: false,
      });
    };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      reject(new OpsAgentError(`Read failed: ${err.message}`, 'SSH_ERROR'));
    });
  });
}

function readUtf8(
  sftp: SFTPWrapper,
  remotePath: string,
  offset: number,
  limit: number,
  manager: SSHConnectionManager,
): Promise<ReadFileResult> {
  return new Promise<ReadFileResult>((resolve, reject) => {
    let buffer = '';
    const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
    let isResolved = false;
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        stream.destroy();
        reject(new OpsAgentError(`Read timed out after ${manager.timeout}ms`, 'SSH_TIMEOUT'));
      }
    }, manager.timeout);

    stream.on('data', (chunk: string) => {
      buffer += chunk;
    });
    const done = () => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      const lines = buffer.split('\n');
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const selected = lines.slice(start, end).join('\n');
      resolve({
        content: selected,
        encoding: 'utf8',
        truncated: end < lines.length,
        totalLines: lines.length,
      });
    };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      reject(new OpsAgentError(`Read failed: ${err.message}`, 'SSH_ERROR'));
    });
  });
}

// ── write_file ────────────────────────────────────────────────────────────

export interface WriteFileResult {
  bytesWritten: number;
  remotePath: string;
}

// Write content to a remote file (overwrites if exists).
export async function writeFile(
  manager: SSHConnectionManager,
  remotePath: string,
  content: string,
): Promise<WriteFileResult> {
  const sftp = await getSftp(manager);
  return new Promise<WriteFileResult>((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    let isResolved = false;
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        stream.destroy();
        reject(new OpsAgentError(`Write timed out after ${manager.timeout}ms`, 'SSH_TIMEOUT'));
      }
    }, manager.timeout);

    stream.on('error', (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      reject(new OpsAgentError(`Write failed: ${err.message}`, 'SSH_ERROR'));
    });
    stream.on('close', () => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutId);
      resolve({ bytesWritten: Buffer.byteLength(content), remotePath });
    });
    stream.end(content);
  });
}

// ── upload / download ─────────────────────────────────────────────────────

export interface TransferResult {
  bytesTransferred: number;
  remotePath: string;
  localPath: string;
}

// Activity-based timeout: resets on each data chunk. Only fires when no data
// flows for STALL_TIMEOUT ms (truly stalled connection).
const STALL_TIMEOUT = 30_000;

// Progress callback type: (bytesTransferred, totalBytes) => void
export type ProgressCallback = (transferred: number, total: number) => void;

// Transfer options: AbortSignal for cancellation, ConnectionPool for keepalive.
export interface TransferOptions {
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  pool?: ConnectionPool;
  hostId?: string;
}

// Helper: set up abort signal listener that destroys streams on cancel
function setupAbort(signal: AbortSignal | undefined, destroy: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    destroy();
    return () => {};
  }
  const onAbort = () => destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

// Upload a local file to the remote host via SFTP streaming.
// Supports cancellation via AbortSignal and keeps the SSH connection alive
// during long transfers by marking the pool active on each chunk.
export async function uploadFile(
  manager: SSHConnectionManager,
  localPath: string,
  remotePath: string,
  options?: TransferOptions,
): Promise<TransferResult> {
  if (!existsSync(localPath)) {
    throw new OpsAgentError(`Local file not found: ${localPath}`, 'INVALID_PARAMS');
  }
  const fileSize = statSync(localPath).size;
  const sftp = await getSftp(manager);

  let bytesTransferred = 0;
  let stallTimer: NodeJS.Timeout | null = null;
  let readStream: ReturnType<typeof createReadStream> | null = null;
  let writeStream: ReturnType<typeof sftp.createWriteStream> | null = null;

  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      readStream?.destroy();
      writeStream?.destroy();
    }, STALL_TIMEOUT);
  };

  if (options?.signal?.aborted) {
    throw new OpsAgentError('Upload cancelled', 'SSH_ERROR');
  }
  const cleanupAbort = setupAbort(options?.signal, () => {
    readStream?.destroy();
    writeStream?.destroy();
  });

  try {
    readStream = createReadStream(localPath);
    writeStream = sftp.createWriteStream(remotePath);
    resetStallTimer();

    readStream.on('data', (chunk: Buffer | string) => {
      bytesTransferred += Buffer.byteLength(chunk);
      resetStallTimer();
      if (options?.pool && options?.hostId) {
        options.pool.markActive(options.hostId);
      }
      options?.onProgress?.(bytesTransferred, fileSize);
    });

    await pipeline(readStream, writeStream as unknown as PassThrough);

    if (stallTimer) clearTimeout(stallTimer);
    cleanupAbort();
    return { bytesTransferred, remotePath, localPath };
  } catch (err) {
    if (stallTimer) clearTimeout(stallTimer);
    readStream?.destroy();
    writeStream?.destroy();
    cleanupAbort();
    if (err instanceof OpsAgentError) throw err;
    const errorMsg = (err as Error).message;
    throw new OpsAgentError(`Upload failed: ${errorMsg}`, 'SSH_ERROR');
  }
}

// Download a remote file to local via SFTP streaming.
// Supports cancellation via AbortSignal and keeps the SSH connection alive.
export async function downloadFile(
  manager: SSHConnectionManager,
  remotePath: string,
  localPath: string,
  options?: TransferOptions,
): Promise<TransferResult> {
  mkdirSync(dirname(localPath), { recursive: true });
  const sftp = await getSftp(manager);

  // Get remote file size for progress calculation
  let fileSize = 0;
  try {
    const stat = await new Promise<{ size: number }>((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          reject(new OpsAgentError(`stat failed: ${err.message}`, 'SSH_ERROR'));
        } else {
          resolve({ size: stats.size });
        }
      });
    });
    fileSize = stat.size;
  } catch {
    // If stat fails, proceed with unknown size
  }

  let bytesTransferred = 0;
  let stallTimer: NodeJS.Timeout | null = null;
  let readStream: ReturnType<typeof sftp.createReadStream> | null = null;
  let writeStream: ReturnType<typeof createWriteStream> | null = null;

  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      readStream?.destroy();
      writeStream?.destroy();
    }, STALL_TIMEOUT);
  };

  if (options?.signal?.aborted) {
    throw new OpsAgentError('Download cancelled', 'SSH_ERROR');
  }
  const cleanupAbort = setupAbort(options?.signal, () => {
    readStream?.destroy();
    writeStream?.destroy();
  });

  try {
    readStream = sftp.createReadStream(remotePath);
    writeStream = createWriteStream(localPath);
    resetStallTimer();

    readStream.on('data', (chunk: Buffer | string) => {
      bytesTransferred += Buffer.byteLength(chunk);
      resetStallTimer();
      if (options?.pool && options?.hostId) {
        options.pool.markActive(options.hostId);
      }
      options?.onProgress?.(bytesTransferred, fileSize);
    });

    await pipeline(readStream as unknown as PassThrough, writeStream);

    if (stallTimer) clearTimeout(stallTimer);
    cleanupAbort();
    if (fileSize === 0 && existsSync(localPath)) {
      fileSize = statSync(localPath).size;
    }
    return { bytesTransferred: fileSize, remotePath, localPath };
  } catch (err) {
    if (stallTimer) clearTimeout(stallTimer);
    readStream?.destroy();
    writeStream?.destroy();
    cleanupAbort();
    if (err instanceof OpsAgentError) throw err;
    const errorMsg = (err as Error).message;
    throw new OpsAgentError(`Download failed: ${errorMsg}`, 'SSH_ERROR');
  }
}

// ── list_dir (bonus utility) ──────────────────────────────────────────────

export interface DirEntry {
  name: string;
  longname: string;
  isDirectory: boolean;
  size: number;
  modifyTime: number;
}

export async function listDir(
  manager: SSHConnectionManager,
  remotePath: string,
): Promise<DirEntry[]> {
  const sftp = await getSftp(manager);
  return new Promise<DirEntry[]>((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        reject(new OpsAgentError(`readdir failed: ${err.message}`, 'SSH_ERROR'));
        return;
      }
      resolve(
        list.map((entry) => ({
          name: entry.filename,
          longname: entry.longname,
          isDirectory:
            (entry.attrs as unknown as { isDirectory?: () => boolean }).isDirectory?.() ?? false,
          size: entry.attrs.size,
          modifyTime: entry.attrs.mtime * 1000,
        })),
      );
    });
  });
}
