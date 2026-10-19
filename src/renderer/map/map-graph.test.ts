import { describe, expect, test } from 'vitest';
import { buildMapGraph, mapNodeId, MAP, type SideChatDraft } from '@/renderer/map/map-graph';
import { initialConversationState, type ConversationState } from '@/renderer/conversation-reducer';
import { conversationKey, type ConversationRef, type ConversationTurn, type SideChatSummary } from '@/shared/conversation-contract';
import { EMPTY_MAP_LAYOUT, type MapLayout } from '@/shared/map-contract';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const sideRef = (id: string): ConversationRef => ({ ...root, nativeSessionId: id });

const turn = (id: string, overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id, nativeId: `native-${id}`, userMessage: { id: `message-${id}`, text: `ask ${id}` },
  blocks: [{ id: `prose-${id}`, kind: 'assistant-prose', provider: 'claude', text: `answer ${id}` }],
  status: 'completed', captureCompleteness: 'complete', ...overrides,
});

const state = (ref: ConversationRef, turns: ConversationTurn[], history: ConversationState['history'] = 'complete'): ConversationState =>
  ({ ...initialConversationState, ref, turns, history });

const summary = (id: string, afterTurnId: string, overrides: Partial<SideChatSummary> = {}): SideChatSummary =>
  ({ ref: sideRef(id), parentKey: conversationKey(root), afterTurnId, inheritedTurnCount: 0, createdAt: 1, ...overrides });

type Input = Parameters<typeof buildMapGraph>[0];

function build(overrides: Partial<Input> = {}) {
  return buildMapGraph({
    root: { ref: root, state: state(root, [turn('t1'), turn('t2')]) },
    sideChats: [], drafts: [], layout: EMPTY_MAP_LAYOUT, heights: new Map(), readOnly: false, ...overrides,
  });
}

const userId = (owner: ConversationRef, turnId: string) => mapNodeId(owner, turnId, 'user');
const replyId = (owner: ConversationRef, turnId: string) => mapNodeId(owner, turnId, 'reply');
const find = (graph: ReturnType<typeof build>, id: string) => graph.nodes.find((node) => node.id === id);
const need = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected the graph to hold this');
  return value;
};
const at = (graph: ReturnType<typeof build>, id: string) => need(find(graph, id)).position;
const layoutOf = (nodes: MapLayout['nodes']): MapLayout => ({ view: 'preview', nodes });

describe('buildMapGraph nodes', () => {
  test('draws a user and a reply node per turn, joined user to reply to the next user', () => {
    const graph = build();

    expect(graph.nodes.map((node) => node.id)).toEqual([
      userId(root, 't1'), replyId(root, 't1'), userId(root, 't2'), replyId(root, 't2'),
    ]);
    expect(graph.nodes.map((node) => node.type)).toEqual(['user', 'reply', 'user', 'reply']);
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      [userId(root, 't1'), replyId(root, 't1')],
      [replyId(root, 't1'), userId(root, 't2')],
      [userId(root, 't2'), replyId(root, 't2')],
    ]);
    expect(graph.edges.every((edge) => edge.className === 'map-edge-main')).toBe(true);
    expect(graph.nodes.every((node) => node.data.kind === 'composer' || node.data.kind === 'detached' ? false : node.data.line === 'main')).toBe(true);
  });

  test('gives the same ids on every build', () => {
    expect(build().edges.map((edge) => edge.id)).toEqual(build().edges.map((edge) => edge.id));
    expect(new Set(build().edges.map((edge) => edge.id)).size).toBe(3);
  });

  test('skips the user node of a turn with no text, images or attachments', () => {
    const bare = turn('t1', { userMessage: { id: 'm', text: '  ' } });
    const withImage = turn('t2', { userMessage: { id: 'm2', text: '', images: [{ mediaType: 'image/png', data: 'AA' }] } });
    const graph = build({ root: { ref: root, state: state(root, [bare, withImage]) } });

    expect(graph.nodes.map((node) => node.id)).toEqual([replyId(root, 't1'), userId(root, 't2'), replyId(root, 't2')]);
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      [replyId(root, 't1'), userId(root, 't2')],
      [userId(root, 't2'), replyId(root, 't2')],
    ]);
  });

  test('marks the latest reply and lets only settled replies branch', () => {
    const graph = build({ root: { ref: root, state: state(root, [turn('t1'), turn('t2', { status: 'active' })]) } });
    const reply = (id: string) => find(graph, replyId(root, id))?.data;

    expect(reply('t1')).toMatchObject({ latest: false, canBranch: true });
    expect(reply('t2')).toMatchObject({ latest: true, canBranch: false });
    expect(build({ readOnly: true }).nodes.filter((node) => node.data.kind === 'reply').every((node) => node.data.kind === 'reply' && !node.data.canBranch)).toBe(true);
  });
});

