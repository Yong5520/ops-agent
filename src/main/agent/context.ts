import type { CoreMessage } from 'ai';
import { sessionsStore } from '../storage/sessions.js';
import { logger } from '../utils/logger.js';

// Context manager — handles message history loading, format conversion,
// and summary compression for the agent loop.
//
// Messages are stored in the DB as { role, content } rows. The AI SDK
// expects CoreMessage[] with role 'user' | 'assistant' | 'system' and
// content as string or structured parts. For the MVP we use simple text
// content — tool call results are embedded as assistant/user text messages.

// Approximate token estimate: 1 token ≈ 4 chars for English, ≈ 1.5 chars for
// Chinese. We use a conservative 3 chars/token average.
const CHARS_PER_TOKEN = 3;
const SUMMARIZE_THRESHOLD_TOKENS = 80_000;

// Load session messages and convert to AI SDK CoreMessage[].
export function loadMessages(sessionId: string): CoreMessage[] {
  const messages = sessionsStore.listMessages(sessionId);
  return messages
    .filter((m) => m.role !== 'system') // system prompt is built separately
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}

// Save a user message and assistant response to the DB.
export function saveTurn(sessionId: string, userMessage: string, assistantMessage: string): void {
  sessionsStore.addMessage({
    sessionId,
    role: 'user',
    content: userMessage,
  });
  sessionsStore.addMessage({
    sessionId,
    role: 'assistant',
    content: assistantMessage,
  });
}

// Save just a user message (the assistant message is saved after streaming completes).
export function saveUserMessage(sessionId: string, content: string): void {
  sessionsStore.addMessage({ sessionId, role: 'user', content });
}

// Save the assistant's final response after streaming completes.
export function saveAssistantMessage(sessionId: string, content: string): void {
  sessionsStore.addMessage({ sessionId, role: 'assistant', content });
}

// Estimate token count for a message array.
export function estimateTokens(messages: CoreMessage[]): number {
  const totalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// Compress context when it exceeds the threshold. Keeps the most recent
// messages intact and replaces older ones with a summary placeholder.
// This is a simple implementation — a proper version would use the model
// to generate the summary, but that adds latency and cost. For MVP we
// just truncate with a note.
export function compressContext(messages: CoreMessage[]): CoreMessage[] {
  const tokenCount = estimateTokens(messages);
  if (tokenCount <= SUMMARIZE_THRESHOLD_TOKENS) {
    return messages;
  }

  logger.info(
    `Context exceeds threshold (${tokenCount} tokens), compressing from ${messages.length} messages`,
  );

  // Keep the first message (initial user request) and the most recent 20 messages.
  // Replace everything in between with a summary marker.
  if (messages.length <= 22) {
    return messages; // not enough to compress
  }

  const first = messages[0];
  const recent = messages.slice(-20);
  const dropped = messages.length - 21;
  const summary: CoreMessage = {
    role: 'system',
    content: `[上下文压缩] 之前 ${dropped} 条消息已被省略以节省 token。以下是最近的对话历史：`,
  };

  return [first, summary, ...recent];
}

// Build the full message array for the AI SDK call, including the new user message.
export function buildMessagesForCall(
  history: CoreMessage[],
  newUserMessage: string,
): CoreMessage[] {
  return [...history, { role: 'user' as const, content: newUserMessage }];
}
