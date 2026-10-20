import { createContext, useContext } from 'react';
import type { ConversationRef, ConversationTurn } from '@/shared/conversation-contract';

/** Opens side chats in the right panel. Null outside the right workspace, or when no project is open. */
export interface SideChatLauncher {
  /** A new, unsent side chat after `turn`'s reply in `parent`, opening with `text` in its composer. */
  start(input: { root: ConversationRef; parent: ConversationRef; turn: ConversationTurn; text: string }): void;
  /** An existing side chat: its open tab if it has one, otherwise a new tab. */
  open(input: { root: ConversationRef; sideChat: ConversationRef; branchPointText?: string }): void;
}

export const SideChatLauncherContext = createContext<SideChatLauncher | null>(null);

export const useSideChatLauncher = () => useContext(SideChatLauncherContext);
