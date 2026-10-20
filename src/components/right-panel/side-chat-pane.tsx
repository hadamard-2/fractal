import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { COLUMN } from '@/components/conversation-panel';
import { AttachmentPreviewProvider } from '@/components/conversation/attachment-preview-context';
import { MESSAGE_TEXT } from '@/components/conversation/conversation-turn';
import { SelectionMenu, useMessageSelection } from '@/components/conversation/selection-menu';
import { VirtualTimeline } from '@/components/conversation/virtual-timeline';
import { Button } from '@/components/ui/button';
import { conversationHub } from '@/renderer/conversation-hub';
import { useSideChats } from '@/renderer/map/use-side-chats';
import { canBranchTurn } from '@/renderer/side-chat-branching';
import { announceSideChats, onSideChatsChanged } from '@/renderer/side-chat-events';
import { modelChoiceOf, quoteSelection, submitDraft, type SideChatRequest } from '@/renderer/side-chat-start';
import { useConversation } from '@/renderer/use-conversation';
import { conversationKey, type ConversationRef, type UserDecision } from '@/shared/conversation-contract';
import { useSideChatLauncher } from './side-chat-launcher';

interface SideChatPaneProps {
  root: ConversationRef;
  /** Set while unsent: what the first send forks from, and the composer's starting text. */
  draft: { parent: ConversationRef; afterTurnId: string; text: string } | undefined;
  /** Null until the first send creates it. */
  sideChat: ConversationRef | null;
  branchPointText: string | undefined;
  /** The first send forked this side chat; null puts the tab back to unsent after that send failed. */
  onBound(sideChat: ConversationRef | null): void;
  /** The side chat is no longer listed under its root: it was deleted. */
  onGone(): void;
  /** Bumped by the panel to ask for keyboard focus; each value is honoured once, while the pane is `visible`. */
  focusToken?: number;
  visible: boolean;
}

/**
 * The bound side chat's entry in the listing of `root`, and `onGone` once a listing no longer has it. Only a listing
 * that started after the bind, while no send was pending, can find it gone: a failed first send deletes its side chat
 * and has the root re-listed before the failure reaches the pane, which then goes back to unsent rather than closing.
 * `unbind()` stops counting listings at once, before the tab has re-rendered unbound. `failed` is set while the latest
 * listing has failed, and `relist()` tries again.
 */
function useListing(root: ConversationRef, sideChat: ConversationRef | null, pending: RefObject<boolean>, onGone: () => void) {
  // Listed only while bound, so the first listing after binding is the first that can count.
  const { sideChats, listed, failed, refresh } = useSideChats(sideChat ? root : null);
  const listingKey = sideChat ? conversationKey(root) : null;
  const boundKey = sideChat ? conversationKey(sideChat) : null;
  const bound = useRef<string | null>(null);
  // Whether the listing most recently started for this pane counts; a later listing always replaces an earlier one.
  const counts = useRef(false);
  useEffect(() => {
    bound.current = boundKey;
    // No listing so far was started for this side chat.
    counts.current = false;
  }, [boundKey]);
  useEffect(() => {
    // useSideChats starts a listing each time its root takes effect, as this does.
    counts.current = listingKey !== null && bound.current !== null && !pending.current;
  }, [listingKey, pending]);
  useEffect(() => {
    if (listingKey === null) return undefined;
    return onSideChatsChanged((key) => { if (key === listingKey) counts.current = bound.current !== null && !pending.current; });
  }, [listingKey, pending]);

  const latestOnGone = useRef(onGone);
  latestOnGone.current = onGone;
  const gone = useRef(false);
  const seen = useRef({ key: listingKey, sideChats });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { key: listingKey, sideChats };
    // Only a listing landing counts; on a bind, what's shown is a listing from before it.
    if (!listed || previous.key !== listingKey || previous.sideChats === sideChats) return;
    if (gone.current || !counts.current || pending.current || bound.current === null) return;
    if (sideChats.some((summary) => conversationKey(summary.ref) === bound.current)) return;
    gone.current = true;
    latestOnGone.current();
  }, [listed, listingKey, sideChats, pending]);

  const summary = boundKey === null ? undefined : sideChats.find((entry) => conversationKey(entry.ref) === boundKey);
  const unbind = useCallback(() => { bound.current = null; }, []);
  const relist = useCallback(() => {
    counts.current = bound.current !== null && !pending.current;
    void refresh();
  }, [pending, refresh]);
  return { summary, failed, unbind, relist };
}

