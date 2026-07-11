import { useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '../store/agentStore.js';
import { Button } from './Button.js';
import { cn } from '../lib/cn.js';

const TYPE_STYLES: Record<string, string> = {
  READ: 'bg-zinc-800 text-zinc-300',
  WRITE: 'bg-amber-900 text-amber-300',
  SUDO: 'bg-red-900 text-red-300',
  BLOCKED: 'bg-red-950 text-red-400',
};

export function AuthDialog() {
  const { pendingAuths, respondAuth } = useAgentStore();
  const [currentIndex, setCurrentIndex] = useState(0);

  // Clamp current index when pending auths change
  useEffect(() => {
    if (currentIndex >= pendingAuths.length) {
      setCurrentIndex(0);
    }
  }, [pendingAuths.length, currentIndex]);

  const auth = pendingAuths[currentIndex];

  // Batch: approve all READ commands
  // Pass backup: !!a.backupPaths so batch-approved WRITE items still create
  // backups when the AI provided backup_paths. Without this, the 4th argument
  // defaults to undefined and backups are silently skipped for batch approvals.
  const approveAllRead = useCallback(async () => {
    const readAuths = pendingAuths.filter((a) => a.commandType === 'READ');
    await Promise.allSettled(
      readAuths.map((a) => respondAuth(a.toolCallId, true, undefined, !!a.backupPaths)),
    );
  }, [pendingAuths, respondAuth]);

  // Batch: approve all on a specific host
  const approveAllOnHost = useCallback(
    async (hostName: string) => {
      const hostAuths = pendingAuths.filter((a) => a.hostName === hostName);
      await Promise.allSettled(
        hostAuths.map((a) => respondAuth(a.toolCallId, true, undefined, !!a.backupPaths)),
      );
    },
    [pendingAuths, respondAuth],
  );

  // Batch: reject all
  const rejectAll = useCallback(async () => {
    const all = [...pendingAuths];
    await Promise.allSettled(all.map((a) => respondAuth(a.toolCallId, false, '批量拒绝')));
  }, [pendingAuths, respondAuth]);

  // Batch: approve all non-SUDO (SUDO skipped by default)
  const approveAll = useCallback(async () => {
    const hasSudo = pendingAuths.some((a) => a.commandType === 'SUDO');
    // SUDO commands always need individual confirmation - skip them in batch
    const targets = hasSudo
      ? pendingAuths.filter((a) => a.commandType !== 'SUDO')
      : [...pendingAuths];
    await Promise.allSettled(
      targets.map((a) => respondAuth(a.toolCallId, true, undefined, !!a.backupPaths)),
    );
  }, [pendingAuths, respondAuth]);

  // Batch: approve ALL including SUDO (requires explicit confirmation)
  const [showSudoConfirm, setShowSudoConfirm] = useState(false);

  const approveAllIncludingSudo = useCallback(async () => {
    await Promise.allSettled(
      pendingAuths.map((a) => respondAuth(a.toolCallId, true, undefined, !!a.backupPaths)),
    );
    setShowSudoConfirm(false);
  }, [pendingAuths, respondAuth]);

  // Backup checkbox state - only shown when backupPaths is present
  const [backupChecked, setBackupChecked] = useState(true);

  // Reset backup checkbox when switching to a new auth item
  useEffect(() => {
    setBackupChecked(true);
  }, [currentIndex]);

  // Single item actions
  const approve = useCallback(() => {
    if (auth) respondAuth(auth.toolCallId, true, undefined, backupChecked && !!auth.backupPaths);
  }, [auth, respondAuth, backupChecked]);

  const reject = useCallback(() => {
    if (auth) respondAuth(auth.toolCallId, false, '用户拒绝');
  }, [auth, respondAuth]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!auth) return;
    const handler = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case 'y':
          approve();
          break;
        case 'n':
          reject();
          break;
        case 'a':
          if (e.shiftKey) {
            approveAll();
          } else if (auth) {
            approveAllOnHost(auth.hostName);
          }
          break;
        case 'j':
          setCurrentIndex((i) => Math.min(i + 1, pendingAuths.length - 1));
          break;
        case 'k':
          setCurrentIndex((i) => Math.max(i - 1, 0));
          break;
        case 'escape':
          if (showSudoConfirm) {
            setShowSudoConfirm(false);
          } else {
            rejectAll();
          }
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [auth, approve, reject, approveAll, approveAllOnHost, rejectAll, pendingAuths.length, showSudoConfirm]);

  if (!auth) return null;

  const readCount = pendingAuths.filter((a) => a.commandType === 'READ').length;
  const writeCount = pendingAuths.filter((a) => a.commandType === 'WRITE').length;
  const sudoCount = pendingAuths.filter((a) => a.commandType === 'SUDO').length;
  const hasSudo = sudoCount > 0;

  const sudoAuths = pendingAuths.filter((a) => a.commandType === 'SUDO');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        {/* Queue Header with summary counts */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
          <span className="text-lg">⚠</span>
          <h3 className="text-sm font-semibold text-amber-400">授权队列</h3>
          <span className="text-xs text-zinc-500">
            {currentIndex + 1} / {pendingAuths.length} 个待处理
          </span>
          {/* Summary badges */}
          <div className="flex items-center gap-1.5">
            {readCount > 0 && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {readCount} READ
              </span>
            )}
            {writeCount > 0 && (
              <span className="rounded bg-amber-900 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                {writeCount} WRITE
              </span>
            )}
            {sudoCount > 0 && (
              <span className="rounded bg-red-900 px-1.5 py-0.5 font-mono text-[10px] text-red-300">
                {sudoCount} SUDO
              </span>
            )}
          </div>
          <div className="ml-auto flex gap-1.5">
            {readCount > 0 && (
              <Button variant="ghost" onClick={approveAllRead} className="text-xs">
                批准所有 READ
              </Button>
            )}
            <Button variant="danger" onClick={rejectAll} className="text-xs">
              全部拒绝
            </Button>
          </div>
        </div>

        {/* Queue List */}
        {pendingAuths.length > 1 && (
          <div className="max-h-32 overflow-y-auto border-b border-zinc-800 bg-zinc-950/30">
            {pendingAuths.map((item, i) => (
              <button
                key={item.toolCallId}
                onClick={() => setCurrentIndex(i)}
                className={cn(
                  'flex w-full items-center gap-2 px-5 py-1.5 text-left text-xs hover:bg-zinc-800/50',
                  i === currentIndex ? 'bg-zinc-800/70' : '',
                )}
              >
                <span className="text-zinc-600">{i + 1}.</span>
                <span
                  className={cn(
                    'rounded px-1 py-0.5 font-mono text-[10px]',
                    TYPE_STYLES[item.commandType],
                  )}
                >
                  {item.commandType}
                </span>
                <span className="text-zinc-500">@{item.hostName}</span>
                <span className="flex-1 truncate text-zinc-400 font-mono">{item.command}</span>
                {i === currentIndex && <span className="text-blue-400">●</span>}
              </button>
            ))}
          </div>
        )}

        {/* Detail Panel */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-zinc-500">主机：</span>
              <span className="text-zinc-200">{auth.hostName}</span>
              <span className="text-zinc-600"> ({auth.hostIp})</span>
            </div>
            <div>
              <span className="text-zinc-500">安全模式：</span>
              <span className="text-zinc-200">{auth.safetyMode}</span>
            </div>
            <div>
              <span className="text-zinc-500">工具：</span>
              <span className="text-zinc-200">{auth.toolName}</span>
            </div>
            <div>
              <span className="text-zinc-500">命令类型：</span>
              <span
                className={cn(
                  'rounded px-1 py-0.5 font-mono text-[10px]',
                  TYPE_STYLES[auth.commandType],
                )}
              >
                {auth.commandType}
              </span>
            </div>
          </div>

          <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div className="mb-1 text-xs text-zinc-500">计划执行的命令：</div>
            <code className="block text-sm text-zinc-200 font-mono break-all">{auth.command}</code>
          </div>

          {auth.description && (
            <div className="mt-2 text-xs text-zinc-400 italic">{auth.description}</div>
          )}

          {/* Risk hint for SUDO/WRITE */}
          {auth.commandType === 'SUDO' && (
            <div className="mt-2 rounded border border-red-900/50 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">
              ⚠ SUDO 命令以 root 权限执行，请确认命令安全性
            </div>
          )}

          {/* Backup option - only shown when the tool provided backupPaths */}
          {auth.backupPaths && auth.backupPaths.length > 0 && (
            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded border border-blue-900/50 bg-blue-950/20 px-3 py-2">
              <input
                type="checkbox"
                checked={backupChecked}
                onChange={(e) => setBackupChecked(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900"
              />
              <span className="text-xs text-blue-300">
                修改前备份文件
                <span className="ml-1 text-blue-400/60">({auth.backupPaths.join(', ')})</span>
              </span>
            </label>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          <div className="flex gap-1.5">
            <Button
              variant="ghost"
              onClick={() => approveAllOnHost(auth.hostName)}
              className="text-xs"
            >
              批准 @{auth.hostName}
            </Button>
            {hasSudo && (
              <Button
                variant="ghost"
                onClick={() => setShowSudoConfirm(true)}
                className="text-xs text-amber-400"
              >
                批准全部(含 SUDO)
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="danger" onClick={reject}>
              拒绝
              <kbd className="ml-1 text-[10px] text-red-300/60">N</kbd>
            </Button>
            {pendingAuths.length > 1 && (
              <Button variant="secondary" onClick={approveAll}>
                批准全部{hasSudo ? ' (跳过 SUDO)' : ''}
                <kbd className="ml-1 text-[10px] text-zinc-400/60">Shift+A</kbd>
              </Button>
            )}
            <Button variant="primary" onClick={approve}>
              批准
              <kbd className="ml-1 text-[10px] text-blue-300/60">Y</kbd>
            </Button>
          </div>
        </div>

        {/* Keyboard hints */}
        <div className="border-t border-zinc-800/50 bg-zinc-950/30 px-5 py-1.5 text-[10px] text-zinc-600">
          快捷键：<kbd className="text-zinc-500">y</kbd> 批准 ·{' '}
          <kbd className="text-zinc-500">n</kbd> 拒绝 · <kbd className="text-zinc-500">a</kbd>{' '}
          同主机 · <kbd className="text-zinc-500">Shift+A</kbd> 批准全部 ·{' '}
          <kbd className="text-zinc-500">j/k</kbd> 导航 · <kbd className="text-zinc-500">Esc</kbd>{' '}
          全拒
        </div>
      </div>

      {/* SUDO confirmation modal - shown when user clicks "批准全部(含 SUDO)" */}
      {showSudoConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-lg border border-red-800 bg-zinc-900 shadow-xl">
            <div className="border-b border-red-900/50 px-5 py-3">
              <h3 className="text-sm font-semibold text-red-400">⚠ 确认批准所有 SUDO 命令</h3>
            </div>
            <div className="max-h-60 overflow-y-auto px-5 py-3">
              <p className="mb-2 text-xs text-zinc-400">
                以下 {sudoCount} 条 SUDO 命令将以 root 权限执行，请逐一确认：
              </p>
              <div className="space-y-1.5">
                {sudoAuths.map((a, i) => (
                  <div
                    key={a.toolCallId}
                    className="rounded border border-red-900/40 bg-red-950/20 px-3 py-1.5"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-zinc-600">{i + 1}.</span>
                      <span className="text-zinc-500">@{a.hostName}</span>
                    </div>
                    <code className="mt-1 block text-xs text-zinc-200 font-mono break-all">
                      {a.command}
                    </code>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
              <Button variant="ghost" onClick={() => setShowSudoConfirm(false)}>
                取消
              </Button>
              <Button variant="danger" onClick={approveAllIncludingSudo}>
                确认全部批准
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
