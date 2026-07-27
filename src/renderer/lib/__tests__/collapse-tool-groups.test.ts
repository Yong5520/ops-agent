import { describe, it, expect } from 'vitest';
import {
  collapseToolGroups,
  classifyReadVerb,
  formatToolSummary,
  formatDuration,
} from '../collapse-tool-groups.js';
import type { ToolCallCard } from '../../store/agentStore.js';

function card(overrides: Partial<ToolCallCard>): ToolCallCard {
  return {
    toolCallId: 'default',
    toolName: 'exec',
    commandType: 'READ',
    status: 'success',
    authorization: 'auto',
    ...overrides,
  };
}

describe('classifyReadVerb', () => {
  it('classifies search_logs as search', () => {
    expect(classifyReadVerb(card({ toolName: 'search_logs' }))).toBe('search');
  });
  it('classifies journal_query as search', () => {
    expect(classifyReadVerb(card({ toolName: 'journal_query' }))).toBe('search');
  });
  it('classifies list_hosts as list', () => {
    expect(classifyReadVerb(card({ toolName: 'list_hosts' }))).toBe('list');
  });
  it('classifies read_file as read', () => {
    expect(classifyReadVerb(card({ toolName: 'read_file' }))).toBe('read');
  });
  it('classifies grep exec as search', () => {
    expect(classifyReadVerb(card({ command: 'grep -r "foo" /etc' }))).toBe('search');
  });
  it('classifies ls exec as list', () => {
    expect(classifyReadVerb(card({ command: 'ls -la /var/log' }))).toBe('list');
  });
  it('classifies cat exec as read', () => {
    expect(classifyReadVerb(card({ command: 'cat /etc/os-release' }))).toBe('read');
  });
  it('classifies ps exec as read', () => {
    expect(classifyReadVerb(card({ command: 'ps aux' }))).toBe('read');
  });
});

describe('collapseToolGroups', () => {
  it('returns empty for no cards', () => {
    expect(collapseToolGroups([])).toEqual([]);
  });

  it('collapses consecutive READ cards into one summary', () => {
    const segs = collapseToolGroups([
      card({ toolCallId: '1', toolName: 'read_file' }),
      card({ toolCallId: '2', command: 'grep foo /etc' }),
      card({ toolCallId: '3', command: 'ls /var' }),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('tool-summary');
    if (segs[0]!.kind === 'tool-summary') {
      expect(segs[0]!.group.readCount).toBe(1);
      expect(segs[0]!.group.searchCount).toBe(1);
      expect(segs[0]!.group.listCount).toBe(1);
      expect(segs[0]!.group.tools).toHaveLength(3);
    }
  });

  it('keeps WRITE/SUDO cards as individual tool segments', () => {
    const segs = collapseToolGroups([
      card({ toolCallId: '1', toolName: 'read_file' }),
      card({ toolCallId: '2', commandType: 'WRITE' }),
      card({ toolCallId: '3', commandType: 'SUDO' }),
    ]);
    expect(segs).toHaveLength(3);
    expect(segs[0]!.kind).toBe('tool-summary');
    expect(segs[1]!.kind).toBe('tool');
    expect(segs[2]!.kind).toBe('tool');
  });

  it('splits separate READ groups around a WRITE card', () => {
    const segs = collapseToolGroups([
      card({ toolCallId: '1' }),
      card({ toolCallId: '2', commandType: 'WRITE' }),
      card({ toolCallId: '3' }),
    ]);
    expect(segs).toHaveLength(3);
    expect(segs[0]!.kind).toBe('tool-summary');
    expect(segs[1]!.kind).toBe('tool');
    expect(segs[2]!.kind).toBe('tool-summary');
  });

  it('handles BLOCKED as a non-collapsible tool', () => {
    const segs = collapseToolGroups([
      card({ toolCallId: '1' }),
      card({ toolCallId: '2', commandType: 'BLOCKED' }),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.kind).toBe('tool');
  });
});

describe('formatToolSummary', () => {
  it('formats all three categories joined with ·', () => {
    const text = formatToolSummary(
      { searchCount: 2, readCount: 1, listCount: 1, tools: [] },
      false,
    );
    expect(text).toBe('搜索了 2 个模式 · 读取了 1 个文件 · 列了 1 个目录');
  });

  it('uses present tense when active', () => {
    const text = formatToolSummary({ searchCount: 1, readCount: 0, listCount: 0, tools: [] }, true);
    expect(text).toBe('搜索 1 个模式');
  });

  it('omits zero categories', () => {
    const text = formatToolSummary(
      { searchCount: 0, readCount: 3, listCount: 0, tools: [] },
      false,
    );
    expect(text).toBe('读取了 3 个文件');
  });
});

describe('formatDuration', () => {
  it('returns empty string for undefined', () => {
    expect(formatDuration(undefined)).toBe('');
  });
  it('returns empty string for sub-500ms (rounds to 0s)', () => {
    expect(formatDuration(400)).toBe('');
  });
  it('formats seconds', () => {
    expect(formatDuration(25_000)).toBe('25s');
  });
  it('formats minutes and seconds', () => {
    expect(formatDuration(6 * 60_000 + 17_000)).toBe('6m 17s');
  });
  it('formats whole minutes without seconds', () => {
    expect(formatDuration(2 * 60_000)).toBe('2m');
  });
});
