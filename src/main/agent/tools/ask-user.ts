import { z } from 'zod';
import { tool } from 'ai';

// AskUserQuestion tool (P1-4).
//
// Allows the agent to proactively ask the user a clarifying question when:
//   - The requirement is ambiguous and the model can't determine the path
//   - Authorization was denied multiple times and the model needs direction
//   - A decision is needed between multiple valid approaches
//
// Mirrors the callback pattern from exit-plan-mode.ts: the execute function
// calls onAskUser(questions) which sends the questions to the renderer for
// display in a modal dialog, and resolves with the user's answers.

const AskUserOptionSchema = z.object({
  label: z.string().min(1).describe('Short option label (1-5 words)'),
  description: z
    .string()
    .optional()
    .describe('Explanation of what this option means or implies'),
});

const AskUserQuestionItemSchema = z.object({
  question: z.string().min(1).describe('The question to ask the user'),
  header: z
    .string()
    .min(1)
    .max(12)
    .describe('Very short label displayed as a chip/tag (max 12 chars)'),
  options: z
    .array(AskUserOptionSchema)
    .min(2)
    .max(4)
    .describe('2-4 mutually exclusive options'),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('Allow multiple selections (default false)'),
});

const AskUserInputSchema = z.object({
  questions: z
    .array(AskUserQuestionItemSchema)
    .min(1)
    .max(4)
    .describe('1-4 questions to ask the user'),
});

// Re-exported for use in tools.ts and types
export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserAnswer {
  question: string;
  // Selected label(s). For multi-select, joined by ", ".
  // For "Other" (free text), the user's typed input.
  answer: string;
  // True if the user selected the "Other" option and typed a custom response.
  isOther?: boolean;
  // The raw notes if the user provided additional context.
  notes?: string;
}

export type AskUserCallback = (
  questions: AskUserQuestionItem[],
) => Promise<AskUserAnswer[]>;

export function createAskUserTool(onAskUser: AskUserCallback) {
  return tool({
    description:
      'Ask the user a clarifying question when the requirement is ambiguous, ' +
      'an action was denied multiple times, or you need a decision between approaches. ' +
      'Do NOT use this for simple confirmations (the authorization flow handles that). ' +
      'Limit: 5 calls per session. Each question must have 2-4 options that are ' +
      'mutually exclusive. The user can also select "Other" to type a custom response.',
    parameters: AskUserInputSchema,
    execute: async ({
      questions,
    }: {
      questions: AskUserQuestionItem[];
    }): Promise<{ answers: AskUserAnswer[] }> => {
      const answers = await onAskUser(questions);
      return { answers };
    },
  });
}
