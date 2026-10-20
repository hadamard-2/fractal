import { expect, test } from 'vitest';
import { applySidebarOrder, chatRows, moveInOrder, topLevelConversations, type ChatRow } from './sidebar-order';
import type { ConversationSummary, ProjectConversationGroup } from '@/shared/conversation-contract';

const group = (projectPath: string, ids: string[]): ProjectConversationGroup => ({
  projectPath,
  displayName: projectPath,
  conversations: ids.map((nativeSessionId, index) => ({
    ref: { provider: 'codex', nativeSessionId, projectPath },
    title: nativeSessionId,
    updatedAt: ids.length - index,
    runtime: 'idle',
    captureCompleteness: 'complete',
  })),
});

test('uses recent order by default and keeps new items ahead of saved manual order', () => {
  const recent = [group('/new', ['new']), group('/first', ['fresh', 'older', 'oldest']), group('/second', ['other'])];
  expect(applySidebarOrder(recent, { projects: [], chatsByProject: {} })).toEqual(recent);
  const ordered = applySidebarOrder(recent, {
    projects: ['/second', '/first'],
    chatsByProject: { '/first': ['codex:oldest', 'codex:older'] },
  });
  expect(ordered.map((item) => item.projectPath)).toEqual(['/new', '/second', '/first']);
  expect(ordered[2].conversations.map((item) => item.title)).toEqual(['fresh', 'oldest', 'older']);
});

test('moves an item without changing order on an invalid or same-item drop', () => {
  expect(moveInOrder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(moveInOrder(['a', 'b', 'c'], 'c', 'missing')).toEqual(['a', 'b', 'c']);
  expect(moveInOrder(['a', 'b', 'c'], 'b', 'b')).toEqual(['a', 'b', 'c']);
});

test('lists only top-level conversations and drops projects left empty', () => {
  const withChild = group('/repo', ['parent', 'parent/agent-a1']);
  withChild.conversations[1].parentId = 'parent';
  const onlyChild = group('/orphan', ['gone/agent-b2']);
  onlyChild.conversations[0].parentId = 'gone';
  const result = topLevelConversations([withChild, onlyChild]);
  expect(result.map((item) => [item.projectPath, item.conversations.map((conversation) => conversation.title)])).toEqual([['/repo', ['parent']]]);
});

const chat = (nativeSessionId: string, fields: Partial<ConversationSummary> = {}): ConversationSummary => ({
  ref: { provider: 'claude', nativeSessionId, projectPath: '/repo' },
  title: nativeSessionId,
  updatedAt: 0,
  runtime: 'idle',
  captureCompleteness: 'complete',
  ...fields,
});
const forkOf = (parent: string) => ({ forkedFrom: { parentKey: `claude:${parent}` } });
const shape = (rows: ChatRow[]): unknown[] => rows.map((row) => row.forks.length ? [row.conversation.title, shape(row.forks)] : row.conversation.title);

test('nests forks under their parent, oldest first, at any depth', () => {
  const rows = chatRows([
    chat('a'),
    chat('f1', { ...forkOf('a'), createdAt: 2 }),
    chat('b'),
    chat('f2', { ...forkOf('a'), createdAt: 1 }),
    chat('g', forkOf('f1')),
  ]);
  expect(shape(rows)).toEqual([['a', ['f2', ['f1', ['g']]]], 'b']);
});

test('falls back to the last update to order forks without a creation time', () => {
  const rows = chatRows([chat('a'), chat('late', { ...forkOf('a'), updatedAt: 5 }), chat('early', { ...forkOf('a'), updatedAt: 3 })]);
  expect(shape(rows)).toEqual([['a', ['early', 'late']]]);
});

test('keeps a fork whose parent is not listed at the top level in its own place', () => {
  expect(shape(chatRows([chat('a'), chat('orphan', forkOf('gone')), chat('b')]))).toEqual(['a', 'orphan', 'b']);
});

test('lists forks that name each other as parents at the top level', () => {
  const rows = chatRows([chat('x', forkOf('y')), chat('a'), chat('y', forkOf('x')), chat('h', forkOf('x')), chat('self', forkOf('self'))]);
  expect(shape(rows)).toEqual([['x', ['h']], 'a', 'y', 'self']);
});
