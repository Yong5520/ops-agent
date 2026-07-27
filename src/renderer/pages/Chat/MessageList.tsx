import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message } from '../../../shared/types.js';
import type { ToolCallCard, TurnSegment, ThinkingTurnSegment } from '../../store/agentStore.js';
import { CommandCard } from '../../components/CommandCard.js';
import { MarkdownRenderer } from '../../components/MarkdownRenderer.js';
import { ThinkingBlock as ThinkingBlockView } from '../../components/ThinkingBlock.js';
import { parseThinkingTags } from '../../lib/parse-thinking-tags.js';
import {
  classifyReadVerb,
  formatToolSummary,
  type ToolSummaryGroup,
} from '../../lib/collapse-tool-groups.js';

interface MessageListProps {
  messages: Message[];
  turnSegments: TurnSegment[];
  toolCards: ToolCallCard[];
  isRunning: boolean;
  // The session whose loop is currently running, and the session currently
  // displayed. The live-turn overlay only renders when they match, so
  // switching to a different session mid-run shows that session cleanly
  // instead of the old run's streaming state overlaid (Issue 3 fix).
  runningSessionId?: string | null;
  currentSessionId?: string;
  onEditMessage?: (message: Message) => void;
}

// A render item is the fully-resolved, interleaved view of one assistant turn:
// thinking blocks (with any following read-only tools absorbed into their
// header summary), standalone tool-summary lines, individual non-read tool
// cards, and answer text - in chronological order.
type RenderItem =
  | {
      kind: 'thinking';
      content: string;
      durationMs?: number;
      streaming: boolean;
      summary?: string;
      absorbedTools: ToolCallCard[];
    }
  | { kind: 'tool-summary'; summary: string; active: boolean; tools: ToolCallCard[] }
  | { kind: 'tool'; card: ToolCallCard }
  | { kind: 'text'; content: string };

// Build render items for the LIVE turn from streamed segments + tool cards.
// Consecutive READ tools collapse into a summary; each summary attaches to the
// immediately preceding thinking block (Claude Code "思考 · 搜索了 2 个模式").
function buildLiveRenderItems(segments: TurnSegment[], toolCards: ToolCallCard[]): RenderItem[] {
  const cardById = new Map(toolCards.map((c) => [c.toolCallId, c]));

  // Pass 1: resolve tool refs, collapse consecutive READ tools into summaries.
  type TempItem =
    | { kind: 'thinking'; seg: ThinkingTurnSegment }
    | { kind: 'text'; content: string }
    | { kind: 'tool-summary'; group: ToolSummaryGroup; active: boolean }
    | { kind: 'tool'; card: ToolCallCard };

  const temp: TempItem[] = [];
  let current: { group: ToolSummaryGroup; active: boolean } | null = null;
  const flush = (): void => {
    if (current && current.group.tools.length > 0) {
      temp.push({ kind: 'tool-summary', group: current.group, active: current.active });
    }
    current = null;
  };

  for (const seg of segments) {
    if (seg.kind === 'thinking') {
      flush();
      temp.push({ kind: 'thinking', seg });
    } else if (seg.kind === 'text') {
      flush();
      if (seg.content) temp.push({ kind: 'text', content: seg.content });
    } else {
      const card = cardById.get(seg.toolCallId);
      if (!card) continue;
      if (card.commandType === 'READ') {
        if (!current) {
          current = {
            group: { searchCount: 0, readCount: 0, listCount: 0, tools: [] },
            active: false,
          };
        }
        const verb = classifyReadVerb(card);
        if (verb === 'search') current.group.searchCount++;
        else if (verb === 'list') current.group.listCount++;
        else current.group.readCount++;
        current.group.tools.push(card);
        if (
          card.status === 'executing' ||
          card.status === 'pending' ||
          card.status === 'awaiting-approval'
        ) {
          current.active = true;
        }
      } else {
        flush();
        temp.push({ kind: 'tool', card });
      }
    }
  }
  flush();

  // Pass 2: attach each tool-summary to the immediately preceding thinking
  // item; otherwise emit it as a standalone summary line.
  const result: RenderItem[] = [];
  for (const item of temp) {
    if (item.kind === 'tool-summary') {
      const prev = result[result.length - 1];
      if (prev && prev.kind === 'thinking' && !prev.summary) {
        result[result.length - 1] = {
          ...prev,
          summary: formatToolSummary(item.group, item.active),
          absorbedTools: item.group.tools,
        };
        continue;
      }
      result.push({
        kind: 'tool-summary',
        summary: formatToolSummary(item.group, item.active),
        active: item.active,
        tools: item.group.tools,
      });
    } else if (item.kind === 'thinking') {
      result.push({
        kind: 'thinking',
        content: item.seg.content,
        durationMs: item.seg.durationMs,
        streaming: item.seg.streaming,
        absorbedTools: [],
      });
    } else if (item.kind === 'text') {
      result.push({ kind: 'text', content: item.content });
    } else {
      result.push({ kind: 'tool', card: item.card });
    }
  }
  return result;
}

