import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { BlockingRequest } from '@/components/conversation/blocking-request';
import { VirtualTimeline } from '@/components/conversation/virtual-timeline';
import { Button } from '@/components/ui/button';
import { useConversation } from '@/renderer/use-conversation';
import { conversationKey, type ConversationRef, type TurnBlock, type UserDecision } from '@/shared/conversation-contract';

// The transcript and composer share a reading measure at every panel width.
const COLUMN = 'px-4 lg:px-[8%] xl:px-[14%] 2xl:px-[20%]';

function NativeConversationPanel({ conversationRef }: { conversationRef: ConversationRef }) {
  const { state, canSend, send, interrupt, resolveRequest, reload } = useConversation(conversationRef);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingSend = useRef<object | null>(null);
  useLayoutEffect(() => {
    pendingSend.current = null;
    setSending(false);
    setStopping(false);
    setActionError(null);
    return () => { pendingSend.current = null; };
  }, [state.loadId]);
  const requests = useMemo(() => {
    const imported = state.turns.flatMap((turn) => turn.blocks.flatMap((block) => block.kind === 'approval' || block.kind === 'question' ? [block.request] : []));
    return [...new Map([...imported, ...state.requests].map((item) => [item.id, item])).values()];
  }, [state.turns, state.requests]);
  const unresolved = requests.filter((request) => request.status === 'open');
  const request = unresolved.find((item) => item.kind === 'approval') ?? unresolved[0];
  const eligible = canSend && unresolved.length === 0;
  const canResolve = state.history === 'complete' && state.sync === 'current'
    && (state.runtime === 'active-in-fractal' || state.runtime === 'waiting-for-user');
  const loading = state.history === 'loading' || state.history === 'idle';

  // Request events own the audit state; open controls stay by the composer
  // so a virtual row cannot hide or duplicate the current decision.
  const turns = useMemo(() => state.turns.map((turn) => turn.blocks.some((block) => block.kind === 'approval' || block.kind === 'question') ? ({
    ...turn,
    blocks: turn.blocks.flatMap((block): TurnBlock[] => {
      if (block.kind !== 'approval' && block.kind !== 'question') return [block];
      const latest = state.requests.find((item) => item.id === block.request.id) ?? block.request;
      return latest.status === 'open' ? [] : [{ ...block, request: latest }];
    }),
  }) : turn), [state.turns, state.requests]);

  const handleSubmit = async (message: PromptInputMessage) => {
    if (!eligible || pendingSend.current || !message.text.trim()) return;
    const draft = message.text;
    const dispatched = send(draft.trim());
    if (!dispatched) return;
    const attempt = {};
    pendingSend.current = attempt;
    setSending(true);
    setActionError(null);
    try {
      await dispatched;
      if (pendingSend.current === attempt) setInput((current) => current === draft ? '' : current);
    } catch (cause) {
      if (pendingSend.current === attempt) setActionError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (pendingSend.current === attempt) {
        pendingSend.current = null;
        setSending(false);
      }
    }
  };
  const resolve = async (id: string, decision: UserDecision) => {
    if (!canResolve) return;
    try { await resolveRequest(id, decision); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try { await interrupt(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStopping(false); }
  };

  return (
    <div className="relative flex size-full flex-col overflow-hidden">
      {state.error && <div className="shrink-0 border-b px-4 py-2 text-sm text-destructive" role="alert">Failed to load this conversation: {state.error}{' '}<button className="underline" onClick={reload} type="button">Reload</button></div>}
      {state.sync === 'gap' && <p className="shrink-0 border-b px-4 py-2 text-sm text-muted-foreground" role="status">Some events were missed. Reloading native history…</p>}
      {turns.length ? <VirtualTimeline columnClassName={COLUMN} conversationId={conversationKey(conversationRef)} historyComplete={state.history === 'complete' || state.history === 'failed'} onResolve={resolve} turns={turns} /> : <div className="min-h-0 flex-1">{loading ? <div className="flex size-full items-center justify-center" role="status"><Shimmer className="text-sm">Reading history…</Shimmer></div> : <ConversationEmptyState title={state.history === 'failed' ? 'History unavailable' : 'No messages yet'} description={state.history === 'failed' ? 'Reload to try reading this conversation again.' : 'This native session has no captured messages.'} />}</div>}
      <div className={`max-h-[60%] shrink-0 overflow-y-auto pb-2 ${COLUMN}`}>
        {request && <fieldset className="min-w-0 py-3" disabled={!canResolve}><BlockingRequest key={request.id} onResolve={resolve} request={request} /></fieldset>}
        {state.runtime === 'waiting-for-user' && !request && <p className="py-2 text-sm text-muted-foreground" role="status">This session is waiting for user input.</p>}
        {state.runtime === 'active-in-fractal' && !canSend && !request && <p className="py-2 text-sm text-muted-foreground">The agent is working. You can send another message when it finishes.</p>}
        {actionError && <p className="py-2 text-sm text-destructive" role="alert">{actionError}</p>}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody><PromptInputTextarea aria-label="Message" disabled={!eligible || sending} onChange={(event) => setInput(event.target.value)} placeholder="Ask anything" value={input} /></PromptInputBody>
          <PromptInputFooter className="justify-end">
            {state.runtime === 'active-in-fractal' && state.capabilities?.interrupt && (
              <Button aria-label="Interrupt session" disabled={stopping} onClick={() => { void stop(); }} size="icon-sm" type="button" variant="ghost"><Square aria-hidden className="size-3" /></Button>
            )}
            <PromptInputSubmit disabled={!eligible || sending || !input.trim()} status={sending ? 'submitted' : 'ready'} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

export function ConversationPanel({ conversationRef }: { conversationRef: ConversationRef }) {
  return <NativeConversationPanel conversationRef={conversationRef} key={`${conversationKey(conversationRef)}:${conversationRef.projectPath}`} />;
}
