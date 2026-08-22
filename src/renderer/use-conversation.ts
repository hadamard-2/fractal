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
  // Tracks the unsubscribe for whichever subscription is currently live —
  // the mount effect's, or a later reload()'s replacement of it — so
  // whoever tears down (the effect's cleanup, or the next reload()) always
  // closes the subscription that is actually live rather than a stale one
  // captured in an old closure.
  const unsubRef = useRef<(() => void) | null>(null);
  // True once this conversation's mount effect has torn down (unmount, or
  // conversationId changing out from under it). Shared by both the mount
  // path's and reload()'s isCancelled, so an in-flight snapshot fetch from
  // either path is a no-op once the hook is no longer showing this
  // conversation — the same guarantee the mount path already had.
  const unmountedRef = useRef(false);
  const reloadingRef = useRef(false);

  useEffect(() => {
    setState(initialState());
    unmountedRef.current = false;
    if (!conversationId) return;

    const unsub = subscribeAndSeed(conversationId, setState, () => unmountedRef.current);
    unsubRef.current = unsub;

    return () => {
      unmountedRef.current = true;
      // Close through the ref, not the `unsub` this closure captured: by
      // the time this cleanup runs, reload() may have already replaced
      // unsubRef.current with a newer subscription's unsub, and it is that
      // live one — not this effect's original — that must be torn down.
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [conversationId]);

  // Exposed so the UI can recover from a holed transcript (missedEvents) or
  // a failed initial load (snapshotError) without remounting the component —
  // nothing in the current UI can otherwise force that remount. Guarded by
  // reloadingRef so a reload racing an in-flight one is a no-op rather than
  // a second overlapping subscription, and by unmountedRef so a reload's
  // in-flight snapshot fetch cannot land on an unmounted hook.
  const reload = useCallback(() => {
    if (!conversationId || reloadingRef.current) return;
    reloadingRef.current = true;
    unsubRef.current?.();

    const unsub = subscribeAndSeed(conversationId, setState, () => unmountedRef.current, () => {
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
