import type { ConversationHub } from '@/renderer/conversation-hub';
import type { ConversationApi, ConversationRef, ModelChoice } from '@/shared/conversation-contract';

const START_FAILED = "Couldn't start the side chat.";
const SEND_FAILED = "Couldn't send to the side chat.";
const HISTORY_TIMEOUT_MS = 30_000;

/** Selected text as a markdown blockquote, with a blank line after it for the question. */
export function quoteSelection(text: string): string {
  return `${text.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
}

/** What to send: more of an existing side chat when `continues` is set, otherwise a new side chat after `afterTurnId`'s reply in `parent`. */
export type SideChatRequest = { text: string } & ({ continues: ConversationRef } | { parent: ConversationRef; afterTurnId: string });

/** Settles once the hub has the conversation's whole history and it's idle; rejects on a failed load or after `timeoutMs`. */
function whenReady(hub: ConversationHub, ref: ConversationRef, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const finish = () => { clearTimeout(timer); unsubscribe(); };
    const timer = setTimeout(() => { finish(); reject(new Error('History did not complete')); }, timeoutMs);
    const check = () => {
      const { history, runtime } = hub.state(ref);
      if (history === 'complete' && runtime === 'idle') { finish(); resolve(); }
      else if (history === 'failed') { finish(); reject(new Error('History failed')); }
    };
    unsubscribe = hub.subscribe(check);
    check();
  });
}

/** Sends to `ref` with the model choice resolved for `choiceOf`. */
async function send(hub: ConversationHub, ref: ConversationRef, text: string, choiceOf: ConversationRef, modelChoice: (ref: ConversationRef) => Promise<ModelChoice | null>): Promise<void> {
  const choice = await modelChoice(choiceOf);
  // A side chat never sends an access setting.
  const sent = hub.send(ref, { text, ...choice });
  if (!sent) throw new Error('The side chat can\'t take a message');
  await sent;
}

/**
 * Forks (unless it continues), waits for the new side chat's history, then sends. A new side chat's first message runs with the
 * parent's resolved model choice; a continued one with its own. Resolves with the side chat's ref.
 */
export async function submitDraft(request: SideChatRequest, deps: {
  hub: ConversationHub;
  fork: ConversationApi['fork'];
  /** Removes a side chat whose first send failed, so a retry forks afresh. */
  deleteSideChat: ConversationApi['deleteSideChat'];
  modelChoice: (ref: ConversationRef) => Promise<ModelChoice | null>;
  refreshSideChats: () => Promise<void>;
  /** Called once the fork has made the side chat, before its history is read or anything is sent. */
  onStarted?: (ref: ConversationRef) => void;
  timeoutMs?: number;
}): Promise<ConversationRef> {
  const { hub, modelChoice } = deps;
  if ('continues' in request) {
    try { await send(hub, request.continues, request.text, request.continues, modelChoice); }
    catch { throw new Error(SEND_FAILED); }
    return request.continues;
  }

  let ref: ConversationRef;
  try { ref = await deps.fork(request.parent, { turnId: request.afterTurnId, position: 'after' }, 'side-chat'); }
  catch { throw new Error(START_FAILED); }
  deps.onStarted?.(ref);
  const release = hub.acquire(ref);
  try {
    await deps.refreshSideChats();
    await whenReady(hub, ref, deps.timeoutMs ?? HISTORY_TIMEOUT_MS);
    await send(hub, ref, request.text, request.parent, modelChoice);
    return ref;
  } catch {
    // An unsent side chat would have no messages to show or delete it by, so it goes; best effort.
    await deps.deleteSideChat(ref).catch((): void => undefined);
    await deps.refreshSideChats().catch((): void => undefined);
    throw new Error(START_FAILED);
  } finally {
    release();
  }
}