describe('buildMapGraph side chats', () => {
  const side = sideRef('side-1');
  const withSide = (turns: ConversationTurn[], over: Partial<SideChatSummary> = {}, history: ConversationState['history'] = 'complete') =>
    ({ summary: summary('side-1', 't1', over), state: state(side, turns, history) });

  test('shows only the turns after the inherited ones and branches off the parent reply', () => {
    const graph = build({ sideChats: [withSide([turn('t1'), turn('s1')], { inheritedTurnCount: 1 })] });

    expect(find(graph, userId(side, 't1'))).toBeUndefined();
    expect(find(graph, userId(side, 's1'))?.data).toMatchObject({ kind: 'user', line: 'side' });
    const branch = graph.edges.find((edge) => edge.target === userId(side, 's1'));
    expect(branch).toMatchObject({ source: replyId(root, 't1'), sourceHandle: 'branch', className: 'map-edge-side' });
    expect(graph.edges.find((edge) => edge.source === userId(side, 's1'))?.className).toBe('map-edge-side');
  });

  test('attaches a nested side chat to its parent side chat reply', () => {
    const inner = sideRef('inner');
    const nested = { summary: summary('inner', 's1', { parentKey: conversationKey(side), createdAt: 2 }), state: state(inner, [turn('n1')]) };
    const graph = build({ sideChats: [withSide([turn('s1')]), nested] });

    expect(graph.edges.find((edge) => edge.target === userId(inner, 'n1'))).toMatchObject({ source: replyId(side, 's1'), sourceHandle: 'branch' });
  });

  test('draws nothing for a side chat that has no turns of its own yet', () => {
    const empty = withSide([turn('t1')], { inheritedTurnCount: 1 });
    const inner = sideRef('inner');
    const nested = { summary: summary('inner', 't1', { parentKey: conversationKey(side) }), state: state(inner, [turn('n1')]) };
    const graph = build({ sideChats: [empty, nested] });

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);
  });

  test('keeps a side chat whose branch turn is gone as a detached node above its first node', () => {
    const graph = build({ sideChats: [withSide([turn('s1')], { afterTurnId: 'gone' })] });
    const detached = need(graph.nodes.find((node) => node.type === 'detached'));
    const first = need(find(graph, userId(side, 's1')));

    expect(detached.data).toMatchObject({ kind: 'detached' });
    expect(detached.position.y).toBeLessThan(first.position.y);
    expect(detached.position.x).toBe(first.position.x);
    expect(graph.edges.some((edge) => edge.target === first.id)).toBe(false);
    expect(graph.edges.some((edge) => edge.target === detached.id || edge.source === detached.id)).toBe(false);
  });

  test('keeps a detached node at its saved position', () => {
    const detachedId = need(build({ sideChats: [withSide([turn('s1')], { afterTurnId: 'gone' })] }).nodes.find((node) => node.type === 'detached')).id;
    const graph = build({ sideChats: [withSide([turn('s1')], { afterTurnId: 'gone' })], layout: layoutOf({ [detachedId]: { x: 7, y: 9, width: 400 } }) });

    expect(find(graph, detachedId)).toMatchObject({ position: { x: 7, y: 9 }, width: 400 });
  });

  test('draws nothing while the parent history is not loaded, or for chains under an undrawn side chat', () => {
    const inner = sideRef('inner');
    const nested = { summary: summary('inner', 's1', { parentKey: conversationKey(side), afterTurnId: 'missing' }), state: state(inner, [turn('n1')]) };

    for (const history of ['idle', 'loading'] as const) {
      const graph = build({ root: { ref: root, state: state(root, [turn('t1')], history) }, sideChats: [withSide([turn('s1')], { afterTurnId: 'gone' })] });
      expect(graph.nodes.filter((node) => node.data.kind === 'detached' || node.data.kind === 'user' && node.data.line === 'side')).toEqual([]);
    }
    const undrawn = build({ sideChats: [withSide([turn('s1')], { afterTurnId: 't1' }, 'loading'), nested] });
    expect(undrawn.nodes.some((node) => node.id.includes('inner'))).toBe(false);
    const orphan = build({ sideChats: [{ summary: summary('inner', 't1', { parentKey: 'claude:unknown' }), state: state(inner, [turn('n1')]) }] });
    expect(orphan.nodes).toHaveLength(4);
  });
});

