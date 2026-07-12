import { useState, useEffect, useRef } from 'react';
import { Button } from './Button.js';

// Plan Approval Dialog (P0-1.B)
//
// Shown when the agent calls exit_plan_mode with a plan text.
// The user can:
//   - Approve: switch to operator mode and let the agent execute
//   - Reject: send back to the agent for revision
//   - Edit: modify the plan text before approving

interface PlanApprovalDialogProps {
  plan: string;
  sessionId: string;
  onApprove: (editedPlan?: string) => void;
  onReject: (reason?: string) => void;
}

export function PlanApprovalDialog({ plan, sessionId, onApprove, onReject }: PlanApprovalDialogProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedPlan, setEditedPlan] = useState(plan);
  const approveRef = useRef<HTMLButtonElement>(null);

  // Auto-focus approve button when dialog opens
  useEffect(() => {
    approveRef.current?.focus();
  }, []);

  // Escape key rejects
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onReject('User pressed Escape');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onReject]);

  const handleApprove = () => {
    onApprove(isEditing ? editedPlan : undefined);
  };

  const handleEditToggle = () => {
    if (isEditing) {
      // Switching from edit to preview - keep edited content
      setIsEditing(false);
    } else {
      setIsEditing(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onReject('User dismissed the dialog');
        }
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        {/* Header */}
        <div className="border-b border-zinc-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-zinc-100">
            {'\u2709'} Plan Approval Required
          </h3>
          <p className="mt-1 text-xs text-zinc-500">
            Session: {sessionId.slice(0, 8)} · Review the agent's plan before execution
          </p>
        </div>

        {/* Plan content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isEditing ? (
            <textarea
              value={editedPlan}
              onChange={(e) => setEditedPlan(e.target.value)}
              className="h-96 w-full resize-none rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-sm text-zinc-200 focus:border-zinc-600 focus:outline-none"
              autoFocus
            />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-300">
              {isEditing ? editedPlan : plan}
            </pre>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={handleEditToggle}>
            {isEditing ? '\u25c0 Preview' : '\u270e Edit'}
          </Button>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" onClick={() => onReject('User rejected the plan')}>
              Reject
            </Button>
            <Button ref={approveRef} variant="primary" size="sm" onClick={handleApprove}>
              Approve & Execute
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
