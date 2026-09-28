import type { AgentPrompt } from '@/main/harness/types';

const ABSOLUTE = /^(\/|\\|[A-Za-z]:[\\/])/;
const TRAILING_BLOCK = /(?:^|\n\n)<attachments>\n((?:[^\n]+\n)+)<\/attachments>$/;

/** The text an agent receives: the user's text, then non-image attachments as a trailing block of absolute paths. */
export function composePromptText(prompt: AgentPrompt): string {
  const files = (prompt.attachments ?? []).filter((attachment) => !attachment.image).map((attachment) => attachment.path);
  if (files.length === 0) return prompt.text;
  const block = ['<attachments>', ...files, '</attachments>'].join('\n');
  return prompt.text.trim() ? `${prompt.text}\n\n${block}` : block;
}

/** The inverse of composePromptText for a block at the very end of a message; anything else stays text. */
export function splitAttachmentBlock(text: string): { text: string; paths: string[] } {
  const match = TRAILING_BLOCK.exec(text);
  if (!match) return { text, paths: [] };
  const paths = match[1].slice(0, -1).split('\n');
  if (!paths.every((path) => ABSOLUTE.test(path))) return { text, paths: [] };
  return { text: text.slice(0, match.index), paths };
}
