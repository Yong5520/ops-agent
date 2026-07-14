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
  /** Called when user selects a host via @mention, so parent can bind it to hostIds */
  onMentionHost?: (hostId: string) => void;
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number;
}

interface SkillInfo {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
}

export function MessageInput({
  isRunning,
  onSend,
  onCancel,
  editFromMessage,
  onClearEdit,
  onMentionHost,
}: MessageInputProps) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState>({
    active: false,
    query: '',
    startIndex: -1,
  });
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashActive, setSlashActive] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { hosts } = useHostStore();

  // Load skills list for autocomplete
  useEffect(() => {
    window.opsAgent.skills.list().then((result) => {
      setSkills(result.filter((s) => s.enabled));
    });
  }, []);

  // Focus the textarea when it becomes enabled. Covers:
  // 1. Component mounts in enabled state (e.g., after session deletion
  //    switches ChatPage from main view to empty-state view).
  // 2. isRunning transitions from true to false (agent completes or reset()).
  // Also calls the main-process restoreFocus IPC as a safety net to ensure
  // the BrowserWindow has OS-level keyboard focus (needed for cases where
  // focus may have been stolen by other windows or dialogs).
  useEffect(() => {
    if (!isRunning) {
      void window.opsAgent.window.restoreFocus();
      textareaRef.current?.focus();
    }
  }, [isRunning]);

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

  // Slash command suggestions: built-in commands + enabled skills
  const slashMatches = useMemo(() => {
    if (!slashActive) return [];
    const q = slashQuery.toLowerCase();
    const builtinCommands = [
      { name: 'compact', displayName: '压缩上下文', description: '手动触发上下文压缩' },
      { name: 'context', displayName: '查看上下文', description: '显示上下文使用分析' },
    ];
    const skillCommands = skills.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
    }));
    return [...builtinCommands, ...skillCommands].filter((c) => c.name.toLowerCase().startsWith(q));
  }, [slashActive, slashQuery, skills]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    onSend(trimmed);
    setText('');
    setMention({ active: false, query: '', startIndex: -1 });
    setSlashActive(false);
    if (editFromMessage && onClearEdit) {
      onClearEdit();
    }
  };

  const detectSlash = (value: string, caret: number) => {
    // Detect '/' at the start of the text or after whitespace
    const before = value.slice(0, caret);
    const slashIdx = before.lastIndexOf('/');
    if (slashIdx < 0) {
      setSlashActive(false);
      return;
    }
    // / must be at start or after whitespace
    if (slashIdx > 0 && !/\s/.test(before[slashIdx - 1])) {
      setSlashActive(false);
      return;
    }
    const query = before.slice(slashIdx + 1);
    // If there's whitespace after /, it's not a slash command search
    if (/\s/.test(query)) {
      setSlashActive(false);
      return;
    }
    setSlashActive(true);
    setSlashQuery(query);
    setSlashIndex(0);
  };

  const insertSlash = (cmdName: string) => {
    // Replace the current /query with /cmdName
    const before = text.slice(0, text.lastIndexOf('/'));
    const after = text.slice(text.lastIndexOf('/') + 1 + slashQuery.length);
    const next = `${before}/${cmdName} ${after}`;
    setText(next);
    setSlashActive(false);

    // Place caret after the inserted command
    const newCaret = before.length + cmdName.length + 2;
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCaret, newCaret);
      textareaRef.current?.focus();
    });
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
    detectSlash(value, e.target.selectionStart ?? value.length);
  };

  const insertMention = (hostName: string) => {
    const before = text.slice(0, mention.startIndex);
    const after = text.slice(before.length + 1 + mention.query.length);
    const next = `${before}@${hostName} ${after}`;
    setText(next);
    setMention({ active: false, query: '', startIndex: -1 });

    // Notify parent so the mentioned host gets bound to the session's hostIds
    const matched = hosts.find((h) => h.name === hostName);
    if (matched && onMentionHost) {
      onMentionHost(matched.id);
    }

    // Place caret right after the inserted "@host " so the user can keep typing
    const newCaret = before.length + hostName.length + 2; // +1 for @, +1 for space
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCaret, newCaret);
      textareaRef.current?.focus();
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash command popup navigation
    if (slashActive && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        insertSlash(slashMatches[slashIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashActive(false);
        return;
      }
    }
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
    : '输入运维需求... (Enter 发送, @ 提及主机, / 调用技能, > 或 $ 直接执行命令)';

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

      {/* /slash command popup */}
      {slashActive && slashMatches.length > 0 && (
        <div className="absolute bottom-full left-1/2 mb-1 max-h-60 w-80 -translate-x-1/2 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-lg">
          {slashMatches.map((c, i) => (
            <button
              key={c.name}
              onMouseDown={(e) => {
                e.preventDefault();
                insertSlash(c.name);
              }}
              onMouseEnter={() => setSlashIndex(i)}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs',
                i === slashIndex ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300',
              )}
            >
              <span className="font-mono font-medium text-blue-400">/{c.name}</span>
              <span className="flex-1">
                <span className="text-zinc-200">{c.displayName}</span>
                <span className="ml-1 text-zinc-600">{c.description}</span>
              </span>
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
          autoFocus
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
          : '快捷命令：$ 或 > 直接执行 SSH 命令 · @ 提及主机 · / 调用技能'}
      </div>
    </div>
  );
}
