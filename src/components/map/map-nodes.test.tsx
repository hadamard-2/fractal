// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetConversationHubForTests } from '@/renderer/conversation-hub';
import { mapNodeId, type MapNodeData } from '@/renderer/map/map-graph';
import { conversationKey, type ConversationApi, type ConversationRef, type ConversationTurn, type SideChatSummary } from '@/shared/conversation-contract';
import type { MapView } from '@/shared/map-contract';
import { MAP_NODE_TYPES, MapNodeEnvironmentContext, type MapNodeEnvironment } from './map-nodes';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const side: ConversationRef = { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' };
const turn: ConversationTurn = {
  id: 't1', nativeId: 't1', userMessage: { id: 't1-user', text: 'Why is the parser slow?' },
  blocks: [{ id: 't1-prose', kind: 'assistant-prose', text: 'It re-reads every file.', provider: 'claude', concludesTurn: true }],
  status: 'completed', captureCompleteness: 'complete',
};
const sideChat: SideChatSummary = { ref: side, parentKey: conversationKey(root), afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1, branchPointText: 'It re-reads every file.' };

// React Flow keeps a node hidden until it's measured, which jsdom never does.
const measured = { width: 320, height: 120 };
const nodes: Node<MapNodeData>[] = [
  { id: mapNodeId(root, 't1', 'user'), type: 'user', position: { x: 0, y: 0 }, measured, data: { kind: 'user', owner: root, line: 'main', turn, canBranch: true } },
  { id: mapNodeId(root, 't1', 'reply'), type: 'reply', position: { x: 0, y: 200 }, measured, data: { kind: 'reply', owner: root, line: 'main', turn, latest: true, canBranch: true } },
  { id: 'composer|d1', type: 'composer', position: { x: 400, y: 0 }, measured, data: { kind: 'composer', draft: { id: 'd1', parent: root, afterTurnId: 't1', text: '' } } },
  { id: `detached|${conversationKey(side)}`, type: 'detached', position: { x: 400, y: 200 }, measured, data: { kind: 'detached', sideChat } },
];

function renderNodes(view: MapView, fork?: Partial<NonNullable<MapNodeEnvironment['fork']>> | null) {
  const environment: MapNodeEnvironment = {
    view, sideChats: new Map(), onResizeEnd: () => undefined,
    ...(fork === null ? {} : { fork: { can: () => true, start: vi.fn(), ...fork } }),
  };
  render(
    <ReactFlowProvider>
      <MapNodeEnvironmentContext.Provider value={environment}>
        <div style={{ width: 800, height: 600 }}><ReactFlow nodeTypes={MAP_NODE_TYPES} nodes={nodes} /></div>
      </MapNodeEnvironmentContext.Provider>
    </ReactFlowProvider>,
  );
  return environment;
}

const nodeOf = (kind: MapNodeData['kind']) => {
  const node = document.querySelector(`.react-flow__node-${kind}`);
  if (!(node instanceof HTMLElement)) throw new Error(`No ${kind} node`);
  return node;
};
const forksIn = (kind: MapNodeData['kind']) => within(nodeOf(kind)).queryAllByRole('button', { name: 'Fork from here' });

beforeEach(() => {
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { onEvent: (): (() => void) => () => undefined } as unknown as ConversationApi } });
  resetConversationHubForTests();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test.each(['preview', 'full'] as const)('in %s, a user node forks before its message and a reply node after its reply', (view) => {
  const environment = renderNodes(view);
  const start = vi.mocked(environment.fork?.start);
  expect(forksIn('user')).toHaveLength(1);
  fireEvent.click(forksIn('user')[0]);
  expect(start).toHaveBeenLastCalledWith(root, turn, 'before');
  expect(forksIn('reply')).toHaveLength(1);
  fireEvent.click(forksIn('reply')[0]);
  expect(start).toHaveBeenLastCalledWith(root, turn, 'after');
});

test('a node asks the environment whether it can fork at its own point', () => {
  const can = vi.fn((_owner: ConversationRef, _turn: ConversationTurn, position: 'before' | 'after') => position === 'after');
  renderNodes('preview', { can });
  expect(forksIn('user')).toHaveLength(0);
  expect(forksIn('reply')).toHaveLength(1);
  expect(can).toHaveBeenCalledWith(root, turn, 'before');
  expect(can).toHaveBeenCalledWith(root, turn, 'after');
});

test('without fork in the environment, no node offers one', () => {
  renderNodes('full', null);
  expect(screen.queryAllByRole('button', { name: 'Fork from here' })).toHaveLength(0);
});

test('composer and detached nodes never offer a fork', () => {
  renderNodes('full');
  expect(forksIn('composer')).toHaveLength(0);
  expect(forksIn('detached')).toHaveLength(0);
});

test('in Full, the message bodies keep Copy without a second fork of their own', () => {
  renderNodes('full');
  expect(within(nodeOf('user')).getByRole('button', { name: 'Copy message' })).toBeTruthy();
  expect(within(nodeOf('reply')).getByRole('button', { name: 'Copy response' })).toBeTruthy();
  expect(forksIn('user')).toHaveLength(1);
  expect(forksIn('reply')).toHaveLength(1);
});
