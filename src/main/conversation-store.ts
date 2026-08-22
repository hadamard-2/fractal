import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type Conversation, type Entry } from '@/shared/agent-contract';

interface StoredConversation {
  conversation: Conversation;
  entries: Entry[];
}

// Ids are always minted by randomUUID() (conversation-store.create, or
// randomUUID() elsewhere). A strict UUID shape check therefore rejects any
// id the renderer could have supplied to escape `dir` (e.g. `../../etc`)
// by construction, without needing to special-case path separators.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidId(id: string): void {
  if (!UUID_RE.test(id)) {
    // Deliberately does not echo `id` verbatim: an attacker-chosen id is the
    // exact string this guard exists to keep out of error messages/logs.
    throw new Error('Conversation id must be a UUID; rejected an id of the wrong shape.');
  }
}

function isStoredConversation(value: unknown): value is StoredConversation {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.conversation === 'object' &&
    v.conversation !== null &&
    typeof (v.conversation as Record<string, unknown>).id === 'string' &&
    typeof (v.conversation as Record<string, unknown>).schemaVersion === 'number' &&
    Array.isArray(v.entries)
  );
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
    assertValidId(id);
    return path.join(this.dir, `${id}.json`);
  }

  /** Parse JSON from disk, rethrowing with the failing path if it's corrupt or truncated. */
  private readJson<T>(filePath: string): T {
    const raw = readFileSync(filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Deliberately does not include the underlying parser's message: V8's
      // SyntaxError embeds a snippet of the file's own contents, which would
      // turn this error into a small file-read primitive for any caller who
      // can trigger a parse failure and read the thrown message.
      throw new Error(`Conversation file ${filePath} is corrupt or truncated.`);
    }
    return parsed as T;
  }

  /** Parse and shape-check a stored conversation file before anything dereferences it. */
  private readStoredConversation(filePath: string): StoredConversation {
    const parsed = this.readJson<unknown>(filePath);
    if (!isStoredConversation(parsed)) {
      throw new Error(`Conversation file ${filePath} does not have the expected shape.`);
    }
    return parsed;
  }

  /** Write JSON via write-temp-then-rename so a crash mid-write can't leave a half-written file. */
  private writeJsonAtomic(filePath: string, value: unknown): void {
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(value, null, 2));
    renameSync(tmpPath, filePath);
  }

  private readIndex(): Conversation[] {
    if (!existsSync(this.indexPath)) return [];
    return this.readJson<Conversation[]>(this.indexPath);
  }

  private writeIndex(list: Conversation[]) {
    this.writeJsonAtomic(this.indexPath, list);
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
    this.writeJsonAtomic(this.filePath(conversation.id), { conversation, entries: [] });
    this.writeIndex([...this.readIndex(), conversation]);
    return conversation;
  }

  list(): Conversation[] {
    return this.readIndex();
  }

  load(id: string): StoredConversation | null {
    const p = this.filePath(id);
    if (!existsSync(p)) return null;
    const raw = this.readStoredConversation(p);
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
    this.writeJsonAtomic(this.filePath(id), stored);
    this.syncIndex(stored.conversation);
  }

  updateMeta(id: string, patch: { title?: string }): void {
    const stored = this.load(id);
    if (!stored) throw new Error(`Conversation ${id} not found`);
    if (patch.title !== undefined) stored.conversation.title = patch.title;
    stored.conversation.updatedAt = Date.now();
    this.writeJsonAtomic(this.filePath(id), stored);
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
    this.writeJsonAtomic(this.filePath(id), raw);
  }
}
