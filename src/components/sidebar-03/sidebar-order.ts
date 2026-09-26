import { conversationKey, type ProjectConversationGroup } from '@/shared/conversation-contract';
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
