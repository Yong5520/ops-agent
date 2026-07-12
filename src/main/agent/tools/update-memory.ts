import { z } from 'zod';
import { tool } from 'ai';
import { appendToMemory } from '../memory/automem.js';

// update_memory tool - lets the agent write to persistent MEMORY.md.
//
// Use cases:
//   - Record host characteristics (e.g., "host-A nginx logs at /var/log/nginx/")
//   - Record user preferences (e.g., "user prefers using systemctl over service")
//   - Record diagnostic conclusions (e.g., "host-B disk full due to /var/log/journal")
//   - Record recurring patterns
//
// Do NOT store: sensitive info (passwords, keys), session-specific context.

const UpdateMemoryInputSchema = z.object({
  content: z.string().min(1).describe('The memory content to save'),
  section: z
    .string()
    .optional()
    .describe('Optional section header for the memory entry'),
});

export function createUpdateMemoryTool() {
  return tool({
    description:
      'Write to persistent memory (MEMORY.md). Use for: user preferences, host characteristics, ' +
      'diagnostic conclusions, recurring patterns. Do NOT store sensitive info or session-specific context. ' +
      'Memory persists across sessions and is loaded into the system prompt automatically.',
    parameters: UpdateMemoryInputSchema,
    execute: async ({ content, section }) => {
      try {
        appendToMemory(content, section);
        return {
          success: true,
          message: `Memory updated${section ? ` in section "${section}"` : ''}`,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to update memory: ${(err as Error).message}`,
        };
      }
    },
  });
}
