import { useEffect, useState, useCallback, useRef } from 'react';
import { Button } from '../../components/Button.js';
import { cn } from '../../lib/cn.js';

interface SftpDirEntry {
  name: string;
  longname: string;
  isDirectory: boolean;
  size: number;
  modifyTime: number;
}

interface FileTransferPanelProps {
  hostId: string;
  hostName: string;
  onClose: () => void;
}

type TransferState = 'idle' | 'transferring' | 'done' | 'error';

interface TransferInfo {
  state: TransferState;
  message: string;
  fileName?: string;
  progress?: { transferred: number; total: number };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

export function FileTransferPanel({ hostId, hostName, onClose }: FileTransferPanelProps) {
  const [remotePath, setRemotePath] = useState('');
  const [entries, setEntries] = useState<SftpDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferInfo>({ state: 'idle', message: '' });
  const [history, setHistory] = useState<string[]>([]);
  const progressCleanupRef = useRef<(() => void) | null>(null);
  const transferIdRef = useRef<string | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      if (!path) return;
      setLoading(true);
      setError(null);
      try {
        const result = await window.opsAgent.sftp.list(hostId, path);
        const sorted = [...result].sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
        setRemotePath(path);
      } catch (err) {
        setError((err as Error).message);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [hostId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = await window.opsAgent.sftp.realpath(hostId);
        if (!cancelled) {
          setRemotePath(home);
          loadDir(home);
        }
      } catch {
        if (!cancelled) {
          const fallback = '/';
          setRemotePath(fallback);
          loadDir(fallback);
        }
      }
    })();
    return () => {
      cancelled = true;
      // Clean up progress listener on unmount
      progressCleanupRef.current?.();
    };
  }, [hostId, loadDir]);

  const navigateTo = (path: string) => {
    setHistory((h) => [...h, remotePath]);
    loadDir(path);
  };

  const goBack = () => {
    if (history.length > 0) {
      const prev = history[history.length - 1];
      setHistory((h) => h.slice(0, -1));
      loadDir(prev);
    }
  };

  const goToHome = async () => {
    try {
      const home = await window.opsAgent.sftp.realpath(hostId);
      setHistory([]);
      loadDir(home);
    } catch {
      // ignore
    }
  };

  const handleEntryClick = (entry: SftpDirEntry) => {
    if (entry.isDirectory) {
      navigateTo(joinPath(remotePath, entry.name));
    }
  };

  // Subscribe to progress events during transfer
  const startProgressListener = (direction: 'upload' | 'download', fileName: string) => {
    progressCleanupRef.current?.();
    progressCleanupRef.current = window.opsAgent.sftp.onProgress((event) => {
      if (event.hostId === hostId && event.direction === direction) {
        setTransfer({
          state: 'transferring',
          message: `${direction === 'download' ? '下载' : '上传'} ${fileName}...`,
          fileName,
          progress: { transferred: event.transferred, total: event.total },
        });
      }
    });
  };

  const stopProgressListener = () => {
    progressCleanupRef.current?.();
    progressCleanupRef.current = null;
  };

  const handleCancel = async () => {
    if (transferIdRef.current) {
      await window.opsAgent.sftp.cancel(transferIdRef.current);
      transferIdRef.current = null;
    }
    stopProgressListener();
    setTransfer({ state: 'error', message: '传输已取消' });
  };

  const handleUpload = async () => {
    const localPath = await window.opsAgent.dialog.openFile();
    if (!localPath) return;

    const fileName = localPath.split(/[\\/]/).pop() || 'upload';
    const remoteFilePath = joinPath(remotePath, fileName);
    const transferId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    transferIdRef.current = transferId;

    startProgressListener('upload', fileName);
    setTransfer({
      state: 'transferring',
      message: `上传 ${fileName}...`,
      fileName,
      progress: { transferred: 0, total: 0 },
    });
    try {
      const result = await window.opsAgent.sftp.upload(
        hostId,
        localPath,
        remoteFilePath,
        transferId,
      );
      transferIdRef.current = null;
      stopProgressListener();
      setTransfer({
        state: 'done',
        message: `上传完成: ${formatSize(result.bytesTransferred)}`,
        fileName,
      });
      loadDir(remotePath);
    } catch (err) {
      transferIdRef.current = null;
      stopProgressListener();
      setTransfer({ state: 'error', message: `上传失败: ${(err as Error).message}` });
    }
  };

  const handleDownload = async (entry: SftpDirEntry) => {
    if (entry.isDirectory) return;

    const remoteFilePath = joinPath(remotePath, entry.name);
    const localPath = await window.opsAgent.dialog.saveFile(entry.name, `下载 ${entry.name}`);
    if (!localPath) return;

    const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    transferIdRef.current = transferId;

    startProgressListener('download', entry.name);
    setTransfer({
      state: 'transferring',
      message: `下载 ${entry.name}...`,
      fileName: entry.name,
      progress: { transferred: 0, total: 0 },
    });
    try {
      const result = await window.opsAgent.sftp.download(
        hostId,
        remoteFilePath,
        localPath,
        transferId,
      );
      transferIdRef.current = null;
      stopProgressListener();
      setTransfer({
        state: 'done',
        message: `下载完成: ${formatSize(result.bytesTransferred)} -> ${localPath}`,
        fileName: entry.name,
      });
    } catch (err) {
      transferIdRef.current = null;
      stopProgressListener();
      setTransfer({ state: 'error', message: `下载失败: ${(err as Error).message}` });
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) {
        setTransfer({
          state: 'error',
          message: `无法获取 ${file.name} 的路径，请使用上传按钮`,
        });
        continue;
      }
      const remoteFilePath = joinPath(remotePath, file.name);
      const transferId = `drop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      transferIdRef.current = transferId;
      startProgressListener('upload', file.name);
      setTransfer({
        state: 'transferring',
        message: `上传 ${file.name}...`,
        fileName: file.name,
        progress: { transferred: 0, total: 0 },
      });
      try {
        await window.opsAgent.sftp.upload(hostId, filePath, remoteFilePath, transferId);
        transferIdRef.current = null;
        stopProgressListener();
        setTransfer({ state: 'done', message: `上传完成: ${file.name}`, fileName: file.name });
      } catch (err) {
        transferIdRef.current = null;
        stopProgressListener();
        setTransfer({ state: 'error', message: `上传失败: ${(err as Error).message}` });
      }
    }
    loadDir(remotePath);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const progressPct =
    transfer.progress && transfer.progress.total > 0
      ? Math.min(100, (transfer.progress.transferred / transfer.progress.total) * 100)
      : 0;

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">文件传输</span>
          <span className="text-xs text-zinc-500">{hostName}</span>
        </div>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" title="关闭">
          ×
        </button>
      </div>

      {/* Path navigation */}
      <div className="flex items-center gap-1 border-b border-zinc-800 px-3 py-2">
        <button
          onClick={goBack}
          disabled={history.length === 0}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
          title="返回上级"
        >
          ←
        </button>
        <button
          onClick={() => {
            const parent = remotePath.split('/').slice(0, -1).join('/') || '/';
            navigateTo(parent);
          }}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          title="上级目录"
        >
          ↑
        </button>
        <button
          onClick={goToHome}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          title="主目录"
        >
          🏠
        </button>
        <input
          type="text"
          value={remotePath}
          onChange={(e) => setRemotePath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') loadDir(remotePath);
          }}
          className="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          placeholder="/remote/path"
        />
        <Button variant="ghost" size="sm" onClick={() => loadDir(remotePath)}>
          刷新
        </Button>
      </div>

      {/* File list */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            加载中...
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="px-4 text-center text-xs text-red-400">{error}</p>
            <Button variant="ghost" size="sm" onClick={goToHome}>
              回到主目录
            </Button>
            <Button variant="ghost" size="sm" onClick={() => loadDir(remotePath)}>
              重试
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            空目录 · 拖拽文件至此上传
          </div>
        ) : (
          <div className="flex flex-col">
            {entries.map((entry, i) => (
              <div
                key={i}
                onClick={() => handleEntryClick(entry)}
                className={cn(
                  'group flex cursor-pointer items-center gap-2 border-b border-zinc-900 px-3 py-1.5 hover:bg-zinc-900',
                  entry.isDirectory ? 'text-blue-400' : 'text-zinc-300',
                )}
              >
                <span className="shrink-0">{entry.isDirectory ? '📁' : '📄'}</span>
                <span className="min-w-0 flex-1 truncate text-xs" title={entry.name}>
                  {entry.name}
                </span>
                <span
                  className="shrink-0 text-right text-[10px] text-zinc-500"
                  style={{ minWidth: '60px' }}
                >
                  {entry.isDirectory ? '-' : formatSize(entry.size)}
                </span>
                <span
                  className="shrink-0 text-right text-[10px] text-zinc-600"
                  style={{ minWidth: '70px' }}
                >
                  {formatTime(entry.modifyTime)}
                </span>
                {!entry.isDirectory && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload(entry);
                    }}
                    className="shrink-0 text-zinc-500 opacity-0 transition-opacity hover:text-zinc-200 group-hover:opacity-100"
                    title="下载"
                  >
                    ⬇
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transfer status + progress + upload button */}
      <div className="border-t border-zinc-800 px-3 py-2">
        {/* Progress bar (only when transferring) */}
        {transfer.state === 'transferring' && transfer.progress && (
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-500">
              <span>
                {transfer.progress.total > 0
                  ? `${formatSize(transfer.progress.transferred)} / ${formatSize(transfer.progress.total)}`
                  : `${formatSize(transfer.progress.transferred)}`}
              </span>
              <span>{progressPct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-xs">
            {transfer.state === 'idle' && (
              <span className="text-zinc-600">就绪 · 拖拽文件上传</span>
            )}
            {transfer.state === 'transferring' && (
              <span className="text-amber-400">{transfer.message}</span>
            )}
            {transfer.state === 'done' && (
              <span className="text-emerald-400">{transfer.message}</span>
            )}
            {transfer.state === 'error' && <span className="text-red-400">{transfer.message}</span>}
          </div>
          {transfer.state === 'transferring' ? (
            <Button variant="danger" size="sm" onClick={handleCancel}>
              取消
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={handleUpload}>
              ⬆ 上传
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
