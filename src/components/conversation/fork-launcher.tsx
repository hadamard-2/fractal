import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { forkDraftOf, setForkDraft } from '@/renderer/forking';
import { conversationKey, type ConversationRef, type ConversationTurn, type ForkPoint } from '@/shared/conversation-contract';

/** Makes forks and opens them. Null where nothing provides one. */
export interface ForkLauncher {
  /** Forks `source` after `turn`'s reply or before its message, then opens the fork in Execute. Rejects with the agent's error. */
  fork(source: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): Promise<void>;
  /** True while a fork is being made; every "Fork from here" is hidden meanwhile. */
  pending: boolean;
}

export const ForkLauncherContext = createContext<ForkLauncher | null>(null);

export const useForkLauncher = () => useContext(ForkLauncherContext);

/** The launcher App provides; `open` shows the new fork in Execute. */
export function useForkLauncherValue(open: (ref: ConversationRef) => void): ForkLauncher {
  const [pending, setPending] = useState(false);
  const fork = useCallback(async (source: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']) => {
    setPending(true);
    try {
      const ref = await window.fractal.conversations.fork(source, { turnId: turn.id, position }, 'fork');
      // Forking before a message leaves it out of the fork, so the fork's composer starts with it, ready to edit and resend.
      if (position === 'before') setForkDraft(conversationKey(ref), forkDraftOf(turn));
      open(ref);
    } finally {
      setPending(false);
    }
  }, [open]);
  return useMemo(() => ({ fork, pending }), [fork, pending]);
}
