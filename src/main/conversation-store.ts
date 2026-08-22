import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type Conversation, type Entry } from '@/shared/agent-contract';

interface StoredConversation {
  conversation: Conversation;
  entries: Entry[];
}

export class ConversationStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, 'conversations');
    this.indexPath = path.join(this.dir, 'index.json');
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private readIndex(): Conversation[] {
    if (!existsSync(this.indexPath)) return [];
    return JSON.parse(readFileSync(this.indexPath, 'utf8')) as Conversation[];
  }

  private writeIndex(list: Conversation[]) {
    writeFileSync(this.indexPath, JSON.stringify(list, null, 2));
  }

  create(repoRoot: string): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: randomUUID(),
      title: 'New conversation',
      repoRoot,
      createdAt: now,
      updatedAt: now,
      schemaVersion: CONTRACT_VERSION,
    };
    writeFileSync(this.filePath(conversation.id), JSON.stringify({ conversation, entries: [] }, null, 2));
    this.writeIndex([...this.readIndex(), conversation]);
    return conversation;
  }

  list(): Conversation[] {
    return this.readIndex();
  }

  load(id: string): StoredConversation | null {
    const p = this.filePath(id);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as StoredConversation;
    if (raw.conversation.schemaVersion > CONTRACT_VERSION) {
      throw new Error(
        `Conversation ${id} was created by a newer version of Fractal ` +
          `(schema ${raw.conversation.schemaVersion} > ${CONTRACT_VERSION}).`,
      );
    }
    // Forward migrations for older schemas go here as CONTRACT_VERSION grows.
    return raw;
  }

  saveEntry(id: string, entry: Entry): void {
    const stored = this.load(id);
    if (!stored) throw new Error(`Conversation ${id} not found`);
    const idx = stored.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) stored.entries[idx] = entry;
    else stored.entries.push(entry);
    stored.conversation.updatedAt = Date.now();
    writeFileSync(this.filePath(id), JSON.stringify(stored, null, 2));
    this.syncIndex(stored.conversation);
  }

  updateMeta(id: string, patch: { title?: string }): void {
    const stored = this.load(id);
    if (!stored) throw new Error(`Conversation ${id} not found`);
    if (patch.title !== undefined) stored.conversation.title = patch.title;
    stored.conversation.updatedAt = Date.now();
    writeFileSync(this.filePath(id), JSON.stringify(stored, null, 2));
    this.syncIndex(stored.conversation);
  }

  private syncIndex(conversation: Conversation) {
    const list = this.readIndex();
    const idx = list.findIndex((c) => c.id === conversation.id);
    if (idx >= 0) list[idx] = conversation;
    else list.push(conversation);
    this.writeIndex(list);
  }

  /** Test-only: write raw stored content, bypassing validation. */
  forceWriteRawForTest(id: string, raw: StoredConversation): void {
    writeFileSync(this.filePath(id), JSON.stringify(raw, null, 2));
  }
}
