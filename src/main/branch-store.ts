import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BranchKind } from '@/shared/conversation-contract';
import { parseBranchKind } from '@/shared/conversation-ipc';

export interface BranchRecord {
  kind: BranchKind;
  /** conversationKey() of the conversation this one branched from. */
  parentKey: string;
  /** The parent's ConversationTurn.id this branch carries history through; null when it carries none. */
  afterTurnId: string | null;
  /** How many of this conversation's leading turns came from the parent; where phase 4's divider goes, since Claude forks get fresh turn ids. */
  inheritedTurnCount: number;
  /** Told to the agent on every turn (Claude) or set once at fork time (Codex). */
  note?: string;
  createdAt: number;
  /** The start of the reply a side chat was cut after, at most 500 characters; shown when that reply is gone. */
  branchPointText?: string;
}

interface StoredBranches { conversations: Record<string, BranchRecord> }

/**
 * Which conversations are side chats or forks, and what each branched from.
 * Fractal's own record in userData, since neither agent's session files say so.
 * That record is what keeps a side chat read-only after a restart, so it fails closed:
 * only a missing file reads as empty, and any other read error throws. A file that
 * does not parse is moved aside to `branches.json.corrupt-<timestamp>` rather than
 * overwritten, then the previous state in `branches.json.bak` is read instead and written back
 * to `branches.json` (empty when that does not parse either). Every write first copies the file it replaces to
 * `branches.json.bak`. The records are loaded once and kept in memory,
 * and every write goes through to disk, so a file that becomes unreadable later
 * cannot drop what this process already knows. An invalid entry is dropped while
 * its valid siblings are kept.
 */
export class BranchStore {
  private readonly filePath: string;
  private readonly backupPath: string;
  private stored: StoredBranches | undefined;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'branches.json');
    this.backupPath = `${this.filePath}.bak`;
    mkdirSync(rootDir, { recursive: true });
  }

  get(conversationKey: string): BranchRecord | undefined { return this.load().conversations[conversationKey]; }

  set(conversationKey: string, record: BranchRecord): void {
    const stored = this.load();
    stored.conversations[conversationKey] = record;
    this.save(stored);
  }

  delete(conversationKey: string): void {
    const stored = this.load();
    if (!Object.hasOwn(stored.conversations, conversationKey)) return;
    delete stored.conversations[conversationKey];
    this.save(stored);
  }

  /** Every record below `conversationKey`, at any depth, as [key, record] pairs, parents before children, oldest first among siblings. */
  descendants(conversationKey: string): Array<[string, BranchRecord]> {
    const children = new Map<string, Array<[string, BranchRecord]>>();
    for (const entry of Object.entries(this.load().conversations)) {
      const siblings = children.get(entry[1].parentKey);
      if (siblings) siblings.push(entry); else children.set(entry[1].parentKey, [entry]);
    }
    const visited = new Set([conversationKey]);
    const found: Array<[string, BranchRecord]> = [];
    const queue = [conversationKey];
    for (const key of queue) {
      const below = (children.get(key) ?? []).filter(([childKey]) => !visited.has(childKey)).sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const entry of below) { visited.add(entry[0]); found.push(entry); queue.push(entry[0]); }
    }
    return found;
  }

  sideChatKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [key, record] of Object.entries(this.load().conversations)) {
      if (record.kind === 'side-chat') keys.add(key);
    }
    return keys;
  }

  private load(): StoredBranches {
    if (this.stored) return this.stored;
    const stored: StoredBranches = { conversations: {} };
    let text: string;
    try { text = readFileSync(this.filePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.stored = stored;
      throw error;
    }
    let conversations = parseConversations(text);
    let recovered = false;
    if (!conversations) {
      // Read before moving anything, so a backup that cannot be read throws with the bad file still in place.
      conversations = this.readBackup();
      recovered = conversations !== undefined;
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    }
    for (const [key, value] of Object.entries(conversations ?? {})) {
      const entry = coerceEntry(value);
      if (entry) stored.conversations[key] = entry;
    }
    this.stored = stored;
    // The bad file is gone, so without this the next launch would find no file and start empty, ignoring the backup.
    // If the write fails the records stay in memory, and the next successful write restores the file.
    if (recovered) { try { this.save(stored); } catch { /* kept in memory */ } }
    return stored;
  }

  private readBackup(): Record<string, unknown> | undefined {
    try { return parseConversations(readFileSync(this.backupPath, 'utf8')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private save(stored: StoredBranches): void {
    this.backUpCurrentFile();
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Best effort: a file that is missing, unreadable or does not parse is not worth keeping, and must not stop the write. */
  private backUpCurrentFile(): void {
    try {
      if (!parseConversations(readFileSync(this.filePath, 'utf8'))) return;
      copyFileSync(this.filePath, this.backupPath);
    } catch { /* nothing to back up */ }
  }
}

/**
 * Whether a conversation must run read-only. A store that cannot be read cannot say it is not a side chat,
 * so an error counts as one: the agents ask this before every run and fail closed.
 */
export function isSideChat(branches: Pick<BranchStore, 'get'>, conversationKey: string): boolean {
  try { return branches.get(conversationKey)?.kind === 'side-chat'; } catch { return true; }
}

function parseConversations(text: string): Record<string, unknown> | undefined {
  try { return objectValue(objectValue(JSON.parse(text))?.conversations); } catch { return undefined; }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function coerceEntry(value: unknown): BranchRecord | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const { parentKey, afterTurnId, inheritedTurnCount, note, createdAt, branchPointText } = record;
  if (typeof parentKey !== 'string') return undefined;
  if (afterTurnId !== null && typeof afterTurnId !== 'string') return undefined;
  if (typeof inheritedTurnCount !== 'number' || !Number.isInteger(inheritedTurnCount) || inheritedTurnCount < 0) return undefined;
  if (note !== undefined && typeof note !== 'string') return undefined;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined;
  let kind: BranchKind;
  try { kind = parseBranchKind(record.kind); } catch { return undefined; }
  const entry: BranchRecord = { kind, parentKey, afterTurnId: afterTurnId as string | null, inheritedTurnCount, createdAt };
  if (typeof note === 'string') entry.note = note;
  if (typeof branchPointText === 'string') entry.branchPointText = branchPointText;
  return entry;
}
