import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { ConversationState } from '@/renderer/conversation-reducer';
import { conversationKey, type ConversationRef, type ConversationTurn, type SideChatSummary } from '@/shared/conversation-contract';
import type { MapLayout } from '@/shared/map-contract';

export const MAP = {
  grid: 20,
  nodeWidth: 320,
  minWidth: 240,
  maxWidth: 960,
  previewLines: 3,
  minZoom: 0.2,
  maxZoom: 2,
  gapY: 40,
  gapX: 80,
} as const;

export interface SideChatDraft {
  id: string;
  parent: ConversationRef;
  afterTurnId: string;
  /** Set when the draft continues this side chat instead of starting one. */
  continues?: ConversationRef;
  text: string;
  position?: XYPosition;
}

export type MapNodeData =
  | { kind: 'user'; owner: ConversationRef; line: 'main' | 'side'; turn: ConversationTurn }
  | { kind: 'reply'; owner: ConversationRef; line: 'main' | 'side'; turn: ConversationTurn; latest: boolean; canBranch: boolean }
  | { kind: 'composer'; draft: SideChatDraft }
  | { kind: 'detached'; sideChat: SideChatSummary };

type MapNode = Node<MapNodeData>;

/** A node's height until React Flow has measured it. */
const UNMEASURED_HEIGHT = 120;

export function mapNodeId(owner: ConversationRef, turnId: string, part: 'user' | 'reply'): string {
  return `${conversationKey(owner)}|${turnId}|${part}`;
}

const composerNodeId = (draft: SideChatDraft) => `composer|${draft.id}`;
const detachedNodeId = (sideChat: SideChatSummary) => `detached|${conversationKey(sideChat.ref)}`;
const edgeId = (source: string, target: string) => `${source}->${target}`;

function snap(value: number): number {
  // `|| 0` keeps a rounded -0 from surviving as a distinct value.
  return Math.round(value / MAP.grid) * MAP.grid || 0;
}

function hasUserContent(turn: ConversationTurn): boolean {
  const { text, images, attachments } = turn.userMessage;
  return text.trim() !== '' || (images?.length ?? 0) > 0 || (attachments?.length ?? 0) > 0;
}

interface Column { x: number; startY: number }

interface DrawnLine {
  /** The column the line's automatic positions run down, and where its last automatic slot ends. */
  columnX: number;
  autoBottom: number;
  history: ConversationState['history'];
  nodes: MapNode[];
  /** The line's last reply node, which a continuing draft hangs off. */
  lastReply?: MapNode;
  /** Replies by the turn they answer: the nodes a side chat can branch from. */
  replies: Map<string, MapNode>;
}

