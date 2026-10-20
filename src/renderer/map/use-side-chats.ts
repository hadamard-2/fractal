import { useCallback, useEffect, useRef, useState } from 'react';
import { onSideChatsChanged } from '@/renderer/side-chat-events';
import { conversationKey, type ConversationRef, type SideChatSummary } from '@/shared/conversation-contract';

const NONE: SideChatSummary[] = [];

/** The side chats below `ref`, reached through side-chat parents; forks and the conversations around them don't count. */
export function sideChatsBelow(sideChats: readonly SideChatSummary[], ref: ConversationRef): SideChatSummary[] {
  const reached = new Set([conversationKey(ref)]);
  const below: SideChatSummary[] = [];
  // Parents come before children in the listing, so one pass reaches every depth.
  for (const summary of sideChats) {
    if (!reached.has(summary.parentKey) || reached.has(conversationKey(summary.ref))) continue;
    reached.add(conversationKey(summary.ref));
    below.push(summary);
  }
  return below;
}

/**
 * The side chats under `root`, parents before children. Listed when the root
 * changes, on `refresh()` and when `announceSideChats` names the root; a later
 * listing always wins over an earlier one, and a failed listing keeps what's
 * shown. `listed` is false until the first listing for the current root
 * resolves, so an empty `sideChats` before then isn't taken for none.
 */
export function useSideChats(root: ConversationRef | null): { sideChats: SideChatSummary[]; listed: boolean; refresh(): Promise<void> } {
  const key = root ? conversationKey(root) : null;
  const latestRoot = useRef(root);
  latestRoot.current = root;
  const requests = useRef(0);
  const [listed, setListed] = useState<{ key: string; sideChats: SideChatSummary[] } | null>(null);

  const refresh = useCallback(async () => {
    const ref = latestRoot.current;
    if (!ref) return;
    const request = ++requests.current;
    try {
      const sideChats = await window.fractal.conversations.sideChats(ref);
      if (request === requests.current) setListed({ key: conversationKey(ref), sideChats });
    } catch {
      // Keep what's shown; the next refresh tries again.
    }
  }, []);

  useEffect(() => {
    if (key !== null) void refresh();
  }, [key, refresh]);

  useEffect(() => {
    if (key === null) return undefined;
    return onSideChatsChanged((rootKey) => { if (rootKey === key) void refresh(); });
  }, [key, refresh]);

  const current = listed !== null && listed.key === key;
  return { sideChats: current ? listed.sideChats : NONE, listed: current, refresh };
}
