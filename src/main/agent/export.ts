import { sessionsStore } from '../storage/sessions.js';
import { hostsStore } from '../storage/hosts.js';

// Session export — converts a session + its messages to a Markdown document
// suitable for sharing, archiving, or pasting into documentation.

export interface SessionExport {
  markdown: string;
  filename: string;
}

export function exportSessionToMarkdown(sessionId: string): SessionExport {
  const session = sessionsStore.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const messages = sessionsStore.listMessages(sessionId);
  const selectedHosts = (session.hostIds ?? [])
    .map((id) => hostsStore.get(id))
    .filter((h): h is NonNullable<typeof h> => h !== null);

  const lines: string[] = [];

  // Header
  lines.push(`# ${session.title ?? `会话 ${session.id.slice(0, 8)}`}`);
  lines.push('');
  lines.push(`**导出时间：** ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`**创建时间：** ${session.createdAt}`);
  lines.push(`**安全模式：** ${session.safetyMode}`);
  if (selectedHosts.length > 0) {
    const hostSummary = selectedHosts.map((h) => `${h.name} (${h.host}:${h.port})`).join(', ');
    lines.push(`**目标主机：** ${hostSummary}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Messages
  for (const msg of messages) {
    const timestamp = new Date(msg.createdAt).toLocaleString('zh-CN');
    const roleLabel =
      msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 OpsAgent' : '系统';

    lines.push(`### ${roleLabel}`);
    lines.push(`> ${timestamp}`);
    lines.push('');
    lines.push(msg.content);
    lines.push('');
  }

  const markdown = lines.join('\n');
  const safeTitle = (session.title ?? session.id.slice(0, 8)).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  const filename = `session-${safeTitle}-${new Date().toISOString().slice(0, 10)}.md`;

  return { markdown, filename };
}