/** A side chat in a right-panel tab: unsent until its first send forks it, then its own turns and a composer that continues it. */
export function SideChatPane({ root, draft, sideChat, branchPointText, onBound, onGone, focusToken = 0, visible }: SideChatPaneProps) {
  const { state, canSend, interrupt, resolveRequest, reload } = useConversation(sideChat);
  const pending = useRef(false);
  const { summary, failed: listingFailed, unbind, relist } = useListing(root, sideChat, pending, onGone);
  const [input, setInput] = useState(draft?.text ?? '');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inheritedTurnCount = summary?.inheritedTurnCount;
  const turns = useMemo(() => inheritedTurnCount === undefined ? [] : state.turns.slice(inheritedTurnCount), [inheritedTurnCount, state.turns]);
  const eligible = !sending && (sideChat ? canSend : draft !== undefined);
  const canStop = sideChat !== null && state.runtime === 'active-in-fractal' && state.capabilities?.interrupt === true;

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!eligible || pending.current || !text) return;
    // A continuing request carries `continues`; a first send must not carry the key at all.
    const request: SideChatRequest | undefined = sideChat ? { continues: sideChat, text } : draft && { parent: draft.parent, afterTurnId: draft.afterTurnId, text };
    if (!request) return;
    pending.current = true;
    setSending(true);
    setError(null);
    try {
      await submitDraft(request, {
        hub: conversationHub(),
        fork: (...args) => window.fractal.conversations.fork(...args),
        deleteSideChat: (ref) => window.fractal.conversations.deleteSideChat(ref),
        modelChoice: modelChoiceOf,
        refreshSideChats: async () => announceSideChats(conversationKey(root)),
        onStarted: onBound,
      });
      setInput((current) => current === message.text ? '' : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // submitDraft has already deleted a side chat whose first send failed; the tab goes back to unsent with its text.
      if (!('continues' in request)) {
        unbind();
        onBound(null);
      }
    } finally {
      pending.current = false;
      setSending(false);
    }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try { await interrupt(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStopping(false); }
  };
  const resolve = async (id: string, decision: UserDecision) => { await resolveRequest(id, decision); };

  // A nested side chat starts from text selected in one of this side chat's own turns.
  const launcher = useSideChatLauncher();
  const transcript = useRef<HTMLDivElement>(null);
  const branchable = useCallback((id: string) => {
    const turn = turns.find((candidate) => candidate.id === id);
    return turn !== undefined && canBranchTurn(turn, state.runtime, false);
  }, [turns, state.runtime]);
  const { selection, dismiss } = useMessageSelection(transcript, launcher && sideChat ? branchable : null);
  const chooseSideChat = () => {
    const turn = selection && turns.find((candidate) => candidate.id === selection.sourceId);
    if (turn && launcher && sideChat) launcher.start({ root, parent: sideChat, turn, text: quoteSelection(selection.text) });
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  // A failed load shows only while the side chat is still listed, so a deleted one closes its tab without saying so.
  // Without a listing, a failed one says the same rather than reading forever, and Reload lists again.
  const historyFailed = summary !== undefined && (state.history === 'failed' || state.error !== null);
  const unavailable = sideChat !== null && (historyFailed || (summary === undefined && listingFailed));
  const reading = !unavailable && (summary === undefined || state.history === 'idle' || state.history === 'loading');

  // A focus request waits while a bound side chat is loading, then focuses the composer if it can take a message, and
  // lapses if it can't, so a side chat that's running never takes focus when it later finishes. The caret goes after
  // any quoted text, so a question typed under a quote stays below it.
  const textarea = useRef<HTMLTextAreaElement>(null);
  const handledFocus = useRef(0);
  const loading = sideChat !== null && (state.history === 'idle' || state.history === 'loading' || (state.summary === null && !state.streamedRuntime && state.history !== 'failed'));
  useEffect(() => {
    const element = textarea.current;
    if (!visible || loading || focusToken === handledFocus.current || !element) return;
    handledFocus.current = focusToken;
    if (!eligible) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [focusToken, visible, loading, eligible]);

  return (
    <div className="@container relative flex size-full flex-col overflow-hidden">
      {branchPointText && (
        <div className={`shrink-0 border-b py-2 ${COLUMN}`}>
          <p className="text-xs font-medium text-muted-foreground">Branched from</p>
          <div className="line-clamp-3 text-muted-foreground"><MessageResponse className={MESSAGE_TEXT}>{branchPointText}</MessageResponse></div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col" ref={transcript}>
        {sideChat && (unavailable
          ? (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-8">
              <ConversationEmptyState className="size-auto p-0" description="Reload to try reading this conversation again." title="History unavailable" />
              <Button onClick={historyFailed ? reload : relist} size="sm" type="button" variant="outline">Reload</Button>
            </div>
          )
          : turns.length > 0
            ? <AttachmentPreviewProvider conversationRef={sideChat}><VirtualTimeline columnClassName={COLUMN} conversationId={conversationKey(sideChat)} historyComplete={state.history === 'complete' || state.history === 'failed'} onResolve={resolve} turns={turns} /></AttachmentPreviewProvider>
            : reading && <div className="flex size-full items-center justify-center" role="status"><Shimmer className="text-sm">Reading history…</Shimmer></div>)}
      </div>
      {selection && <SelectionMenu onChoose={chooseSideChat} selection={selection} />}
      <div className={`max-h-[60%] shrink-0 overflow-y-auto pb-2 [scrollbar-gutter:stable] ${COLUMN}`}>
        {error && <p className="py-2 text-sm text-destructive" role="alert">{error}</p>}
        {/* Side chats take text only: a pasted or dropped file is refused with PromptInput's own reason. */}
        <PromptInput maxFiles={0} onError={(refused) => setError(refused.message)} onSubmit={handleSubmit}>
          <PromptInputBody><PromptInputTextarea aria-label="Side question" disabled={!eligible} onChange={(event) => setInput(event.target.value)} placeholder="Ask a side question" ref={textarea} value={input} /></PromptInputBody>
          <PromptInputFooter className="justify-end">
            {canStop
              ? <PromptInputSubmit aria-label="Interrupt session" disabled={stopping} onClick={() => { void stop(); }} status="streaming" type="button" />
              : <PromptInputSubmit disabled={!eligible || !input.trim()} status={sending ? 'submitted' : 'ready'} />}
          </PromptInputFooter>
        </PromptInput>
        <p className="pt-1.5 text-xs text-muted-foreground">Side chats can read files but can&apos;t change them.</p>
      </div>
    </div>
  );
}
