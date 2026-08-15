import { type KeyboardEvent } from 'react';
import { cn } from '../lib/cn.js';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

// Compact controlled search input with a leading magnifier and a conditional
// clear (×) button. Escape clears the query. Shared by the Terminal host list
// and the Settings host-config list so both get identical search affordance.
// Intentionally presentational: filtering logic lives in the callers (which
// use the pure filterHosts util), keeping this component reusable and dumb.
export function SearchInput({ value, onChange, placeholder, className }: SearchInputProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && value) {
      e.preventDefault();
      onChange('');
    }
  };

  return (
    <div className={cn('relative', className)}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-zinc-600"
      >
        🔍
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label={placeholder ?? '搜索'}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 py-1.5 pl-7 pr-7 text-xs text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="清除搜索"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-300"
        >
          ×
        </button>
      )}
    </div>
  );
}
