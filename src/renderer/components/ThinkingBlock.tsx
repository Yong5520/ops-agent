import { useState, memo } from 'react';
import type { ToolCallCard } from '../store/agentStore.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { CommandCard } from './CommandCard.js';
import { formatDuration } from '../lib/collapse-tool-groups.js';

// A single collapsible thinking/reasoning block, rendered like Claude Code's
// "思考 6m 17s · 搜索了 2 个模式" cards. The optional `summary` is the
// collapsed read/search tool activity that followed this thought, and
// `absorbedTools` are those tool cards - shown inside the expanded body so the
// read details stay accessible without cluttering the chat.
interface ThinkingBlockProps {
  content: string;
  durationMs?: number;
  streaming: boolean; // true while the block is still receiving deltas
  summary?: string;
  absorbedTools?: ToolCallCard[];
}

export const ThinkingBlock = memo(function ThinkingBlock({
  content,
  durationMs,
  streaming,
  summary,
  absorbedTools,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatDuration(durationMs);

  return (
    <div className="my-1 rounded-md border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200"
      >
        <span className="text-[10px] select-none">{expanded ? '▼' : '▶'}</span>
        <span className="italic">
          {streaming ? (
            <span className="inline-flex items-center gap-1">
              <span className="animate-pulse">思考中</span>
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-zinc-500" />
            </span>
          ) : (
            <span>思考{duration ? ` ${duration}` : ''}</span>
          )}
        </span>
        {summary && <span className="text-zinc-500"> · {summary}</span>}
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <div className="text-xs text-zinc-400 italic opacity-90">
            <MarkdownRenderer content={content} />
          </div>
          {absorbedTools && absorbedTools.length > 0 && (
            <div className="mt-2 space-y-1">
              {absorbedTools.map((t) => (
                <CommandCard key={t.toolCallId} card={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
