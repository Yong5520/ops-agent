import { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '../../components/Button.js';
import { cn } from '../../lib/cn.js';

interface AiCommandBarProps {
  sessionId: string;
  hostId: string;
  onExecute: (command: string) => void;
  onClose: () => void;
}

interface GeneratedCommand {
  command: string;
  explanation: string;
  safetyLevel: 'read' | 'write' | 'sudo';
}

type BarState = 'idle' | 'loading' | 'result' | 'editing' | 'error';

const SAFETY_BADGE: Record<GeneratedCommand['safetyLevel'], { label: string; className: string }> =
  {
    read: {
      label: 'READ',
      className: 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40',
    },
    write: {
      label: 'WRITE',
      className: 'bg-amber-600/20 text-amber-400 border-amber-600/40',
    },
    sudo: {
      label: 'SUDO',
      className: 'bg-red-600/20 text-red-400 border-red-600/40',
    },
  };

export function AiCommandBar({ sessionId, hostId, onExecute, onClose }: AiCommandBarProps) {
  const [input, setInput] = useState('');
  const [state, setState] = useState<BarState>('idle');
  const [result, setResult] = useState<GeneratedCommand | null>(null);
  const [editableCommand, setEditableCommand] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleGenerate = useCallback(async () => {
    const text = input.trim();
    if (!text) return;

    setState('loading');
    setErrorMsg('');

    try {
      const res = await window.opsAgent.ai.generateCommand(text, hostId);
      if (!res.command) {
        setErrorMsg('AI 未能生成有效命令，请尝试重新描述');
        setState('error');
        return;
      }
      setResult(res);
      setEditableCommand(res.command);
      setState('result');
    } catch (err) {
      setErrorMsg((err as Error).message || 'AI 请求失败');
      setState('error');
    }
  }, [input, hostId]);

  const handleExecute = useCallback(() => {
    const cmd = state === 'editing' ? editableCommand : result?.command;
    if (cmd && cmd.trim()) {
      onExecute(cmd.trim());
      onClose();
    }
  }, [state, editableCommand, result, onExecute, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+Enter: execute (from result or editing state)
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        if (state === 'result' || state === 'editing') {
          handleExecute();
        } else if (state === 'idle' && input.trim()) {
          handleGenerate();
        }
        return;
      }
      // Ctrl+E: edit command
      if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (state === 'result') {
          setState('editing');
          setTimeout(() => editRef.current?.focus(), 50);
        }
        return;
      }
      // Ctrl+Backspace: reject/close
      if (e.ctrlKey && e.key === 'Backspace') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [state, input, handleGenerate, handleExecute, onClose],
  );

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    // In editing textarea, Ctrl+Enter executes, Ctrl+E saves back to result
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    } else if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      // Save edit and go back to result view
      if (result) {
        setResult({ ...result, command: editableCommand });
      }
      setState('result');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setState('result');
    }
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3" onKeyDown={handleKeyDown}>
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-300">AI 命令助手</span>
          <span className="text-xs text-zinc-600">自然语言 → 命令</span>
        </div>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" title="关闭 (Esc)">
          ×
        </button>
      </div>

      {/* Input row */}
      {state === 'idle' || state === 'loading' || state === 'error' ? (
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
                e.preventDefault();
                if (state !== 'loading') handleGenerate();
              }
            }}
            placeholder="用自然语言描述你要执行的操作，如：统计当前目录大小"
            disabled={state === 'loading'}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
          />
          <Button
            variant="primary"
            size="md"
            onClick={handleGenerate}
            disabled={state === 'loading' || !input.trim()}
          >
            {state === 'loading' ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
                生成中
              </>
            ) : (
              '生成'
            )}
          </Button>
        </div>
      ) : null}

      {/* Error state */}
      {state === 'error' && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-red-400">{errorMsg}</span>
          <button
            onClick={() => setState('idle')}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline"
          >
            重试
          </button>
        </div>
      )}

      {/* Result state */}
      {state === 'result' && result && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">{result.explanation}</p>
          <p className="text-xs text-zinc-600">是否同意执行以下命令？</p>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200">
              <span className="flex-1 break-all">{result.command}</span>
              <span
                className={cn(
                  'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold',
                  SAFETY_BADGE[result.safetyLevel].className,
                )}
              >
                {SAFETY_BADGE[result.safetyLevel].label}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={handleExecute}>
              执行 <span className="ml-1 text-[10px] opacity-60">Ctrl+↵</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setState('editing');
                setTimeout(() => editRef.current?.focus(), 50);
              }}
            >
              修改 <span className="ml-1 text-[10px] opacity-60">Ctrl+E</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              拒绝 <span className="ml-1 text-[10px] opacity-60">Ctrl+⌫</span>
            </Button>
          </div>
        </div>
      )}

      {/* Editing state */}
      {state === 'editing' && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">修改命令后按 Ctrl+Enter 执行，Ctrl+E 保存</p>
          <textarea
            ref={editRef}
            value={editableCommand}
            onChange={(e) => setEditableCommand(e.target.value)}
            onKeyDown={handleEditKeyDown}
            rows={3}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="primary" size="sm" onClick={handleExecute}>
              执行 <span className="ml-1 text-[10px] opacity-60">Ctrl+↵</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (result) setResult({ ...result, command: editableCommand });
                setState('result');
              }}
            >
              保存 <span className="ml-1 text-[10px] opacity-60">Ctrl+E</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setState('result')}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* Hidden sessionId for reference - used by parent for command execution */}
      <span className="hidden" aria-hidden="true">
        {sessionId}
      </span>
    </div>
  );
}
