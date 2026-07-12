import { z } from 'zod';
import { tool } from 'ai';
import type { TodoItem } from '../../../shared/types.js';
import { taskListsStore } from '../../storage/task-lists.js';

// TodoWrite tool - structured task list management.
//
// The AI uses this to break down complex multi-step ops tasks into a visible
// checklist. The list is persisted per session and shown in the UI.
//
// State machine: pending -> in_progress -> completed
// Rule: only ONE task should be in_progress at a time.

const TodoItemSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().optional(),
});

const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema),
});

export function createTodoWriteTool(
  sessionId: string,
  onTodosUpdate?: (todos: TodoItem[]) => void,
) {
  return tool({
    description:
      'Manage your task list for the current session. Use this for complex tasks (3+ steps) to track progress. ' +
      'Replace the entire list each time - do not incrementally update. ' +
      'Mark each task as completed as soon as it is done. ' +
      'Only ONE task should be in_progress at a time. ' +
      'For ops tasks, use subject format like "diagnose nginx 502 on host-web-01".',
    parameters: TodoWriteInputSchema,
    execute: async ({ todos }: { todos: TodoItem[] }) => {
      // Validate: only ONE in_progress at a time
      const inProgress = todos.filter((t: TodoItem) => t.status === 'in_progress');
      if (inProgress.length > 1) {
        const existing = taskListsStore.get(sessionId) ?? [];
        return {
          error:
            'Only one task can be in_progress at a time. Multiple in_progress tasks are not allowed.',
          todos: existing,
        };
      }

      // Persist to DB
      taskListsStore.save(sessionId, todos);

      // Notify renderer
      onTodosUpdate?.(todos);

      // Check if all done
      const allDone = todos.length > 0 && todos.every((t: TodoItem) => t.status === 'completed');
      const nudge = allDone
        ? 'All tasks completed. Please verify the results and provide a summary.'
        : undefined;

      return {
        success: true,
        todos,
        nudge,
      };
    },
  });
}
