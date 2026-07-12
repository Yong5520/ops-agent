import { useEffect, useRef } from 'react';
import { useUiStore } from '../store/uiStore.js';
import { Button } from './Button.js';

// Non-blocking confirm dialog that replaces native window.confirm().
// Native confirm() steals OS-level keyboard focus from the BrowserWindow
// on Windows; this custom modal avoids that entirely.
export function ConfirmDialog() {
  const { confirmState, resolveConfirm } = useUiStore();
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the confirm button when dialog opens
  useEffect(() => {
    if (confirmState.open) {
      confirmRef.current?.focus();
    }
  }, [confirmState.open]);

  // Escape key cancels
  useEffect(() => {
    if (!confirmState.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveConfirm(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [confirmState.open, resolveConfirm]);

  if (!confirmState.open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Click on backdrop cancels
        if (e.target === e.currentTarget) {
          resolveConfirm(false);
        }
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        {confirmState.title && (
          <div className="border-b border-zinc-800 px-5 py-3">
            <h3 className="text-sm font-semibold text-zinc-100">{confirmState.title}</h3>
          </div>
        )}
        <div className="px-5 py-4">
          <p className="text-sm text-zinc-300 whitespace-pre-line">{confirmState.message}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <Button variant="ghost" onClick={() => resolveConfirm(false)}>
            {confirmState.cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={confirmState.variant}
            onClick={() => resolveConfirm(true)}
          >
            {confirmState.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
