import { conversationKey, type ConversationSummary, type ProjectConversationGroup } from '@/shared/conversation-contract';
import type { SidebarOrder } from '@/shared/settings-contract';

function applySavedOrder<T>(items: T[], saved: string[], key: (item: T) => string): T[] {
  if (saved.length === 0) return items;
  const positions = new Map(saved.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const left = positions.get(key(a));
    const right = positions.get(key(b));
    if (left === undefined) return right === undefined ? 0 : -1;
    if (right === undefined) return 1;
    return left - right;
  });
}

// Child conversations (spawned by another conversation) aren't sidebar rows.
export function topLevelConversations(groups: ProjectConversationGroup[]): ProjectConversationGroup[] {
  return groups
    .map((group) => ({ ...group, conversations: group.conversations.filter((item) => item.parentId === undefined) }))
    .filter((group) => group.conversations.length > 0);
}

export interface ChatRow { conversation: ConversationSummary; forks: ChatRow[] }

/** A project's chats as a tree: a fork under its parent when the parent is among `conversations`, else at the top level in its own place. */
export function chatRows(conversations: ConversationSummary[]): ChatRow[] {
  const byKey = new Map(conversations.map((item) => [conversationKey(item.ref), item]));
  const listedParent = (item: ConversationSummary) => {
    const key = item.forkedFrom?.parentKey;
    return key === undefined ? undefined : byKey.get(key);
  };
  // Forks whose lineage loops back to themselves have no parent to sit under.
  const inLoop = (item: ConversationSummary) => {
    const seen = new Set<ConversationSummary>();
    for (let parent = listedParent(item); parent && !seen.has(parent); parent = listedParent(parent)) {
      if (parent === item) return true;
      seen.add(parent);
    }
    return false;
  };

  const forksOf = new Map<ConversationSummary, ConversationSummary[]>();
  const topLevel: ConversationSummary[] = [];
  for (const item of conversations) {
    const parent = listedParent(item);
    if (parent && !inLoop(item)) forksOf.set(parent, [...(forksOf.get(parent) ?? []), item]);
    else topLevel.push(item);
  }
  const startedAt = (item: ConversationSummary) => item.createdAt ?? item.updatedAt;
  const row = (conversation: ConversationSummary): ChatRow => ({
    conversation,
    forks: [...(forksOf.get(conversation) ?? [])].sort((a, b) => startedAt(a) - startedAt(b)).map(row),
  });
  return topLevel.map(row);
}

export function applySidebarOrder(groups: ProjectConversationGroup[], order: SidebarOrder): ProjectConversationGroup[] {
  return applySavedOrder(groups, order.projects, (group) => group.projectPath).map((group) => ({
    ...group,
    conversations: applySavedOrder(group.conversations, order.chatsByProject[group.projectPath] ?? [], (item) => conversationKey(item.ref)),
  }));
}

export function moveInOrder(ids: string[], source: string, target: string): string[] {
  const from = ids.indexOf(source);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}
