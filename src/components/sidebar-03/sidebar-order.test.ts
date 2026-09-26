import { expect, test } from 'vitest';
import { applySidebarOrder, moveInOrder, topLevelConversations } from './sidebar-order';
import type { ProjectConversationGroup } from '@/shared/conversation-contract';

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
