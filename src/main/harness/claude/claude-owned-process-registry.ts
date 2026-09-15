import type { ConversationRef } from '@/shared/conversation-contract';

export class ClaudeOwnedProcessRegistry {
  private readonly owners = new Map<string, number>();

  has(ref: ConversationRef): boolean { return (this.owners.get(key(ref)) ?? 0) > 0; }

  claim(ref: ConversationRef): () => void {
    const identity = key(ref);
    this.owners.set(identity, (this.owners.get(identity) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.owners.get(identity) ?? 1) - 1;
      if (remaining > 0) this.owners.set(identity, remaining);
      else this.owners.delete(identity);
    };
  }
}

function key(ref: ConversationRef): string { return `${ref.nativeSessionId}\u0000${ref.projectPath}`; }