describe('buildMapGraph auto layout', () => {
  const side = sideRef('side-1');

  test('stacks the main line at x = 0 with each node below the previous one', () => {
    const heights = new Map([[userId(root, 't1'), 100], [replyId(root, 't1'), 200]]);
    const graph = build({ heights });

    expect(at(graph, userId(root, 't1'))).toEqual({ x: 0, y: 0 });
    expect(at(graph, replyId(root, 't1'))).toEqual({ x: 0, y: 140 });
    expect(at(graph, userId(root, 't2'))).toEqual({ x: 0, y: 380 });
    expect(at(graph, replyId(root, 't2'))).toEqual({ x: 0, y: 540 });
    expect(find(graph, replyId(root, 't1'))?.width).toBe(MAP.nodeWidth);
  });

  test('places a side chat column right of the parent node, starting at the parent reply', () => {
    const graph = build({ sideChats: [{ summary: summary('side-1', 't1'), state: state(side, [turn('s1')]) }] });
    const parent = at(graph, replyId(root, 't1'));

    expect(at(graph, userId(side, 's1'))).toEqual({ x: MAP.nodeWidth + MAP.gapX, y: parent.y });
    expect(at(graph, replyId(side, 's1'))).toEqual({ x: MAP.nodeWidth + MAP.gapX, y: parent.y + 120 + MAP.gapY });
  });

  test('uses the parent node saved width and position for the column', () => {
    const parentId = replyId(root, 't1');
    const graph = build({
      layout: layoutOf({ [parentId]: { x: 100, y: 300, width: 500 } }),
      sideChats: [{ summary: summary('side-1', 't1'), state: state(side, [turn('s1')]) }],
    });

    expect(at(graph, parentId)).toEqual({ x: 100, y: 300 });
    expect(find(graph, parentId)?.width).toBe(500);
    expect(at(graph, userId(side, 's1'))).toEqual({ x: 100 + 500 + MAP.gapX, y: 300 });
  });

  test('pushes a later chain in the same column below the earlier one, oldest first', () => {
    const other = sideRef('side-2');
    const graph = build({
      sideChats: [
        { summary: summary('side-2', 't1', { createdAt: 5 }), state: state(other, [turn('o1')]) },
        { summary: summary('side-1', 't1', { createdAt: 2 }), state: state(side, [turn('s1')]) },
      ],
    });
    const firstBottom = at(graph, replyId(side, 's1')).y + 120;

    expect(at(graph, userId(side, 's1')).y).toBeLessThan(at(graph, userId(other, 'o1')).y);
    expect(at(graph, userId(other, 'o1')).y).toBe(firstBottom + MAP.gapY);
  });

  test('stacks a column by automatic slots only, so a dragged node never shifts another chain', () => {
    const other = sideRef('side-2');
    const sideChats = [
      { summary: summary('side-1', 't1', { createdAt: 2 }), state: state(side, [turn('s1'), turn('s2')]) },
      { summary: summary('side-2', 't1', { createdAt: 5 }), state: state(other, [turn('o1')]) },
    ];
    const before = build({ sideChats, drafts: [{ id: 'd1', parent: root, afterTurnId: 't1', text: '' }] });
    const dragged = build({
      sideChats, drafts: [{ id: 'd1', parent: root, afterTurnId: 't1', text: '' }],
      layout: layoutOf({ [replyId(side, 's1')]: { x: 5000, y: 2000 }, [userId(side, 's2')]: { x: 600, y: 4000 } }),
    });
    const positions = (graph: typeof before, ids: string[]) => ids.map((id) => at(graph, id));

    expect(at(dragged, replyId(side, 's1'))).toEqual({ x: 5000, y: 2000 });
    expect(positions(dragged, [userId(other, 'o1'), replyId(other, 'o1'), 'composer|d1']))
      .toEqual(positions(before, [userId(other, 'o1'), replyId(other, 'o1'), 'composer|d1']));
    expect(at(dragged, userId(side, 's2'))).toEqual({ x: 600, y: 4000 });
  });

  test('puts a side chat of a side chat one column further right', () => {
    const inner = sideRef('inner');
    const graph = build({
      sideChats: [
        { summary: summary('side-1', 't1'), state: state(side, [turn('s1')]) },
        { summary: summary('inner', 's1', { parentKey: conversationKey(side), createdAt: 2 }), state: state(inner, [turn('n1')]) },
      ],
    });
    const column = MAP.nodeWidth + MAP.gapX;

    expect(at(graph, userId(inner, 'n1')).x).toBe(column + MAP.nodeWidth + MAP.gapX);
    expect(at(graph, userId(inner, 'n1')).y).toBe(at(graph, replyId(side, 's1')).y);
    expect(column).toBeGreaterThan(0);
  });

  test('uses a saved position and width where the user has moved a node, and snaps the rest to the grid', () => {
    const saved = userId(root, 't1');
    const graph = build({
      layout: layoutOf({ [saved]: { x: 13, y: 17, width: 400 } }),
      heights: new Map([[saved, 113], [replyId(root, 't1'), 97]]),
    });

    expect(at(graph, saved)).toEqual({ x: 13, y: 17 });
    expect(find(graph, saved)?.width).toBe(400);
    for (const node of graph.nodes.filter((item) => item.id !== saved)) {
      expect(node.position.x % MAP.grid).toBe(0);
      expect(node.position.y % MAP.grid).toBe(0);
    }
    expect(at(graph, replyId(root, 't1')).y).toBe(160);
  });
});