export function buildMapGraph(input: {
  root: { ref: ConversationRef; state: ConversationState };
  sideChats: ReadonlyArray<{ summary: SideChatSummary; state: ConversationState }>;
  drafts: readonly SideChatDraft[];
  layout: MapLayout;
  /** Measured node heights by id, from React Flow; a missing one counts as 120. */
  heights: ReadonlyMap<string, number>;
  readOnly: boolean; // a subagent conversation: no handles
}): { nodes: Node<MapNodeData>[]; edges: Edge[] } {
  const { layout, heights, readOnly } = input;
  const nodes: MapNode[] = [];
  const edges: Edge[] = [];
  const lines = new Map<string, DrawnLine>();
  /** The lowest automatic slot taken in a column, so a later chain can start below it. A node the user has moved never counts, so moving one never shifts another. */
  const columnBottoms = new Map<number, number>();

  const heightOf = (id: string) => heights.get(id) ?? UNMEASURED_HEIGHT;
  const bottomOf = (node: MapNode) => node.position.y + heightOf(node.id);

  function addNode(node: MapNode) {
    nodes.push(node);
  }

  function addEdge(source: string, target: string, line: 'main' | 'side', sourceHandle?: string) {
    edges.push({
      id: edgeId(source, target), source, target, className: `map-edge-${line}`, data: { line },
      ...(sourceHandle ? { sourceHandle } : {}),
    });
  }

  function noteColumn(x: number, autoBottom: number) {
    columnBottoms.set(x, Math.max(columnBottoms.get(x) ?? -Infinity, autoBottom));
  }

  /** Where a chain branching off `anchor` starts: right of it, at its height, below whatever the column already holds. */
  function columnBeside(anchor: MapNode): Column {
    const x = snap(anchor.position.x + (anchor.width ?? MAP.nodeWidth) + MAP.gapX);
    const taken = columnBottoms.get(x);
    const startY = taken === undefined ? anchor.position.y : Math.max(anchor.position.y, taken + MAP.gapY);
    return { x, startY: snap(startY) };
  }

  /** A node placed at its saved spot if it has one, else at the chain's running automatic spot. */
  function place<D extends MapNodeData>(id: string, data: D, auto: XYPosition): Node<D> {
    const saved = layout.nodes[id];
    return {
      id, type: data.kind, data,
      position: saved ? { x: saved.x, y: saved.y } : auto,
      width: saved?.width ?? MAP.nodeWidth,
    };
  }

  function drawLine(owner: ConversationRef, state: ConversationState, turns: readonly ConversationTurn[], line: 'main' | 'side', column: Column, from?: { id: string; handle?: string }): DrawnLine {
    const drawn: DrawnLine = { columnX: column.x, autoBottom: column.startY, history: state.history, nodes: [], replies: new Map() };
    /** Where the line's automatic slots have reached, for the column record; placement follows the nodes' actual spots. */
    let cursor = column.startY;
    let previous = from;
    let above: MapNode | undefined;

    const push = (node: MapNode) => {
      drawn.nodes.push(node);
      addNode(node);
      if (previous) addEdge(previous.id, node.id, line, previous.handle);
      previous = { id: node.id };
      above = node;
      cursor = snap(snap(cursor) + heightOf(node.id) + MAP.gapY);
    };
    // The line's first node starts the column; each later one sits below the node above it, wherever that node is.
    const next = (): XYPosition => above
      ? { x: above.position.x, y: snap(bottomOf(above) + MAP.gapY) }
      : { x: column.x, y: snap(cursor) };

    turns.forEach((turn, index) => {
      if (hasUserContent(turn)) {
        const id = mapNodeId(owner, turn.id, 'user');
        push(place(id, { kind: 'user', owner, line, turn }, next()));
      }
      const id = mapNodeId(owner, turn.id, 'reply');
      const reply = place(id, {
        kind: 'reply', owner, line, turn, latest: index === turns.length - 1, canBranch: turn.status !== 'active' && !readOnly,
      }, next());
      push(reply);
      drawn.replies.set(turn.id, reply);
      drawn.lastReply = reply;
    });

    if (drawn.nodes.length > 0) {
      drawn.autoBottom = cursor - MAP.gapY;
      noteColumn(column.x, drawn.autoBottom);
    }
    lines.set(conversationKey(owner), drawn);
    return drawn;
  }

  drawLine(input.root.ref, input.root.state, input.root.state.turns, 'main', { x: 0, startY: 0 });

  // Oldest first, so an older chain keeps its place and a newer one stacks below it. A chain waits until its parent has been placed.
  let pending = [...input.sideChats].sort((a, b) => a.summary.createdAt - b.summary.createdAt);
  const known = new Set(pending.map(({ summary }) => conversationKey(summary.ref)));
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    const waiting: typeof pending = [];
    for (const item of pending) {
      const { summary, state } = item;
      const parentKey = summary.parentKey;
      const parentLine = lines.get(parentKey);
      if (!parentLine) {
        // Still to come if its parent is a side chat not yet placed; otherwise it has no parent on the map.
        if (known.has(parentKey) && parentKey !== conversationKey(summary.ref)) waiting.push(item);
        continue;
      }
      progressed = true;
      const ownTurns = state.turns.slice(summary.inheritedTurnCount);
      if (ownTurns.length === 0) continue;
      if (parentLine.history === 'idle' || parentLine.history === 'loading') continue;
      const anchor = parentLine.replies.get(summary.afterTurnId);
      if (anchor) {
        drawLine(summary.ref, state, ownTurns, 'side', columnBeside(anchor), { id: anchor.id, handle: 'branch' });
      } else if (parentLine.history === 'complete') {
        drawDetached(summary, state, ownTurns, parentLine);
      }
    }
    pending = waiting;
  }

  function drawDetached(summary: SideChatSummary, state: ConversationState, ownTurns: readonly ConversationTurn[], parentLine: DrawnLine) {
    // The branch point is gone, so the chain sits beside the parent's last node instead.
    const beside = parentLine.nodes[parentLine.nodes.length - 1];
    const column = beside ? columnBeside(beside) : { x: snap(MAP.nodeWidth + MAP.gapX), startY: 0 };
    const id = detachedNodeId(summary);
    const marker = place(id, { kind: 'detached', sideChat: summary }, { x: column.x, y: column.startY });
    addNode(marker);
    const firstY = snap(column.startY + heightOf(id) + MAP.gapY);
    drawLine(summary.ref, state, ownTurns, 'side', { x: column.x, startY: firstY });
  }

  for (const draft of input.drafts) drawDraft(draft);

  function drawDraft(draft: SideChatDraft) {
    const id = composerNodeId(draft);
    const continuedLine = draft.continues ? lines.get(conversationKey(draft.continues)) : undefined;
    const continued = continuedLine?.lastReply;
    const branchFrom = lines.get(conversationKey(draft.parent))?.replies.get(draft.afterTurnId);
    const source = continued ?? branchFrom;
    if (!source) return;

    const column = continued ? undefined : columnBeside(source);
    const auto = column
      ? { x: column.x, y: column.startY }
      : { x: source.position.x, y: snap(bottomOf(source) + MAP.gapY) };
    const composer: MapNode = {
      id, type: 'composer', data: { kind: 'composer', draft },
      position: draft.position ?? auto, width: MAP.nodeWidth,
    };
    addNode(composer);
    addEdge(source.id, id, 'side', column && 'branch');
    // Recorded at its automatic spot even when the user has moved it.
    if (column) noteColumn(column.x, column.startY + heightOf(id));
    else if (continuedLine) noteColumn(continuedLine.columnX, snap(continuedLine.autoBottom + MAP.gapY) + heightOf(id));
  }

  return { nodes, edges };
}
