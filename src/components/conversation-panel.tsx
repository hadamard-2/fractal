import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Square } from 'lucide-react';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { PromptInput, PromptInputAttachment, PromptInputAttachments, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, usePromptInputAttachments, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { AttachmentPreviewProvider } from '@/components/conversation/attachment-preview-context';
import { BlockingRequest } from '@/components/conversation/blocking-request';
import { ModelPicker } from '@/components/conversation/model-picker';
import { composerFileError, promptAttachments } from '@/components/conversation/prompt-attachments';
import { VirtualTimeline } from '@/components/conversation/virtual-timeline';
import { Button } from '@/components/ui/button';
import { useConversation } from '@/renderer/use-conversation';
import { useModelChoice } from '@/renderer/use-model-choice';
import { conversationKey, MAX_PROMPT_ATTACHMENTS, type ConversationRef, type PromptAttachment, type TurnBlock, type UserDecision } from '@/shared/conversation-contract';

// The transcript and composer share one reading column. On a wide panel only the
// padding absorbs a resize and the column holds at its 46rem cap; once that padding
// falls to 6% of the panel, the column and padding shrink together. `cqw` is the
// panel's width (it is the `@container`), so rows inside the scrolling transcript and
// the composer outside it resolve the padding against the same width. Both regions
// reserve a stable scrollbar gutter so the column's edges line up between them.
const COLUMN = 'px-[max(1rem,6cqw,(100cqw_-_46rem)/2)]';

function AttachButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton aria-label="Attach files" disabled={disabled} onClick={attachments.openFileDialog}>
      <Paperclip aria-hidden className="size-4" />
    </PromptInputButton>
  );
}

function ComposerSubmit({ blocked, hasText, sending }: { blocked: boolean; hasText: boolean; sending: boolean }) {
  const attachments = usePromptInputAttachments();
  return <PromptInputSubmit disabled={blocked || sending || (!hasText && attachments.files.length === 0)} status={sending ? 'submitted' : 'ready'} />;
}

function NativeConversationPanel({ conversationRef }: { conversationRef: ConversationRef }) {
  const { state, canSend, send, interrupt, resolveRequest, reload } = useConversation(conversationRef);
  const modelChoice = useModelChoice(conversationRef);
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
    if (!eligible || !modelChoice.loaded || pendingSend.current || (!message.text.trim() && message.files.length === 0)) throw new Error('Message was not sent');
    let attachments: PromptAttachment[];
    try { attachments = promptAttachments(message.files); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    const draft = message.text;
    const dispatched = send(draft.trim(), attachments, modelChoice.choice);
    if (!dispatched) throw new Error('Message was not sent');
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
    <div className="@container relative flex size-full flex-col overflow-hidden">
      {state.error && <div className="shrink-0 border-b px-4 py-2 text-sm text-destructive" role="alert">Failed to load this conversation: {state.error}{' '}<button className="underline" onClick={reload} type="button">Reload</button></div>}
      {state.sync === 'gap' && <p className="shrink-0 border-b px-4 py-2 text-sm text-muted-foreground" role="status">Some events were missed. Reloading native history…</p>}
      {turns.length ? <AttachmentPreviewProvider conversationRef={conversationRef}><VirtualTimeline columnClassName={COLUMN} conversationId={conversationKey(conversationRef)} historyComplete={state.history === 'complete' || state.history === 'failed'} onResolve={resolve} turns={turns} /></AttachmentPreviewProvider> : <div className="min-h-0 flex-1">{loading ? <div className="flex size-full items-center justify-center" role="status"><Shimmer className="text-sm">Reading history…</Shimmer></div> : <ConversationEmptyState title={state.history === 'failed' ? 'History unavailable' : 'No messages yet'} description={state.history === 'failed' ? 'Reload to try reading this conversation again.' : 'This native session has no captured messages.'} />}</div>}
      <div className={`max-h-[60%] shrink-0 overflow-y-auto pb-2 [scrollbar-gutter:stable] ${COLUMN}`}>
        {request && <fieldset className="min-w-0 py-3" disabled={!canResolve}><BlockingRequest key={request.id} onResolve={resolve} request={request} /></fieldset>}
        {state.runtime === 'waiting-for-user' && !request && <p className="py-2 text-sm text-muted-foreground" role="status">This session is waiting for user input.</p>}
        {state.runtime === 'active-in-fractal' && !canSend && !request && <p className="py-2 text-sm text-muted-foreground">The agent is working. You can send another message when it finishes.</p>}
        {actionError && <p className="py-2 text-sm text-destructive" role="alert">{actionError}</p>}
        <PromptInput
          maxFiles={MAX_PROMPT_ATTACHMENTS}
          multiple
          onError={(error) => setActionError(error.message)}
          onSubmit={handleSubmit}
          resolvePath={(file) => window.fractal.attachments.pathFor(file)}
          validateFile={composerFileError}
        >
          <PromptInputHeader className="p-0">
            <PromptInputAttachments className="px-3 pt-3 pb-0">{(file) => <PromptInputAttachment data={file} />}</PromptInputAttachments>
          </PromptInputHeader>
          <PromptInputBody><PromptInputTextarea aria-label="Message" disabled={!eligible || sending} onChange={(event) => setInput(event.target.value)} placeholder="Ask anything" value={input} /></PromptInputBody>
          <PromptInputFooter className="justify-between">
            <div className="flex min-w-0 items-center gap-1">
              <AttachButton disabled={!eligible || sending} />
              <ModelPicker choice={modelChoice.choice} models={modelChoice.models} onChoose={modelChoice.choose} onOpen={modelChoice.refresh} />
            </div>
            <div className="flex items-center gap-1">
              {state.runtime === 'active-in-fractal' && state.capabilities?.interrupt && (
                <Button aria-label="Interrupt session" disabled={stopping} onClick={() => { void stop(); }} size="icon-sm" type="button" variant="ghost"><Square aria-hidden className="size-3" /></Button>
              )}
              <ComposerSubmit blocked={!eligible || !modelChoice.loaded} hasText={Boolean(input.trim())} sending={sending} />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

export function ConversationPanel({ conversationRef }: { conversationRef: ConversationRef }) {
  return <NativeConversationPanel conversationRef={conversationRef} key={`${conversationKey(conversationRef)}:${conversationRef.projectPath}`} />;
}