describe('buildMapGraph drafts', () => {
  const side = sideRef('side-1');
  const draft = (overrides: Partial<SideChatDraft> = {}): SideChatDraft =>
    ({ id: 'd1', parent: root, afterTurnId: 't1', text: 'hmm', ...overrides });
  const composer = (graph: ReturnType<typeof build>) => graph.nodes.find((node) => node.type === 'composer');
  const composerId = (graph: ReturnType<typeof build>) => need(composer(graph)).id;

  test('draws a new side chat draft at the automatic spot, joined to the parent reply', () => {
    const graph = build({ drafts: [draft()] });

    expect(composer(graph)?.data).toMatchObject({ kind: 'composer', draft: { id: 'd1' } });
    expect(composer(graph)?.position).toEqual({ x: MAP.nodeWidth + MAP.gapX, y: at(graph, replyId(root, 't1')).y });
    expect(graph.edges.find((edge) => edge.target === composerId(graph))).toMatchObject({ source: replyId(root, 't1'), sourceHandle: 'branch', className: 'map-edge-side' });
  });

  test('keeps a draft the user has moved at its position', () => {
    const graph = build({ drafts: [draft({ position: { x: 11, y: 22 } })] });

    expect(composer(graph)?.position).toEqual({ x: 11, y: 22 });
  });

  test('puts a draft that continues a side chat below its last node, joined to its latest reply', () => {
    const graph = build({
      sideChats: [{ summary: summary('side-1', 't1'), state: state(side, [turn('s1')]) }],
      drafts: [draft({ continues: side })],
    });
    const last = at(graph, replyId(side, 's1'));

    expect(composer(graph)?.position).toEqual({ x: last.x, y: last.y + 120 + MAP.gapY });
    const edge = graph.edges.find((item) => item.target === composerId(graph));
    expect(edge).toMatchObject({ source: replyId(side, 's1'), className: 'map-edge-side' });
    expect(edge?.sourceHandle).toBeUndefined();
  });

  test('stacks two new drafts from the same reply instead of overlapping them', () => {
    const graph = build({ drafts: [draft(), draft({ id: 'd2' })] });
    const [first, second] = graph.nodes.filter((node) => node.type === 'composer');

    expect(second.position.y).toBe(first.position.y + 120 + MAP.gapY);
  });

  test('leaves out a draft whose parent reply is not on the map', () => {
    expect(composer(build({ drafts: [draft({ afterTurnId: 'gone' })] }))).toBeUndefined();
  });
});
