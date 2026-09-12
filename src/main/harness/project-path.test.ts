import { describe, expect, test } from 'vitest';
import { groupConversationsByProject } from '@/main/harness/project-path';
import type { ConversationSummary } from '@/shared/conversation-contract';

const summary = (provider: 'codex' | 'claude', id: string, path: string, updatedAt: number): ConversationSummary => ({
  ref: { provider, nativeSessionId: id, projectPath: path },
  title: id,
  updatedAt,
  runtime: 'idle',
  captureCompleteness: 'complete',
});

describe('groupConversationsByProject', () => {
  test('merges providers by real path and sorts projects and sessions by recency', async () => {
    const groups = await groupConversationsByProject([
      summary('claude', 'c1', '/link/fractal', 20),
      summary('codex', 'x1', '/work/fractal', 30),
      summary('codex', 'x2', '/work/other', 10),
    ], async (path) => path === '/link/fractal' ? '/work/fractal' : path);
    expect(groups.map((group) => [group.projectPath, group.conversations.map((item) => item.ref.nativeSessionId)])).toEqual([
      ['/work/fractal', ['x1', 'c1']],
      ['/work/other', ['x2']],
    ]);
  });
});
