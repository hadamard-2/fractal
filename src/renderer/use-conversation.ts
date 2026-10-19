import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { conversationHub } from '@/renderer/conversation-hub';
import { initialConversationState } from '@/renderer/conversation-reducer';
import { parsePromptInput } from '@/shared/conversation-ipc';
import type { ConversationRef, ModelChoice, PromptAttachment, TurnAccess, UserDecision } from '@/shared/conversation-contract';

function sameRef(left: ConversationRef, right: ConversationRef): boolean {
  return left.provider === right.provider
    && left.nativeSessionId === right.nativeSessionId
    && left.projectPath === right.projectPath;
}

export function useConversation(ref: ConversationRef | null) {
  const hub = conversationHub();
  const state = useSyncExternalStore(hub.subscribe, () => (ref ? hub.state(ref) : initialConversationState));
  // The ref this view holds a lease on; null between its release and the next acquire.
  const lease = useRef<ConversationRef | null>(null);

  useEffect(() => {
    if (!ref) return;
    const release = hub.acquire(ref);
    lease.current = ref;
    return () => {
      lease.current = null;
      release();
    };
  }, [hub, ref?.provider, ref?.nativeSessionId, ref?.projectPath]);

  // Callbacks act only for the load they were rendered with, and only while
  // this view still holds it: another view may keep the load open after this
  // one lets go, or reload it under a fresh load id.
  const holds = useCallback((expectedRef: ConversationRef | null, expectedLoadId: string | null): expectedRef is ConversationRef =>
    expectedRef !== null
    && expectedLoadId !== null
    && lease.current !== null
    && sameRef(lease.current, expectedRef)
    && hub.state(expectedRef).loadId === expectedLoadId, [hub]);

  const containActionSettlement = useCallback((promise: Promise<void | undefined> | undefined, expectedRef: ConversationRef, expectedLoadId: string): Promise<void | undefined> | undefined =>
    promise?.then(undefined, (cause: unknown) => {
      if (holds(expectedRef, expectedLoadId)) throw cause;
    }), [holds]);

  const canSend = ref !== null && hub.canSend(ref);

  const send = useCallback((text: string, attachments: PromptAttachment[] = [], choice: ModelChoice | null = null, access: TurnAccess | null = null): Promise<void | undefined> | undefined => {
    const target = state.ref;
    const loadId = state.loadId;
    if (!loadId || !holds(target, loadId)) return undefined;
    try {
      const prompt = parsePromptInput({ text, ...(attachments.length > 0 ? { attachments } : {}), ...(choice ?? {}), ...(access ? { access } : {}) });
      return containActionSettlement(hub.send(target, prompt), target, loadId);
    } catch {
      // The bridge never sees malformed renderer input.
      return undefined;
    }
  }, [containActionSettlement, holds, hub, state.loadId, state.ref]);

  const interrupt = useCallback((): Promise<void | undefined> | undefined => {
    const target = state.ref;
    const loadId = state.loadId;
    if (!loadId || !holds(target, loadId)) return undefined;
    return containActionSettlement(hub.interrupt(target), target, loadId);
  }, [containActionSettlement, holds, hub, state.loadId, state.ref]);

  const resolveRequest = useCallback((requestId: string, decision: UserDecision): Promise<void | undefined> | undefined => {
    const target = state.ref;
    const loadId = state.loadId;
    if (!loadId || !holds(target, loadId)) return undefined;
    return containActionSettlement(hub.resolveRequest(target, requestId, decision), target, loadId);
  }, [containActionSettlement, holds, hub, state.loadId, state.ref]);

  const reload = useCallback(() => {
    if (state.ref) hub.reload(state.ref);
  }, [hub, state.ref]);

  return {
    state,
    canSend,
    send,
    interrupt,
    resolveRequest,
    reload,
  };
}
