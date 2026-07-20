import {
  useState,
  useRef,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { Button } from '../../components/Button.js';
import { useHostStore } from '../../store/hostStore.js';
import { cn } from '../../lib/cn.js';
import type { Message } from '../../../shared/types.js';

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const COMPRESS_THRESHOLD = 2 * 1024 * 1024; // 2MB - compress images larger than this
const COMPRESS_MAX_WIDTH = 1920;

interface PendingAttachment {
  id: string;
  dataUrl: string; // base64 data URL
  mimeType: string;
  originalName?: string;
  previewUrl: string;
}

interface MessageInputProps {
  isRunning: boolean;
  onSend: (text: string, attachments?: AgentAttachmentInput[]) => void;
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
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    if ((!trimmed && pendingAttachments.length === 0) || isRunning) return;
    const attachments: AgentAttachmentInput[] | undefined =
      pendingAttachments.length > 0
        ? pendingAttachments.map((a) => ({
            data: a.dataUrl,
            mimeType: a.mimeType,
            originalName: a.originalName,
          }))
        : undefined;
    onSend(trimmed, attachments);
    setText('');
    setPendingAttachments([]);
    setAttachmentError(null);
    setMention({ active: false, query: '', startIndex: -1 });
    setSlashActive(false);
    if (editFromMessage && onClearEdit) {
      onClearEdit();
    }
  };

  // ── Image attachment handling ──────────────────────────────────────────
  // Reads a File as a base64 data URL. Compresses large images via canvas.
  async function processImageFile(file: File): Promise<PendingAttachment | null> {
    if (!file.type.startsWith('image/')) {
      setAttachmentError('仅支持图片文件 (PNG/JPEG/WebP/GIF)');
      return null;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setAttachmentError(`图片大小不能超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
      return null;
    }
    setAttachmentError(null);

    try {
      // Read as data URL for compression check
      const rawDataUrl = await readFileAsDataUrl(file);

      // Compress if > 2MB using canvas
      let finalDataUrl = rawDataUrl;
      if (file.size > COMPRESS_THRESHOLD) {
        finalDataUrl = await compressImage(rawDataUrl, file.type);
      }

      return {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl: finalDataUrl,
        mimeType: file.type,
        originalName: file.name,
        previewUrl: finalDataUrl,
      };
    } catch {
      setAttachmentError('图片处理失败，请重试');
      return null;
    }
  }

  async function addFiles(files: FileList | File[]) {
    const fileArray = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (fileArray.length === 0) return;

    const currentCount = pendingAttachments.length;
    const availableSlots = MAX_ATTACHMENTS - currentCount;
    if (availableSlots <= 0) {
      setAttachmentError(`最多 ${MAX_ATTACHMENTS} 张图片`);
      return;
    }

    const toProcess = fileArray.slice(0, availableSlots);
    const results = await Promise.all(toProcess.map(processImageFile));
    const valid = results.filter((r): r is PendingAttachment => r !== null);
    if (valid.length > 0) {
      setPendingAttachments((prev) => [...prev, ...valid]);
    }
  }

  function removeAttachment(id: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void addFiles(imageFiles);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void addFiles(e.target.files);
    }
    // Reset so the same file can be selected again
    e.target.value = '';
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
      if (e.key === 'Tab') {
        e.preventDefault();
        insertSlash(slashMatches[slashIndex].name);
        return;
      }
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
      if (e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionMatches[mentionIndex].name);
        return;
      }
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
    : '输入运维需求... (Enter 发送, @ 提及主机, / 调用技能, Tab 补全, > 或 $ 直接执行命令)';

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

      <div
        className={cn(
          'mx-auto max-w-3xl rounded-md',
          isDragging && 'ring-2 ring-blue-500 ring-offset-2 ring-offset-zinc-950 bg-blue-950/20',
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Attachment preview area */}
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 rounded-md border border-zinc-700 bg-zinc-900 p-2">
            {pendingAttachments.map((att) => (
              <div key={att.id} className="group relative">
                <img
                  src={att.previewUrl}
                  alt={att.originalName ?? 'attachment'}
                  className="h-20 w-20 rounded border border-zinc-600 object-cover"
                />
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                  title="删除"
                >
                  x
                </button>
                {att.originalName && (
                  <span className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 text-[10px] text-zinc-300">
                    {att.originalName}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Attachment error message */}
        {attachmentError && (
          <div className="mb-2 rounded-md border border-red-800 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
            {attachmentError}
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Attachment button */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isRunning || pendingAttachments.length >= MAX_ATTACHMENTS}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
            title="上传图片"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
            <Button
              variant="primary"
              onClick={handleSend}
              disabled={!text.trim() && pendingAttachments.length === 0}
            >
              {editFromMessage ? '重新发送' : '发送'}
            </Button>
          )}
        </div>
      </div>
      <div className="mx-auto mt-1 max-w-3xl text-xs text-zinc-600">
        {editFromMessage
          ? '编辑模式：发送后原消息及之后的回复会被删除'
          : '快捷命令：$ 或 > 直接执行 SSH 命令 · @ 提及主机 · / 调用技能 · Tab 补全 · 粘贴/拖拽上传截图'}
      </div>
    </div>
  );
}

// ── Helper functions ─────────────────────────────────────────────────────

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Compress an image data URL using canvas. Resizes to max 1920px wide
// and re-encodes as JPEG quality 0.85 (or PNG for transparency).
async function compressImage(dataUrl: string, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > COMPRESS_MAX_WIDTH) {
        height = Math.round((height * COMPRESS_MAX_WIDTH) / width);
        width = COMPRESS_MAX_WIDTH;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      // Use JPEG for compression unless original is PNG with transparency
      const outputType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      const quality = outputType === 'image/jpeg' ? 0.85 : undefined;
      resolve(canvas.toDataURL(outputType, quality));
    };
    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = dataUrl;
  });
}
