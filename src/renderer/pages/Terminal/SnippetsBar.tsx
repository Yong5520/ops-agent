import { useState } from 'react';
import { useTerminalStore, type CommandSnippet } from '../../store/terminalStore.js';
import { Button } from '../../components/Button.js';
import { cn } from '../../lib/cn.js';

interface SnippetsBarProps {
  onSendCommand: (command: string) => void;
  onClose: () => void;
}

export function SnippetsBar({ onSendCommand, onClose }: SnippetsBarProps) {
  const { builtinSnippets, customSnippets, addSnippet, removeSnippet } = useTerminalStore();
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const allSnippets = [...builtinSnippets, ...customSnippets];

  const filtered = search
    ? allSnippets.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.command.toLowerCase().includes(search.toLowerCase()) ||
          (s.category?.toLowerCase().includes(search.toLowerCase()) ?? false),
      )
    : allSnippets;

  // Group by category
  const grouped = filtered.reduce(
    (acc, s) => {
      const key = s.category || '其他';
      (acc[key] ??= []).push(s);
      return acc;
    },
    {} as Record<string, CommandSnippet[]>,
  );

  const handleSend = (snippet: CommandSnippet) => {
    onSendCommand(snippet.command);
  };

  const handleAdd = () => {
    if (!newName.trim() || !newCommand.trim()) return;
    addSnippet({
      name: newName.trim(),
      command: newCommand.trim(),
      category: newCategory.trim() || undefined,
    });
    setNewName('');
    setNewCommand('');
    setNewCategory('');
    setShowAddForm(false);
  };

  const handleRemove = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    removeSnippet(id);
  };

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-sm font-medium text-zinc-200">命令片段</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAddForm((v) => !v)}
            title="添加自定义命令"
          >
            +
          </Button>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" title="关闭">
            ×
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="border-b border-zinc-800 px-3 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索命令..."
          className="w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
        />
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="space-y-2 border-b border-zinc-800 bg-zinc-900/50 px-3 py-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="命令名称"
            className="w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          />
          <input
            type="text"
            value={newCommand}
            onChange={(e) => setNewCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
            placeholder="命令内容 (如: docker ps -a)"
            className="w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          />
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="分类 (可选)"
              className="flex-1 rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700"
            />
            <Button variant="primary" size="sm" onClick={handleAdd}>
              保存
            </Button>
          </div>
        </div>
      )}

      {/* Snippet list */}
      <div className="flex-1 overflow-y-auto">
        {Object.entries(grouped).map(([category, snippets]) => (
          <div key={category} className="border-b border-zinc-900">
            <div className="px-3 py-1 text-[10px] font-medium uppercase text-zinc-600">
              {category}
            </div>
            {snippets.map((snippet) => (
              <button
                key={snippet.id}
                onClick={() => handleSend(snippet)}
                className={cn(
                  'group flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors hover:bg-zinc-900',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-200">{snippet.name}</div>
                  <div className="truncate font-mono text-[10px] text-zinc-600">{snippet.command}</div>
                </div>
                {!snippet.builtin && (
                  <span
                    onClick={(e) => handleRemove(e, snippet.id)}
                    className="text-zinc-700 opacity-0 group-hover:opacity-100 hover:text-red-400"
                    title="删除"
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            无匹配命令
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600">
        点击命令发送到当前终端 · {allSnippets.length} 条命令
      </div>
    </div>
  );
}
