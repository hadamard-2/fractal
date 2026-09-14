import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { conversationReducer, initialConversationState } from '@/renderer/conversation-reducer';
import { parsePromptInput, parseUserDecision } from '@/shared/conversation-ipc';
import type { Entry } from '@/shared/agent-contract';
import type { ConversationRef, UserDecision } from '@/shared/conversation-contract';

function ignoreRejection(promise: Promise<unknown> | undefined): void {
  void Promise.resolve(promise).catch((): void => undefined);
}

export function useConversation(selectedRef: ConversationRef | string | null) {
  // Execute's legacy panel still passes its pre-migration string selection.
  // It receives an inert compatibility surface until Tasks 12–13 switch it
  // to native refs; all transcript state below remains native-provider owned.
  const ref = typeof selectedRef === 'string' ? null : selectedRef;
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const generation = useRef(0);
  const recoveredLoad = useRef<string | null>(null);

  // This listener is installed before any selection can open. The reducer
  // rejects every other selection/generation, which lets one subscription
  // safely cover the hook's whole lifetime.
  useEffect(() => window.fractal.conversations.onEvent((event) => dispatch(event)), []);

  useEffect(() => {
    if (!ref) {
      generation.current += 1;
      dispatch({ type: 'reset' });
      return;
    }

    const token = ++generation.current;
    const loadId = crypto.randomUUID();
    dispatch({ type: 'opened', ref, loadId });

    ignoreRejection(window.fractal.conversations.open(ref, loadId).then(
      (result) => {
        if (generation.current !== token) return;
        dispatch({ type: 'open.succeeded', ref, loadId, ...result });
      },
      (cause: unknown) => {
        if (generation.current !== token) return;
        dispatch({
          type: 'open.failed',
          ref,
          loadId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    ));

    return () => {
      if (generation.current === token) generation.current += 1;
      ignoreRejection(window.fractal.conversations.close(ref));
    };
  }, [ref?.provider, ref?.nativeSessionId, ref?.projectPath, reloadEpoch]);

  // A hole means there is no safe interpretation for later events. Reopen
  // once for that generation, allowing native history to become the baseline.
  useEffect(() => {
    if (state.sync !== 'gap' || !state.ref || !state.loadId || recoveredLoad.current === state.loadId) return;
    recoveredLoad.current = state.loadId;
    setReloadEpoch((epoch) => epoch + 1);
  }, [state.loadId, state.ref, state.sync]);

  const canSend = state.ref !== null
    && state.history === 'complete'
    && state.sync === 'current'
    && (state.runtime === 'idle' || (state.runtime === 'active-in-fractal' && state.capabilities?.steerWhileRunning === true));

  const send = useCallback((text: string) => {
    if (!canSend || !state.ref) return;
    try {
      const prompt = parsePromptInput({ text });
      ignoreRejection(window.fractal.conversations.continue(state.ref, prompt));
    } catch {
      // The bridge never sees malformed renderer input.
    }
  }, [canSend, state.ref]);

  const interrupt = useCallback(() => {
    if (!state.ref) return;
    ignoreRejection(window.fractal.conversations.interrupt(state.ref));
  }, [state.ref]);

  const resolveRequest = useCallback((requestId: string, decision: UserDecision) => {
    if (!state.ref) return;
    try {
      ignoreRejection(window.fractal.conversations.resolveRequest(requestId, parseUserDecision(decision)));
    } catch {
      // The bridge never sees malformed renderer input.
    }
  }, [state.ref]);

  const reload = useCallback(() => {
    if (state.ref) setReloadEpoch((epoch) => epoch + 1);
  }, [state.ref]);

  return {
    state,
    canSend,
    send,
    interrupt,
    resolveRequest,
    // Transitional aliases keep the pre-native panel type-safe without
    // synthesizing a transcript from optimistic renderer state.
    entries: [] as Entry[],
    missedEvents: state.sync === 'gap',
    snapshotError: state.error,
    status: 'ready' as const,
    cancel: interrupt,
    reload,
  };
}
