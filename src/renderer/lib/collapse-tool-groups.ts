// Collapses consecutive read-only tool calls into compact summary groups,
// mirroring Claude Code's "Searched for 2 patterns, read 1 file" behavior.
//
// READ tools (read_file, search_logs, list_hosts, read-only exec, etc.) are
// grouped into a ToolSummarySegment so they render as one summary line instead
// of N separate cards. WRITE/SUDO/BLOCKED tools stay as individual cards.
//
// Within a summary group, tools are subcategorized by verb:
//   - search: search_logs, journal_query, grep/find/rg
//   - list:   list_hosts, ls/tree/du
//   - read:   read_file, read_tool_result, cat/ps/df and other read-only exec

import type { ToolCallCard } from '../store/agentStore.js';

export type ReadVerb = 'search' | 'read' | 'list';

export interface ToolSummaryGroup {
  searchCount: number;
  readCount: number;
  listCount: number;
  tools: ToolCallCard[];
}

export type ToolSegment =
  | { kind: 'tool'; card: ToolCallCard } // non-collapsible (WRITE/SUDO/BLOCKED)
  | { kind: 'tool-summary'; group: ToolSummaryGroup }; // collapsed READ group

// Classify a READ tool call into its verb for summary wording.
export function classifyReadVerb(card: ToolCallCard): ReadVerb {
  const name = card.toolName;
  if (name === 'search_logs' || name === 'journal_query') return 'search';
  if (name === 'list_hosts') return 'list';
  if (
    name === 'read_file' ||
    name === 'read_tool_result' ||
    name === 'read_skill_file' ||
    name === 'get_skill_content'
  ) {
    return 'read';
  }
  // Generic read-only exec (ls, cat, grep, ps, df, ...). Parse the command's
  // first word - good enough for the common ops commands.
  const cmd = (card.command ?? '').trim();
  const firstWord = (cmd.split(/\s+/)[0] ?? '').replace(/^sudo\s+/, '');
  if (/^(grep|rg|egrep|fgrep|find|ag|ack)$/.test(firstWord) || /\bgrep\b/.test(cmd)) {
    return 'search';
  }
  if (/^(ls|ll|tree|du|lsblk|lsof|stat)$/.test(firstWord)) {
    return 'list';
  }
  return 'read';
}

export function collapseToolGroups(cards: ToolCallCard[]): ToolSegment[] {
  const result: ToolSegment[] = [];
  let current: ToolSummaryGroup | null = null;

  const flush = (): void => {
    if (current && current.tools.length > 0) {
      result.push({ kind: 'tool-summary', group: current });
    }
    current = null;
  };

  for (const card of cards) {
    if (card.commandType === 'READ') {
      if (!current) {
        current = { searchCount: 0, readCount: 0, listCount: 0, tools: [] };
      }
      const verb = classifyReadVerb(card);
      if (verb === 'search') current.searchCount++;
      else if (verb === 'list') current.listCount++;
      else current.readCount++;
      current.tools.push(card);
    } else {
      flush();
      result.push({ kind: 'tool', card });
    }
  }
  flush();
  return result;
}

// Format a summary group into localized text like "搜索了 2 个模式 · 读取了 1 个文件".
// `active` controls present vs past tense (进行中 vs 已完成).
export function formatToolSummary(group: ToolSummaryGroup, active: boolean): string {
  const parts: string[] = [];
  if (group.searchCount > 0) {
    parts.push(`${active ? '搜索' : '搜索了'} ${group.searchCount} 个模式`);
  }
  if (group.readCount > 0) {
    parts.push(`${active ? '读取' : '读取了'} ${group.readCount} 个文件`);
  }
  if (group.listCount > 0) {
    parts.push(`${active ? '列出' : '列了'} ${group.listCount} 个目录`);
  }
  return parts.join(' · ');
}

// Format a duration in milliseconds as a compact Chinese string: "6m 17s",
// "25s", "1s". Returns '' for undefined/zero.
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 500) return '';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
