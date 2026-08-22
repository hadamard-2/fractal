import { useCallback, useEffect, useState } from 'react';
import type { AgentEvent } from '@/shared/agent-contract';
import { initialState, reduce, type ConversationState } from '@/renderer/conversation-reducer';

type Status = 'ready' | 'submitted' | 'streaming';

export function useConversation(conversationId: string | null) {
  const [state, setState] = useState<ConversationState>(() => initialState());
  const [status, setStatus] = useState<Status>('ready');

  useEffect(() => {
    setState(initialState());
    if (!conversationId) return;
    let cancelled = false;
    // Events can arrive over the wire before the getConversation() round
    // trip resolves. Applying them straight into an empty pre-seed state
    // would silently no-op (their entryId doesn't exist yet), and then
    // seeding from the snapshot afterwards would discard that progress for
    // good. So buffer everything until the snapshot lands, then seed and
    // replay only the buffered events the snapshot hasn't already captured
    // (seq > snapshot.seq) — seq makes "already captured" decidable instead
    // of guesswork.
    // `settled` covers both outcomes of the snapshot fetch: once it resolves
    // or rejects, there is no longer a baseline still in flight to buffer
    // against, so further events are either applied live (resolved) or
    // simply not collected (rejected — a snapshot that never arrives means
    // buffered events could never be correctly ordered against it anyway).
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
        if (cancelled) return;
        let seeded = initialState(snap ?? undefined);
        for (const event of buffered) {
          if (event.seq > seeded.seq) seeded = reduce(seeded, event);
        }
        setState(seeded);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        buffered.length = 0; // no baseline is coming; nothing to replay against
        setState((s) => ({ ...s, snapshotError: err instanceof Error ? err.message : String(err) }));
      })
      .finally(() => {
        settled = true;
      });

    return () => {
      cancelled = true;
      unsub();
    };
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
  };
}
