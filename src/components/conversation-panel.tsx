import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Paperclip } from 'lucide-react';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { PromptInput, PromptInputAttachment, PromptInputAttachments, PromptInputBody, PromptInputButton, PromptInputFooter, PromptInputHeader, PromptInputSubmit, PromptInputTextarea, usePromptInputAttachments, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { AttachmentPreviewProvider } from '@/components/conversation/attachment-preview-context';
import { AccessPicker } from '@/components/conversation/access-picker';
import { nextAccessLevel } from '@/components/conversation/access-choice';
import { BlockingRequest } from '@/components/conversation/blocking-request';
import { ModelPicker } from '@/components/conversation/model-picker';
import { composerFileError, promptAttachments } from '@/components/conversation/prompt-attachments';
import { VirtualTimeline } from '@/components/conversation/virtual-timeline';
import { providerName } from '@/components/sidebar-03/nav-main';
import { useAccessChoice } from '@/renderer/use-access-choice';
import { useConversation } from '@/renderer/use-conversation';
import { useModelChoice } from '@/renderer/use-model-choice';
import { conversationKey, MAX_PROMPT_ATTACHMENTS, type ConversationRef, type ConversationRuntime, type HarnessCapabilities, type PromptAttachment, type TurnBlock, type UserDecision } from '@/shared/conversation-contract';

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

// One button in two states: it sends while the agent is idle and stops it while
// it works, so the composer never shows send and stop side by side.
function ComposerSubmit({ blocked, hasText, onStop, sending, stopping }: { blocked: boolean; hasText: boolean; onStop?: () => void; sending: boolean; stopping: boolean }) {
  const attachments = usePromptInputAttachments();
  if (onStop) return <PromptInputSubmit aria-label="Interrupt session" disabled={stopping} onClick={onStop} status="streaming" type="button" />;
  return <PromptInputSubmit disabled={blocked || sending || (!hasText && attachments.files.length === 0)} status={sending ? 'submitted' : 'ready'} />;
}

// Names the approval or question routing the agent cannot do, so a request it
// would have raised is not silently missing.
function routingGap(provider: ConversationRef['provider'], capabilities: HarnessCapabilities | null): string | null {
  if (!capabilities) return null;
  const missing = [!capabilities.approvals && 'approval', !capabilities.questions && 'question'].filter(Boolean);
  if (missing.length === 0) return null;
  const subject = missing.length === 2 ? 'approval and question routing are' : `${missing[0]} routing is`;
  return `${providerName(provider)} ${subject} unavailable. Fractal will not bypass native permissions.`;
}

type RuntimeListener = (ref: ConversationRef, runtime: ConversationRuntime | null) => void;

function NativeConversationPanel({ conversationRef, onRuntimeChange, refreshSignal = 0 }: { conversationRef: ConversationRef; onRuntimeChange?: RuntimeListener; refreshSignal?: number }) {
  const { state, canSend, send, interrupt, resolveRequest, reload } = useConversation(conversationRef);
  // A runtime Fractal does not own is only checked on open, so a refresh
  // reopens. The signal's value at mount is not a request: the open covers it.
  const seenRefresh = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === seenRefresh.current) return;
    seenRefresh.current = refreshSignal;
    reload();
  }, [refreshSignal, reload]);
  // Until the open settles, `runtime` is the reducer's placeholder, not anything the agent reported.
  const runtimeKnown = state.summary !== null || state.streamedRuntime || state.history === 'failed';
  useEffect(() => {
    if (runtimeKnown) onRuntimeChange?.(conversationRef, state.runtime);
  }, [conversationRef, onRuntimeChange, runtimeKnown, state.runtime]);
  useEffect(() => () => onRuntimeChange?.(conversationRef, null), [conversationRef, onRuntimeChange]);
  const modelChoice = useModelChoice(conversationRef);
  const accessChoice = useAccessChoice(conversationRef, state.runtime, state.history === 'complete' ? state.turns.at(-1)?.id ?? '' : undefined);
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
  const gap = routingGap(conversationRef.provider, state.capabilities);

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
    if (!eligible || !modelChoice.loaded || !accessChoice.loaded || pendingSend.current || (!message.text.trim() && message.files.length === 0)) throw new Error('Message was not sent');
    let attachments: PromptAttachment[];
    try { attachments = promptAttachments(message.files); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    const draft = message.text;
    const dispatched = send(draft.trim(), attachments, modelChoice.choice, accessChoice.access);
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
  // Captured so it runs before the textarea's own Enter handling, which a plain onKeyDown would replace.
  const cycleAccess = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab' || !event.shiftKey || state.runtime !== 'idle' || event.nativeEvent.isComposing) return;
    const level = nextAccessLevel(accessChoice.levels, accessChoice.access);
    if (!level) return;
    event.preventDefault();
    accessChoice.choose(level);
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
        {gap && <p className="py-2 text-sm text-muted-foreground" role="status">{gap}</p>}
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
          <PromptInputBody><PromptInputTextarea aria-label="Message" disabled={!eligible || sending} onChange={(event) => setInput(event.target.value)} onKeyDownCapture={cycleAccess} placeholder="Ask anything" value={input} /></PromptInputBody>
          <PromptInputFooter className="justify-between">
            <div className="flex min-w-0 items-center gap-1">
              <AttachButton disabled={!eligible || sending} />
              <AccessPicker access={accessChoice.access} allowDangerous={accessChoice.allowDangerous} levels={accessChoice.levels} observed={accessChoice.observed} onChoose={accessChoice.choose} onOpen={accessChoice.refresh} provider={conversationRef.provider} />
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <ModelPicker choice={modelChoice.choice} models={modelChoice.models} onChoose={modelChoice.choose} onOpen={modelChoice.refresh} />
              <ComposerSubmit blocked={!eligible || !modelChoice.loaded || !accessChoice.loaded} hasText={Boolean(input.trim())} onStop={state.runtime === 'active-in-fractal' && state.capabilities?.interrupt ? () => { void stop(); } : undefined} sending={sending} stopping={stopping} />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

/** `onRuntimeChange` hears the open conversation's runtime once it is known, and null when the panel closes; a change in `refreshSignal` reopens it. */
export function ConversationPanel({ conversationRef, onRuntimeChange, refreshSignal }: { conversationRef: ConversationRef; onRuntimeChange?: RuntimeListener; refreshSignal?: number }) {
  return <NativeConversationPanel conversationRef={conversationRef} key={`${conversationKey(conversationRef)}:${conversationRef.projectPath}`} onRuntimeChange={onRuntimeChange} refreshSignal={refreshSignal} />;
}
