import { useState } from 'react';
import { Button } from '../../components/Button.js';
import { Input } from '../../components/Form.js';

interface GroupCreateInputProps {
  onCreate: (name: string) => void;
  onCancel: () => void;
  error: string | null;
}

// Inline form for creating a new host folder. Self-manages its text input;
// calls onCreate with the current name (parent trims/validates) on Enter or
// 创建, and onCancel on Escape or 取消.
export function GroupCreateInput({ onCreate, onCancel, error }: GroupCreateInputProps) {
  const [name, setName] = useState('');
  return (
    <div className="flex items-center gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="文件夹名称"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCreate(name);
          if (e.key === 'Escape') onCancel();
        }}
        className="max-w-xs"
      />
      <Button variant="primary" size="sm" onClick={() => onCreate(name)}>
        创建
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        取消
      </Button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
