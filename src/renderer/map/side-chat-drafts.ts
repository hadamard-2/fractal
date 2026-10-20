import type { Node, XYPosition } from '@xyflow/react';
import type { ConversationState } from '@/renderer/conversation-reducer';
import { mapNodeId, type MapNodeData, type SideChatDraft } from '@/renderer/map/map-graph';
import { quoteSelection } from '@/renderer/side-chat-start';
import type { ConversationRef, SideChatSummary } from '@/shared/conversation-contract';

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
