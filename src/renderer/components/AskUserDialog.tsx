import { useState, useEffect, useRef } from 'react';
import { Button } from './Button.js';
import { useUiStore, type AskUserAnswer } from '../store/uiStore.js';

// AskUserDialog (P1-4)
//
// Shown when the agent calls ask_user with clarifying questions.
// The user can:
//   - Select one option per question (single-select: radio)
//   - Select multiple options (multi-select: checkboxes)
//   - Type a custom response via "Other" (always available)
//   - Submit all answers at once
//   - Cancel (Esc / backdrop click) -> returns placeholder answers
//
// This component reads from uiStore.askUserState and is always mounted
// in AppShell (renders null when not open).

interface QuestionSelection {
  selectedOptions: Set<string>; // option labels
  otherText: string;
  useOther: boolean;
}

export function AskUserDialog() {
  const { askUserState, resolveAskUser } = useUiStore();
  const submitRef = useRef<HTMLButtonElement>(null);

  // Per-question selection state, keyed by question index
  const [selections, setSelections] = useState<Map<number, QuestionSelection>>(new Map());

  // Reset selections when dialog opens
  useEffect(() => {
    if (askUserState.open) {
      const initial = new Map<number, QuestionSelection>();
      askUserState.questions.forEach((_, i) => {
        initial.set(i, {
          selectedOptions: new Set(),
          otherText: '',
          useOther: false,
        });
      });
      setSelections(initial);
    }
  }, [askUserState.open, askUserState.questions]);

  // Auto-focus submit button
  useEffect(() => {
    if (askUserState.open) {
      setTimeout(() => submitRef.current?.focus(), 50);
    }
  }, [askUserState.open]);

  // Escape key cancels
  useEffect(() => {
    if (!askUserState.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [askUserState.open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!askUserState.open) return null;

  const toggleOption = (qIndex: number, label: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const sel = next.get(qIndex) ?? {
        selectedOptions: new Set<string>(),
        otherText: '',
        useOther: false,
      };
      if (multiSelect) {
        const updated = new Set(sel.selectedOptions);
        if (updated.has(label)) {
          updated.delete(label);
        } else {
          updated.add(label);
        }
        next.set(qIndex, { ...sel, selectedOptions: updated, useOther: false });
      } else {
        // Single-select: replace
        next.set(qIndex, {
          ...sel,
          selectedOptions: new Set([label]),
          useOther: false,
        });
      }
      return next;
    });
  };

  const setOtherText = (qIndex: number, text: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const sel = next.get(qIndex) ?? {
        selectedOptions: new Set<string>(),
        otherText: '',
        useOther: false,
      };
      next.set(qIndex, { ...sel, otherText: text, useOther: true });
      return next;
    });
  };

  const enableOther = (qIndex: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const sel = next.get(qIndex) ?? {
        selectedOptions: new Set<string>(),
        otherText: '',
        useOther: false,
      };
      next.set(qIndex, { ...sel, useOther: true, selectedOptions: new Set() });
      return next;
    });
  };

  // Check if all questions have an answer
  const allAnswered = askUserState.questions.every((_, i) => {
    const sel = selections.get(i);
    if (!sel) return false;
    if (sel.useOther) return sel.otherText.trim().length > 0;
    return sel.selectedOptions.size > 0;
  });

  const handleSubmit = () => {
    const answers: AskUserAnswer[] = askUserState.questions.map((q, i) => {
      const sel = selections.get(i)!;
      if (sel.useOther) {
        return {
          question: q.question,
          answer: sel.otherText.trim(),
          isOther: true,
        };
      }
      const labels = Array.from(sel.selectedOptions);
      return {
        question: q.question,
        answer: labels.join(', '),
      };
    });
    resolveAskUser(answers);
  };

  function handleCancel() {
    // Return placeholder answers so the tool resolves
    const answers: AskUserAnswer[] = askUserState.questions.map((q) => ({
      question: q.question,
      answer: '(用户取消)',
      isOther: true,
    }));
    resolveAskUser(answers);
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          handleCancel();
        }
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        {/* Header */}
        <div className="border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-zinc-100">Agent 提问</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Session: {askUserState.sessionId.slice(0, 8)} · Agent 需要你的输入来继续
          </p>
        </div>

        {/* Questions */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {askUserState.questions.map((q, qIndex) => {
            const sel = selections.get(qIndex);
            const selectedOptions = sel?.selectedOptions ?? new Set<string>();
            const useOther = sel?.useOther ?? false;
            const otherText = sel?.otherText ?? '';

            return (
              <div key={qIndex} className="space-y-2">
                {/* Question header */}
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
                    {q.header}
                  </span>
                  <span className="text-sm text-zinc-200">{q.question}</span>
                </div>

                {/* Options */}
                <div className="space-y-1.5 pl-1">
                  {q.options.map((opt) => {
                    const isSelected = selectedOptions.has(opt.label);
                    return (
                      <label
                        key={opt.label}
                        className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 transition-colors ${
                          isSelected
                            ? 'border-zinc-500 bg-zinc-800'
                            : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850'
                        }`}
                      >
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`question-${qIndex}`}
                          checked={isSelected}
                          onChange={() => toggleOption(qIndex, opt.label, q.multiSelect)}
                          className="mt-0.5 h-4 w-4 cursor-pointer accent-zinc-400"
                        />
                        <div className="flex-1">
                          <div className="text-sm text-zinc-200">{opt.label}</div>
                          {opt.description && (
                            <div className="mt-0.5 text-xs text-zinc-500">{opt.description}</div>
                          )}
                        </div>
                      </label>
                    );
                  })}

                  {/* Other (free text) option */}
                  <label
                    className={`flex cursor-pointer items-start gap-2 rounded border px-3 py-2 transition-colors ${
                      useOther
                        ? 'border-zinc-500 bg-zinc-800'
                        : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850'
                    }`}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`question-${qIndex}`}
                      checked={useOther}
                      onChange={() => enableOther(qIndex)}
                      className="mt-0.5 h-4 w-4 cursor-pointer accent-zinc-400"
                    />
                    <div className="flex-1">
                      <div className="text-sm text-zinc-200">其他（自定义）</div>
                      {useOther && (
                        <textarea
                          value={otherText}
                          onChange={(e) => setOtherText(qIndex, e.target.value)}
                          placeholder="输入你的回答..."
                          rows={2}
                          autoFocus
                          className="mt-2 w-full resize-none rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
                        />
                      )}
                    </div>
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          <span className="text-xs text-zinc-600">
            {askUserState.questions.length} 个问题 · Esc 取消
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              取消
            </Button>
            <Button
              ref={submitRef}
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={!allAnswered}
            >
              提交回答
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
