import { useState, useMemo, useRef, useEffect } from 'react';
import { AnsiUp } from 'ansi_up';
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

const ansi = new AnsiUp();
ansi.use_classes = false;

// Initial output limit for performance; "show more" reveals full output.
const INITIAL_OUTPUT_LIMIT = 10_000;

interface CommandCardProps {
  card: ToolCallCardData;
  onReRun?: (command: string, hostName?: string) => void;
}

export function CommandCard({ card, onReRun }: CommandCardProps) {
  const status = STATUS_STYLES[card.status];
  const [expanded, setExpanded] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [copied, setCopied] = useState<'cmd' | 'output' | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hasOutput =
    (card.stdout && card.stdout.length > 0) || (card.stderr && card.stderr.length > 0);
  const rawOutput = card.stderr || card.stdout || '';
  const shouldTruncate = rawOutput.length > INITIAL_OUTPUT_LIMIT;
  const outputText =
    shouldTruncate && !showFull ? rawOutput.slice(0, INITIAL_OUTPUT_LIMIT) : rawOutput;

  // Convert ANSI escapes to HTML. Memoized so it only re-renders when output changes.
  const outputHtml = useMemo(() => {
    if (!outputText) return '';
    try {
      return ansi.ansi_to_html(outputText);
    } catch {
      // If ANSI parsing fails, escape HTML and return plain text
      return outputText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }, [outputText]);

  // Filter lines by search query
  const searchHtml = useMemo(() => {
    if (!searchQuery || !outputHtml) return outputHtml;
    const lines = outputHtml.split('\n');
    const matched = lines.filter((line) => line.toLowerCase().includes(searchQuery.toLowerCase()));
    return matched.join('\n');
  }, [outputHtml, searchQuery]);

  const matchCount = useMemo(() => {
    if (!searchQuery || !outputText) return 0;
    const lower = outputText.toLowerCase();
    const query = searchQuery.toLowerCase();
    let count = 0;
    let idx = lower.indexOf(query);
    while (idx !== -1) {
      count++;
      idx = lower.indexOf(query, idx + query.length);
    }
    return count;
  }, [outputText, searchQuery]);

  // Keyboard shortcut: focus search when "/" pressed
  useEffect(() => {
    if (!searchActive) return;
    searchInputRef.current?.focus();
  }, [searchActive]);

  const handleCopyCommand = async () => {
    if (!card.command) return;
    try {
      await navigator.clipboard.writeText(card.command);
      setCopied('cmd');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Fallback: select text
    }
  };

  const handleCopyOutput = async () => {
    if (!rawOutput) return;
    try {
      await navigator.clipboard.writeText(rawOutput);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Fallback
    }
  };

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

      {/* Command + actions */}
      {card.command && (
        <div className="px-3 py-2 flex items-start gap-2">
          <code className="flex-1 text-xs text-zinc-300 font-mono break-all">{card.command}</code>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleCopyCommand}
              title="复制命令"
              className="text-zinc-600 hover:text-zinc-300 text-xs px-1.5 py-0.5 rounded hover:bg-zinc-800"
            >
              {copied === 'cmd' ? '✓' : '⧉'}
            </button>
            {onReRun && card.status === 'success' && card.command && (
              <button
                onClick={() => onReRun(card.command!, card.hostName)}
                title="重新执行"
                className="text-zinc-600 hover:text-zinc-300 text-xs px-1.5 py-0.5 rounded hover:bg-zinc-800"
              >
                ↻
              </button>
            )}
          </div>
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
          {/* Output toolbar */}
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-950/30">
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              {expanded ? '▼ 收起输出' : '▶ 查看输出'}
              {shouldTruncate && !expanded && ` (${rawOutput.length.toLocaleString()} 字符)`}
            </button>
            <div className="ml-auto flex items-center gap-1">
              {expanded && (
                <>
                  <button
                    onClick={() => setSearchActive(!searchActive)}
                    title="搜索"
                    className={cn(
                      'text-xs px-1.5 py-0.5 rounded hover:bg-zinc-800',
                      searchActive ? 'text-blue-400' : 'text-zinc-600 hover:text-zinc-300',
                    )}
                  >
                    🔍
                  </button>
                  <button
                    onClick={handleCopyOutput}
                    title="复制输出"
                    className="text-zinc-600 hover:text-zinc-300 text-xs px-1.5 py-0.5 rounded hover:bg-zinc-800"
                  >
                    {copied === 'output' ? '✓' : '⧉'}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Search bar */}
          {expanded && searchActive && (
            <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center gap-2">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索输出..."
                className="flex-1 bg-zinc-950 text-xs text-zinc-300 px-2 py-1 rounded border border-zinc-800 focus:border-zinc-600 focus:outline-none"
              />
              {searchQuery && <span className="text-xs text-zinc-600">{matchCount} 处匹配</span>}
            </div>
          )}

          {/* Output content */}
          {expanded && (
            <>
              <pre
                className="max-h-96 overflow-auto px-3 py-2 text-xs text-zinc-400 font-mono bg-zinc-950/50 whitespace-pre-wrap break-all"
                dangerouslySetInnerHTML={{ __html: searchHtml }}
              />
              {shouldTruncate && (
                <button
                  onClick={() => setShowFull(!showFull)}
                  className="w-full px-3 py-1.5 text-center text-xs text-blue-400 hover:text-blue-300 hover:bg-zinc-800/50"
                >
                  {showFull
                    ? '▲ 收起'
                    : `▼ 显示完整输出 (${(rawOutput.length - INITIAL_OUTPUT_LIMIT).toLocaleString()} 更多字符)`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
