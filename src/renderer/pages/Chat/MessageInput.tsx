import { useState, useRef, useEffect, useMemo, type KeyboardEvent, type ChangeEvent } from 'react';
import { Button } from '../../components/Button.js';
import { useHostStore } from '../../store/hostStore.js';
import { cn } from '../../lib/cn.js';
import type { Message } from '../../../shared/types.js';

interface MessageInputProps {
  isRunning: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  editFromMessage?: Message | null;
  onClearEdit?: () => void;
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number;
}

export function MessageInput({
  isRunning,
  onSend,
  onCancel,
  editFromMessage,
  onClearEdit,
}: MessageInputProps) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState>({ active: false, query: '', startIndex: -1 });
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { hosts } = useHostStore();

  // When entering edit mode, prefill the textarea with the original message
  // content (stripped of any leading @host mention the user may have typed —
  // we keep it as-is so they can edit the full original text).
  useEffect(() => {
    if (editFromMessage) {
      setText(editFromMessage.content);
      setMention({ active: false, query: '', startIndex: -1 });
      textareaRef.current?.focus();
    }
  }, [editFromMessage]);

  const mentionMatches = useMemo(() => {
    if (!mention.active) return [];
    const q = mention.query.toLowerCase();
    return hosts.filter((h) => h.name.toLowerCase().startsWith(q));
  }, [mention, hosts]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    onSend(trimmed);
    setText('');
    setMention({ active: false, query: '', startIndex: -1 });
    if (editFromMessage && onClearEdit) {
      onClearEdit();
    }
  };

  const detectMention = (value: string, caret: number) => {
    // Look backwards from the caret for an @ that is either at the start of
    // the text or preceded by whitespace. The mention query is the text
    // between @ and the caret, and must not contain whitespace.
    const before = value.slice(0, caret);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0) {
      setMention({ active: false, query: '', startIndex: -1 });
      return;
    }
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) {
      // @ is not at word boundary — e.g. inside an email-like token
      setMention({ active: false, query: '', startIndex: -1 });
      return;
    }
    const query = before.slice(atIdx + 1);
    if (/\s/.test(query)) {
      setMention({ active: false, query: '', startIndex: -1 });
      return;
    }
    setMention({ active: true, query, startIndex: atIdx });
    setMentionIndex(0);
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    detectMention(value, e.target.selectionStart ?? value.length);
  };

  const insertMention = (hostName: string) => {
    const before = text.slice(0, mention.startIndex);
    const after = text.slice(before.length + 1 + mention.query.length);
    const next = `${before}@${hostName} ${after}`;
    setText(next);
    setMention({ active: false, query: '', startIndex: -1 });
    // Place caret right after the inserted "@host " so the user can keep typing
    const newCaret = before.length + hostName.length + 2; // +1 for @, +1 for space
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCaret, newCaret);
      textareaRef.current?.focus();
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention navigation takes priority when the popup is open
    if (mention.active && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        insertMention(mentionMatches[mentionIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention({ active: false, query: '', startIndex: -1 });
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const placeholder = editFromMessage
    ? '编辑消息后重新发送（原消息及其回复将被删除）...'
    : '输入运维需求... (Enter 发送, Shift+Enter 换行, @ 提及主机)';

  return (
    <div className="relative border-t border-zinc-800 bg-zinc-950 p-4">
      {/* Edit-mode banner */}
      {editFromMessage && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center justify-between rounded-md border border-amber-800 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-300">
          <span>正在编辑历史消息，发送后将替换原消息及之后的回复</span>
          <button
            onClick={() => {
              setText('');
              onClearEdit?.();
            }}
            className="text-amber-400 hover:text-amber-200"
          >
            取消编辑
          </button>
        </div>
      )}

      {/* @host mention popup */}
      {mention.active && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-1/2 mb-1 max-h-48 w-64 -translate-x-1/2 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-lg">
          {mentionMatches.map((h, i) => (
            <button
              key={h.id}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(h.name);
              }}
              onMouseEnter={() => setMentionIndex(i)}
              className={cn(
                'flex w-full items-center justify-between px-3 py-1.5 text-left text-xs',
                i === mentionIndex ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300',
              )}
            >
              <span className="font-medium">{h.name}</span>
              <span className="text-zinc-600">{h.host}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={2}
          className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
          disabled={isRunning}
        />
        {isRunning ? (
          <Button variant="danger" onClick={onCancel}>
            停止
          </Button>
        ) : (
          <Button variant="primary" onClick={handleSend} disabled={!text.trim()}>
            {editFromMessage ? '重新发送' : '发送'}
          </Button>
        )}
      </div>
      <div className="mx-auto mt-1 max-w-3xl text-xs text-zinc-600">
        {editFromMessage
          ? '编辑模式：发送后原消息及之后的回复会被删除'
          : '快捷命令：以 $ 或 > 开头直接执行 · 输入 @ 提及主机'}
      </div>
    </div>
  );
}