// Build render items for a PERSISTED assistant message. Thinking blocks come
// from the message's thinkingBlocks field (or are parsed from <think> tags for
// legacy rows). Tool calls were not stored per-message, so persisted turns show
// thinking + text only (no tool summaries) - the live turn has full fidelity.
function buildPersistedRenderItems(message: Message): RenderItem[] {
  const items: RenderItem[] = [];
  const blocks = message.thinkingBlocks ?? [];
  if (blocks.length > 0) {
    for (const b of blocks) {
      if (b.content) {
        items.push({
          kind: 'thinking',
          content: b.content,
          durationMs: b.durationMs,
          streaming: false,
          absorbedTools: [],
        });
      }
    }
    // content is clean answer text (thinking was captured separately on save)
    if (message.content) items.push({ kind: 'text', content: message.content });
  } else {
    // Legacy row: parse <think> tags inline (preserves order)
    for (const seg of parseThinkingTags(message.content)) {
      if (seg.kind === 'thinking') {
        items.push({
          kind: 'thinking',
          content: seg.content,
          streaming: false,
          absorbedTools: [],
        });
      } else {
        items.push({ kind: 'text', content: seg.content });
      }
    }
  }
  return items;
}

// Renders an ordered list of render items (shared by live + persisted turns).
function TurnRenderer({ items }: { items: RenderItem[] }) {
  return (
    <div className="space-y-1">
      {items.map((item, i) => {
        if (item.kind === 'thinking') {
          return (
            <ThinkingBlockView
              key={`t-${i}`}
              content={item.content}
              durationMs={item.durationMs}
              streaming={item.streaming}
              summary={item.summary}
              absorbedTools={item.absorbedTools}
            />
          );
        }
        if (item.kind === 'text') {
          return <MarkdownRenderer key={`x-${i}`} content={item.content} />;
        }
        if (item.kind === 'tool') {
          return <CommandCard key={item.card.toolCallId} card={item.card} />;
        }
        return (
          <CollapsibleToolSummary
            key={`s-${i}`}
            summary={item.summary}
            active={item.active}
            tools={item.tools}
          />
        );
      })}
    </div>
  );
}

