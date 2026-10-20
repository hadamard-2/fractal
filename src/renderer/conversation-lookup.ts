import { conversationKey, type ConversationRef, type ProjectConversationGroup } from '@/shared/conversation-contract';

/**
 * Whether the listed summary of `ref` names a parent: a subagent conversation is the agent's own record of work it
 * delegated, so nothing branches from it. False for a conversation the listing doesn't have.
 */
export function isSubagentConversation(projects: readonly ProjectConversationGroup[], ref: ConversationRef): boolean {
  const key = conversationKey(ref);
  const summary = projects.flatMap((project) => project.conversations).find((conversation) => conversationKey(conversation.ref) === key);
  return summary?.parentId !== undefined;
}
