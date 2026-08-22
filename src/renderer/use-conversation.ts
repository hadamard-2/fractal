import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@/shared/agent-contract';
import { initialState, reduce, type ConversationState } from '@/renderer/conversation-reducer';

type Status = 'ready' | 'submitted' | 'streaming';

// Subscribes to live events and seeds state from a fresh snapshot, without
// losing events that arrive while the snapshot round trip is in flight.
// Used both by the mount effect and by reload() — one implementation of this
// sequence, not two that can drift.
//
// Events can arrive over the wire before the getConversation() round trip
// resolves. Applying them straight into an empty pre-seed state would
// silently no-op (their entryId doesn't exist yet), and then seeding from
// the snapshot afterwards would discard that progress for good. So buffer
// everything until the snapshot lands, then seed and replay only the
// buffered events the snapshot hasn't already captured (seq > snapshot.seq)
// — seq makes "already captured" decidable instead of guesswork.
//
// `settled` covers both outcomes of the snapshot fetch: once it resolves or
// rejects, there is no longer a baseline still in flight to buffer against,
// so further events are either applied live (resolved) or simply not
// collected (rejected — a snapshot that never arrives means buffered events
// could never be correctly ordered against it anyway).
//
// Returns an unsubscribe function; the caller is responsible for tracking
// `cancelled` so a stale fetch resolving after teardown is a no-op.
function subscribeAndSeed(
  conversationId: string,
  setState: (updater: ConversationState | ((s: ConversationState) => ConversationState)) => void,
  isCancelled: () => boolean,
  onSettled?: () => void,
): () => void {
  let settled = false;
  const buffered: AgentEvent[] = [];

  const unsub = window.fractal.agent.onAgentEvent((event) => {
    if (event.conversationId !== conversationId) return;
    if (!settled) {
      buffered.push(event);
      return;
    }
    setState((s) => (s.snapshotError ? s : reduce(s, event)));
  });

  void window.fractal.agent
    .getConversation(conversationId)
    .then((snap) => {
      if (isCancelled()) return;
      let seeded = initialState(snap ?? undefined);
      for (const event of buffered) {
        if (event.seq > seeded.seq) seeded = reduce(seeded, event);
      }
      setState(seeded);
    })
    .catch((err: unknown) => {
      if (isCancelled()) return;
      buffered.length = 0; // no baseline is coming; nothing to replay against
      setState((s) => ({ ...s, snapshotError: err instanceof Error ? err.message : String(err) }));
    })
    .finally(() => {
      settled = true;
      onSettled?.();
    });

  return unsub;
}

export function useConversation(conversationId: string | null) {
  const [state, setState] = useState<ConversationState>(() => initialState());
  const [status, setStatus] = useState<Status>('ready');
  // Tracks the unsubscribe for whichever subscription is currently live, so
  // reload() can tear down the mount effect's subscription before starting
  // its own.
  const unsubRef = useRef<(() => void) | null>(null);
  const reloadingRef = useRef(false);

  useEffect(() => {
    setState(initialState());
    if (!conversationId) return;
    let cancelled = false;

    const unsub = subscribeAndSeed(conversationId, setState, () => cancelled);
    unsubRef.current = unsub;

    return () => {
      cancelled = true;
      unsub();
      if (unsubRef.current === unsub) unsubRef.current = null;
    };
  }, [conversationId]);

  // Exposed so the UI can recover from a holed transcript (missedEvents) or
  // a failed initial load (snapshotError) without remounting the component —
  // nothing in the current UI can otherwise force that remount. Guarded by
  // reloadingRef so a reload racing an in-flight one is a no-op rather than
  // a second overlapping subscription.
  const reload = useCallback(() => {
    if (!conversationId || reloadingRef.current) return;
    reloadingRef.current = true;
    unsubRef.current?.();

    // reload() is a one-shot action, not an effect, so there is no unmount
    // to race against beyond what reloadingRef already guards (a second
    // reload) and the mount effect already guards (conversationId changing
    // out from under it, which unsubscribes via unsubRef above).
    const unsub = subscribeAndSeed(conversationId, setState, () => false, () => {
      reloadingRef.current = false;
    });
    unsubRef.current = unsub;
  }, [conversationId]);

  useEffect(() => {
    const last = state.entries.at(-1);
    if (last?.author === 'agent' && last.status === 'streaming') {
      setStatus(last.parts.length === 0 ? 'submitted' : 'streaming');
    } else {
      setStatus('ready');
    }
  }, [state.entries]);

  const send = useCallback(
    (text: string) => {
      if (!conversationId) return;
      void window.fractal.agent.sendMessage({ conversationId, text });
    },
    [conversationId],
  );

  const cancel = useCallback(() => {
    if (!conversationId) return;
    void window.fractal.agent.cancelTurn({ conversationId });
  }, [conversationId]);

  const createConversation = useCallback(() => window.fractal.agent.createConversation(), []);

  return {
    entries: state.entries,
    missedEvents: state.missedEvents,
    snapshotError: state.snapshotError,
    status,
    send,
    cancel,
    createConversation,
    reload,
  };
}
