const listeners = new Set<(rootKey: string) => void>();

/** Tells every useSideChats for this root (by conversationKey) to list again. */
export function announceSideChats(rootKey: string): void {
  for (const listener of [...listeners]) listener(rootKey);
}

export function onSideChatsChanged(listener: (rootKey: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
