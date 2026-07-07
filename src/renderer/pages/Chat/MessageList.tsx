import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message } from '../../../shared/types.js';
import type { ToolCallCard as ToolCallCardData } from '../../store/agentStore.js';
import { CommandCard } from '../../components/CommandCard.js';
import { MarkdownRenderer } from '../../components/MarkdownRenderer.js';

interface MessageListProps {
  messages: Message[];
  streamingText: string;
  toolCards: ToolCallCardData[];
  isRunning: boolean;
  onEditMessage?: (message: Message) => void;
}

export function MessageList({
  messages,
  streamingText,
  toolCards,
  isRunning,
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

  // Debounced auto-scroll — only scroll when new content arrives AND user
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
  }, [messages, streamingText, toolCards]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      className="relative flex-1 min-h-0 overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl p-6">
        {messages.length === 0 && !isRunning && (
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

        {/* Tool call cards (non-virtualized — always visible during run) */}
        {toolCards.length > 0 && (
          <div className="space-y-1">
            {toolCards.map((card) => (
              <CommandCard key={card.toolCallId} card={card} />
            ))}
          </div>
        )}

        {/* Streaming assistant text */}
        {streamingText && (
          <div className="flex justify-end pt-4">
            <div className="max-w-[85%] rounded-lg rounded-br-sm bg-zinc-800 px-4 py-2.5">
              <MarkdownRenderer content={streamingText} />
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-zinc-400 align-middle" />
            </div>
          </div>
        )}

        {/* Running indicator */}
        {isRunning && !streamingText && toolCards.length === 0 && messages.length === 0 && (
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
const MessageBubble = memo(function MessageBubble({ message, canEdit, onEdit }: MessageBubbleProps) {
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
            <MarkdownRenderer content={message.content} />
          )}
        </div>
        {/* Edit button on user messages — only when not running */}
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
