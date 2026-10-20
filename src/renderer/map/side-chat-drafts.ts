import type { Node, XYPosition } from '@xyflow/react';
import type { ConversationHub } from '@/renderer/conversation-hub';
import type { ConversationState } from '@/renderer/conversation-reducer';
import { mapNodeId, type MapNodeData, type SideChatDraft } from '@/renderer/map/map-graph';
import type { ConversationApi, ConversationRef, ModelChoice, SideChatSummary } from '@/shared/conversation-contract';

const START_FAILED = "Couldn't start the side chat.";
const SEND_FAILED = "Couldn't send to the side chat.";
const HISTORY_TIMEOUT_MS = 30_000;

/** Selected text as a markdown blockquote, with a blank line after it for the question. */
export function quoteSelection(text: string): string {
  return `${text.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
}

export type DraftAction =
  | { type: 'add'; draft: SideChatDraft }
  | { type: 'move'; id: string; position: XYPosition }
  | { type: 'remove'; id: string };

/** The unsent side chats on the canvas. A draft is only ever local: nothing native exists until it is sent. */
export function draftsReducer(drafts: readonly SideChatDraft[], action: DraftAction): readonly SideChatDraft[] {
  switch (action.type) {
    case 'add':
      return [...drafts, action.draft];
    case 'move':
      return drafts.map((draft) => draft.id === action.id ? { ...draft, position: action.position } : draft);
    case 'remove':
      return drafts.some((draft) => draft.id === action.id) ? drafts.filter((draft) => draft.id !== action.id) : drafts;
  }
}

/** What a finished connection drag says about where it started and ended; React Flow's FinalConnectionState fits it. */
interface ConnectionEnd {
  fromNode: Pick<Node<MapNodeData>, 'data'> | null;
  fromHandle: { id?: string | null } | null;
  toNode: unknown;
}

interface Drop {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

/**
 * The draft a branch-handle drag makes when it's dropped on empty canvas, or
 * null. A side chat's latest reply continues that side chat; any other reply
 * starts a side chat after itself.
 */
export function draftFromConnectEnd(connection: ConnectionEnd, drop: Drop, toFlow: (point: XYPosition) => XYPosition, id: string): SideChatDraft | null {
  const target = drop.target as Partial<Element> | null;
  if (connection.toNode || target?.closest?.('.react-flow__node')) return null;
  const data = connection.fromNode?.data;
  if (connection.fromHandle?.id !== 'branch' || data?.kind !== 'reply' || !data.canBranch) return null;
  return {
    id, parent: data.owner, afterTurnId: data.turn.id,
    ...(data.line === 'side' && data.latest ? { continues: data.owner } : {}),
    text: '',
    position: toFlow({ x: drop.clientX, y: drop.clientY }),
  };
}

type MessageData = Extract<MapNodeData, { kind: 'user' | 'reply' }>;

/** Whether text selected in this node can start a side chat: a reply or user message whose turn can branch. */
export function canBranchFrom(data: MapNodeData): data is MessageData {
  return (data.kind === 'reply' || data.kind === 'user') && data.canBranch;
}

/** The draft "Side chat" makes from text selected in a message: a side chat after that turn's reply, opening with the quote. */
export function draftFromMessage(data: MapNodeData, selected: string, id: string): SideChatDraft | null {
  if (!canBranchFrom(data)) return null;
  return { id, parent: data.owner, afterTurnId: data.turn.id, text: quoteSelection(selected) };
}

/** A sent draft the user had placed, whose spot passes to the first user node of what it sent. */
export interface HandOff {
  ref: ConversationRef;
  position: XYPosition;
  /** The turns the side chat had before the send, when it continued one; null for a new side chat. */
  before: ReadonlySet<string> | null;
}

/** The node id the hand-off's spot belongs to, or null until that turn shows up. A new side chat's first turn of its own follows the ones it inherited. */
export function handOffNodeId(handOff: HandOff, state: ConversationState, summary: SideChatSummary | undefined): string | null {
  const { before } = handOff;
  const sent = before ? state.turns.find((turn) => !before.has(turn.id)) : summary ? state.turns[summary.inheritedTurnCount] : undefined;
  return sent ? mapNodeId(handOff.ref, sent.id, 'user') : null;
}

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
export async function submitDraft(draft: SideChatDraft, deps: {
  hub: ConversationHub;
  fork: ConversationApi['fork'];
  /** Removes a side chat whose first send failed, so a retry forks afresh. */
  deleteSideChat: ConversationApi['deleteSideChat'];
  modelChoice: (ref: ConversationRef) => Promise<ModelChoice | null>;
  refreshSideChats: () => Promise<void>;
  timeoutMs?: number;
}): Promise<ConversationRef> {
  const { hub, modelChoice } = deps;
  if (draft.continues) {
    try { await send(hub, draft.continues, draft.text, draft.continues, modelChoice); }
    catch { throw new Error(SEND_FAILED); }
    return draft.continues;
  }

  let ref: ConversationRef;
  try { ref = await deps.fork(draft.parent, { turnId: draft.afterTurnId, position: 'after' }, 'side-chat'); }
  catch { throw new Error(START_FAILED); }
  const release = hub.acquire(ref);
  try {
    await deps.refreshSideChats();
    await whenReady(hub, ref, deps.timeoutMs ?? HISTORY_TIMEOUT_MS);
    await send(hub, ref, draft.text, draft.parent, modelChoice);
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
