import { z } from 'zod';
import type { QuestionField } from '@/shared/conversation-contract';

// passthrough, not strict: a question with fields this module does not read must still reach the user rather than be denied as invalid.
const QUESTION_INPUT = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().min(1),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() }).passthrough()).optional(),
    multiSelect: z.boolean().optional(),
  }).passthrough()).min(1),
}).passthrough();

/**
 * The questions in an AskUserQuestion input, each keyed by its own text, which is how
 * the tool's output keys answers. Undefined when the input is unreadable or repeats a question.
 */
export function claudeQuestionFields(input: unknown): QuestionField[] | undefined {
  const parsed = QUESTION_INPUT.safeParse(input);
  if (!parsed.success) return undefined;
  const prompts = parsed.data.questions.map((question) => question.question);
  if (new Set(prompts).size !== prompts.length) return undefined;
  // Claude Code always lets the user type their own answer, so Other is offered whether or not there are options.
  return parsed.data.questions.map((question) => ({
    fieldId: question.question, prompt: question.question,
    ...(question.options ? { choices: question.options.map((option) => ({ value: option.label, label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
    allowFreeText: true,
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}
