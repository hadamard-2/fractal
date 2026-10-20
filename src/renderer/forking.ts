import type { ConversationState } from '@/renderer/conversation-reducer';
import { canBranchTurn } from '@/renderer/side-chat-branching';
import type { ConversationTurn, ForkPoint } from '@/shared/conversation-contract';

export interface ForkDraftFile {
  filename: string;
  mediaType: string;
  url: string;
  path?: string;
}

export interface ForkDraft {
  text: string;
  files: ForkDraftFile[];
}

/** Whether "Fork from here" is offered at this point: after a reply, or before your own message. */
export function canForkAt(state: ConversationState, turnId: string, position: ForkPoint['position'], readOnly: boolean): boolean {
  if (readOnly || state.history !== 'complete' || !state.capabilities?.fork) return false;
  const index = state.turns.findIndex((turn) => turn.id === turnId);
  if (index === -1) return false;
  // Before a message the fork keeps everything ahead of it, so the turn ahead is the last one inherited.
  const inherited = position === 'after' ? state.turns[index] : state.turns[index - 1];
  return !inherited || canBranchTurn(inherited, state.runtime, readOnly);
}

/** Your message as a fork's composer starts with it: its text, its inline images as data URLs, and its file attachments by path. */
export function forkDraftOf(turn: ConversationTurn): ForkDraft {
  const { text, images = [], attachments = [] } = turn.userMessage;
  return {
    text,
    files: [
      ...images.map((image): ForkDraftFile => ({
        filename: `image.${image.mediaType.slice(image.mediaType.indexOf('/') + 1)}`,
        mediaType: image.mediaType,
        url: `data:${image.mediaType};base64,${image.data}`,
      })),
      // The composer has no preview for a path, so it shows as a file chip.
      ...attachments.map((attachment): ForkDraftFile => ({
        filename: attachment.path.slice(attachment.path.lastIndexOf('/') + 1),
        mediaType: 'application/octet-stream',
        url: '',
        path: attachment.path,
      })),
    ],
  };
}

const drafts = new Map<string, ForkDraft>();

export function setForkDraft(conversationKey: string, draft: ForkDraft): void {
  drafts.set(conversationKey, draft);
}

export function forkDraft(conversationKey: string): ForkDraft | undefined {
  return drafts.get(conversationKey);
}

export function clearForkDraft(conversationKey: string): void {
  drafts.delete(conversationKey);
}
