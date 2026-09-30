import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { conversationReducer, initialConversationState } from '@/renderer/conversation-reducer';
import { parsePromptInput, parseUserDecision } from '@/shared/conversation-ipc';
import type { ConversationRef, ModelChoice, PromptAttachment, UserDecision } from '@/shared/conversation-contract';

type ActiveLoad = { ref: ConversationRef; loadId: string; token: number };

function ignoreRejection(promise: Promise<unknown> | undefined): void {
  void Promise.resolve(promise).catch((): void => undefined);
}

export function useConversation(ref: ConversationRef | null) {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  const generation = useRef(0);
  const activeLoad = useRef<ActiveLoad | null>(null);
  const recoveredLoad = useRef<string | null>(null);

  // This listener is installed before any selection can open. The reducer
  // rejects every other selection/generation, which lets one subscription
  // safely cover the hook's whole lifetime.
  useEffect(() => window.fractal.conversations.onEvent((event) => dispatch(event)), []);

  useEffect(() => {
    if (!ref) {
      generation.current += 1;
      activeLoad.current = null;
      dispatch({ type: 'reset' });
      return;
    }

    const token = ++generation.current;
    const loadId = crypto.randomUUID();
    activeLoad.current = { ref, loadId, token };
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
      if (generation.current === token) {
        generation.current += 1;
        activeLoad.current = null;
      }
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

  const currentActiveLoad = useCallback((expectedRef: ConversationRef | null, expectedLoadId: string | null): ActiveLoad | null => {
    const active = activeLoad.current;
    if (!(expectedRef !== null
      && expectedLoadId !== null
      && active !== null
      && active.token === generation.current
      && active.loadId === expectedLoadId
      && active.ref.provider === expectedRef.provider
      && active.ref.nativeSessionId === expectedRef.nativeSessionId
      && active.ref.projectPath === expectedRef.projectPath)) return null;
    return active;
  }, []);

  const containActionSettlement = useCallback((promise: Promise<void>, active: ActiveLoad): Promise<void | undefined> =>
    promise.then(undefined, (cause: unknown) => {
      if (activeLoad.current === active && generation.current === active.token) throw cause;
    }), []);

  const send = useCallback((text: string, attachments: PromptAttachment[] = [], choice: ModelChoice | null = null): Promise<void | undefined> | undefined => {
    const active = currentActiveLoad(state.ref, state.loadId);
    if (!canSend || !active || !state.ref) return undefined;
    try {
      const prompt = parsePromptInput({ text, ...(attachments.length > 0 ? { attachments } : {}), ...(choice ?? {}) });
      return containActionSettlement(window.fractal.conversations.continue(state.ref, prompt), active);
    } catch {
      // The bridge never sees malformed renderer input.
      return undefined;
    }
  }, [canSend, containActionSettlement, currentActiveLoad, state.loadId, state.ref]);

  const interrupt = useCallback((): Promise<void | undefined> | undefined => {
    const active = currentActiveLoad(state.ref, state.loadId);
    if (!active || !state.ref) return undefined;
    return containActionSettlement(window.fractal.conversations.interrupt(state.ref), active);
  }, [containActionSettlement, currentActiveLoad, state.loadId, state.ref]);

  const resolveRequest = useCallback((requestId: string, decision: UserDecision): Promise<void | undefined> | undefined => {
    const active = currentActiveLoad(state.ref, state.loadId);
    if (!active || !state.ref) return undefined;
    try {
      return containActionSettlement(window.fractal.conversations.resolveRequest(requestId, parseUserDecision(decision)), active);
    } catch {
      // The bridge never sees malformed renderer input.
      return undefined;
    }
  }, [containActionSettlement, currentActiveLoad, state.loadId, state.ref]);

  const reload = useCallback(() => {
    if (state.ref) setReloadEpoch((epoch) => epoch + 1);
  }, [state.ref]);

  return {
    state,
    canSend,
    send,
    interrupt,
    resolveRequest,
    reload,
  };
}