// Standalone collapsed read-tool summary (no preceding thought to attach to).
// Expandable to reveal the individual tool cards.
function CollapsibleToolSummary({
  summary,
  active,
  tools,
}: {
  summary: string;
  active: boolean;
  tools: ToolCallCard[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300"
      >
        <span className="text-[10px] select-none">{expanded ? '▼' : '▶'}</span>
        <span>
          {summary}
          {active ? '…' : ''}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {tools.map((t) => (
            <CommandCard key={t.toolCallId} card={t} />
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  turnSegments,
  toolCards,
  isRunning,
  runningSessionId,
  currentSessionId,
  onEditMessage,
}: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const isAtBottomRef = useRef(true);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
    getItemKey: (index) => messages[index]?.id ?? index,
  });

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const threshold = 60;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    isAtBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  // Debounced auto-scroll - only scroll when new content arrives AND user
  // is already at the bottom. Debouncing prevents layout thrashing during
  // fast streaming output (every 100ms instead of every token).
  useEffect(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      if (isAtBottomRef.current) {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, [messages, turnSegments, toolCards]);

  const items = virtualizer.getVirtualItems();
  const liveItems = buildLiveRenderItems(turnSegments, toolCards);
  // Only show the live-turn overlay for the session that is actually running.
  // If the user switched to a different session mid-run, show that session's
  // persisted messages cleanly (the old run keeps streaming in the background
  // but its state is scoped out of view). Also gate on the running session
  // being the current one so the overlay doesn't linger after a switch.
  const isRunningThisSession = isRunning && runningSessionId === currentSessionId;
  const showLiveTurn = isRunningThisSession || turnSegments.length > 0;
  const lastItem = liveItems[liveItems.length - 1];

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      className="relative flex-1 min-h-0 overflow-y-auto"
    >
      <div className="p-6">
        {messages.length === 0 && !isRunningThisSession && (
          <div className="flex h-full flex-col items-center justify-center pt-20 text-center text-zinc-600">
            <div className="text-4xl mb-3">🤖</div>
            <p className="text-sm">开始一段新对话</p>
            <p className="mt-1 text-xs">输入运维需求，AI 将通过 SSH 在目标主机上执行操作</p>
          </div>
        )}

        {/* Virtualized message list */}
        {messages.length > 0 && (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {items.map((vi) => {
              const msg = messages[vi.index];
              if (!msg) return null;
              return (
                <div
                  key={msg.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <div className="pb-4">
                    <MessageBubble
                      message={msg}
                      canEdit={!!onEditMessage && !isRunning}
                      onEdit={onEditMessage}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Live assistant turn (streaming): interleaved thinking/tool/text */}
        {showLiveTurn && (
          <div className="flex justify-start pt-4">
            <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-zinc-800 px-4 py-2.5">
              <div className="mb-1 text-xs text-zinc-500">OpsAgent</div>
              <TurnRenderer items={liveItems} />
              {isRunningThisSession && (!lastItem || lastItem.kind === 'text') && (
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-zinc-400 align-middle" />
              )}
            </div>
          </div>
        )}

        {/* Running indicator - only when nothing has arrived yet */}
        {isRunningThisSession && turnSegments.length === 0 && messages.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <span className="flex gap-1">
              <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500" />
            </span>
            AI 思考中...
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-4 left-full mr-4 flex h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-400 shadow-lg hover:bg-zinc-800 hover:text-zinc-100"
          title="回到底部"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  canEdit: boolean;
  onEdit?: (message: Message) => void;
}

// Memoized to prevent re-rendering on every streaming token change.
// Only re-renders when the message itself changes.
const MessageBubble = memo(function MessageBubble({
  message,
  canEdit,
  onEdit,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    const isError = message.content.startsWith('[错误]');
    return (
      <div
        className={`mx-auto max-w-[80%] rounded-md border px-3 py-2 text-center text-xs ${
          isError
            ? 'border-red-800 bg-red-950/50 text-red-300'
            : 'border-zinc-800 bg-zinc-900 text-zinc-600 italic'
        }`}
      >
        {message.content}
      </div>
    );
  }

  return (
    <div className={`group flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="relative max-w-[85%]">
        <div
          className={`rounded-lg px-4 py-2.5 ${
            isUser
              ? 'rounded-br-sm bg-blue-900 text-zinc-100'
              : 'rounded-bl-sm bg-zinc-800 text-zinc-100'
          }`}
        >
          <div className="mb-1 text-xs text-zinc-500">{isUser ? '你' : 'OpsAgent'}</div>
          {isUser ? (
            <div className="whitespace-pre-wrap text-sm">{message.content}</div>
          ) : (
            <TurnRenderer items={buildPersistedRenderItems(message)} />
          )}
          {message.attachments && message.attachments.length > 0 && (
            <MessageAttachments attachments={message.attachments} />
          )}
        </div>
        {/* Edit button on user messages - only when not running */}
        {isUser && canEdit && onEdit && (
          <button
            onClick={() => onEdit(message)}
            title="编辑并重新发送"
            className="absolute -top-2 left-0 hidden h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-100 group-hover:flex"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

// Renders image attachments for a user message. Loads image data via IPC
// (attachments:read) since the renderer cannot directly access the file system.
function MessageAttachments({ attachments }: { attachments: NonNullable<Message['attachments']> }) {
  const [imageUrls, setImageUrls] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      attachments.map(async (att) => {
        try {
          const dataUrl = await window.opsAgent.attachments.read(att.id);
          return [att.id, dataUrl] as const;
        } catch {
          return [att.id, null] as const;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const map: Record<string, string | null> = {};
      for (const [id, url] of results) map[id] = url;
      setImageUrls(map);
    });
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  if (attachments.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((att) => {
        const url = imageUrls[att.id];
        return (
          <img
            key={att.id}
            src={url ?? undefined}
            alt={att.originalName ?? 'attachment'}
            className="max-h-48 max-w-full rounded border border-zinc-700 object-contain"
            loading="lazy"
          />
        );
      })}
    </div>
  );
}
