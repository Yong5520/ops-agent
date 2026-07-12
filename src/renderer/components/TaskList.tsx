import type { TodoItem } from '../../shared/types.js';

interface TaskListProps {
  todos: TodoItem[];
  onClear?: () => void;
}

const STATUS_ICONS: Record<TodoItem['status'], string> = {
  pending: '\u25cb',
  in_progress: '\u25d4',
  completed: '\u25cf',
};

const STATUS_COLORS: Record<TodoItem['status'], string> = {
  pending: 'text-zinc-500',
  in_progress: 'text-blue-400',
  completed: 'text-green-400',
};

export function TaskList({ todos, onClear }: TaskListProps) {
  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const allDone = completed === total;

  const handleClear = () => {
    if (onClear) {
      onClear();
    }
  };

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-400">
        <span>{'\u2637'} Task List</span>
        <span className="text-zinc-600">
          ({completed}/{total})
        </span>
        <div className="ml-auto h-1 flex-1 max-w-[100px] overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full bg-green-500 transition-all"
            style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
          />
        </div>
        {/* Clear button: show when all done or always show for manual cleanup */}
        <button
          onClick={handleClear}
          className="text-zinc-600 hover:text-zinc-400 transition-colors"
          title={allDone ? 'Clear completed tasks' : 'Clear task list'}
        >
          {allDone ? '\u2715' : '\u2715'}
        </button>
      </div>
      <div className="space-y-1">
        {todos.map((todo) => (
          <div
            key={todo.id}
            className={`flex items-start gap-2 text-sm ${
              todo.status === 'completed' ? 'text-zinc-600 line-through' : 'text-zinc-300'
            }`}
          >
            <span className={`mt-0.5 ${STATUS_COLORS[todo.status]}`}>
              {STATUS_ICONS[todo.status]}
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate">{todo.subject}</span>
              {todo.status === 'in_progress' && todo.activeForm && (
                <span className="block text-xs text-blue-400/70">{todo.activeForm}...</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
