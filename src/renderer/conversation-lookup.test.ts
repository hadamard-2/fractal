import { expect, test } from 'vitest';
import type { ConversationRef, ProjectConversationGroup } from '@/shared/conversation-contract';
import { isSubagentConversation } from './conversation-lookup';

const ref = (nativeSessionId: string): ConversationRef => ({ provider: 'claude', nativeSessionId, projectPath: '/repo' });
const projects: ProjectConversationGroup[] = [{
  projectPath: '/repo',
  displayName: 'Repo',
  conversations: [
    { ref: ref('main'), title: 'Main', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' },
    { ref: ref('agent'), title: 'Agent', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete', parentId: 'main' },
  ],
}];

test('a conversation is a subagent conversation when its summary names a parent', () => {
  expect(isSubagentConversation(projects, ref('agent'))).toBe(true);
  expect(isSubagentConversation(projects, { ...ref('main') })).toBe(false);
  expect(isSubagentConversation(projects, ref('unlisted'))).toBe(false);
});
