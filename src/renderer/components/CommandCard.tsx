import { useState } from 'react';
import type { ToolCallCard as ToolCallCardData } from '../store/agentStore.js';
import { cn } from '../lib/cn.js';

const STATUS_STYLES: Record<ToolCallCardData['status'], { label: string; color: string }> = {
  pending: { label: '等待中', color: 'text-zinc-400' },
  executing: { label: '执行中', color: 'text-blue-400' },
  'awaiting-approval': { label: '等待授权', color: 'text-amber-400' },
  success: { label: '成功', color: 'text-emerald-400' },
  failed: { label: '失败', color: 'text-red-400' },
  blocked: { label: '已拦截', color: 'text-red-500' },
};

const TYPE_STYLES: Record<string, string> = {
  READ: 'bg-zinc-800 text-zinc-300',
  WRITE: 'bg-amber-900 text-amber-300',
  SUDO: 'bg-red-900 text-red-300',
  BLOCKED: 'bg-red-950 text-red-400',
};

export function CommandCard({ card }: { card: ToolCallCardData }) {
  const status = STATUS_STYLES[card.status];
  const [expanded, setExpanded] = useState(false);

  const hasOutput =
    (card.stdout && card.stdout.length > 0) || (card.stderr && card.stderr.length > 0);
  const output = card.stderr || card.stdout || '';
  const shouldTruncate = output.length > 500;

  return (
    <div className="my-2 rounded-md border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span
          className={cn('rounded px-1.5 py-0.5 text-xs font-mono', TYPE_STYLES[card.commandType])}
        >
          {card.commandType}
        </span>
        <span className="text-xs text-zinc-500">{card.toolName}</span>
        {card.hostName && <span className="text-xs text-zinc-600">@{card.hostName}</span>}
        <span className="ml-auto flex items-center gap-2">
          {card.durationMs != null && (
            <span className="text-xs text-zinc-600">{card.durationMs}ms</span>
          )}
          {card.exitCode != null && (
            <span
              className={cn(
                'text-xs font-mono',
                card.exitCode === 0 ? 'text-emerald-400' : 'text-red-400',
              )}
            >
              ↩ {card.exitCode}
            </span>
          )}
          <span className={cn('text-xs font-medium', status.color)}>● {status.label}</span>
        </span>
      </div>

      {/* Command */}
      {card.command && (
        <div className="px-3 py-2">
          <code className="text-xs text-zinc-300 font-mono break-all">{card.command}</code>
        </div>
      )}

      {/* Description */}
      {card.description && (
        <div className="px-3 pb-2 text-xs text-zinc-500 italic">{card.description}</div>
      )}

      {/* Blocked reason */}
      {card.blockedReason && (
        <div className="px-3 pb-2 text-xs text-red-400">⚠ {card.blockedReason}</div>
      )}

      {/* Output */}
      {hasOutput && (
        <div className="border-t border-zinc-800">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full px-3 py-1.5 text-left text-xs text-zinc-500 hover:text-zinc-300"
          >
            {expanded ? '▼ 收起输出' : '▶ 查看输出'}
            {shouldTruncate && !expanded && ` (${output.length} 字符)`}
          </button>
          {expanded && (
            <pre className="max-h-80 overflow-auto px-3 py-2 text-xs text-zinc-400 font-mono bg-zinc-950/50">
              {card.stderr ? <span className="text-red-400">{card.stderr}</span> : card.stdout}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
