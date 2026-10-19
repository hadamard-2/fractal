import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
}

interface StoredBranches { conversations: Record<string, BranchRecord> }

/**
 * Which conversations are side chats or forks, and what each branched from.
 * Fractal's own record in userData, since neither agent's session files say so.
 * That record is what keeps a side chat read-only after a restart, so it fails closed:
 * only a missing file reads as empty, and any other read error throws. A file that
 * does not parse is moved aside to `branches.json.corrupt-<timestamp>` rather than
 * overwritten, then reads as empty. The records are loaded once and kept in memory,
 * and every write goes through to disk, so a file that becomes unreadable later
 * cannot drop what this process already knows. An invalid entry is dropped while
 * its valid siblings are kept.
 */
export class BranchStore {
  private readonly filePath: string;
  private stored: StoredBranches | undefined;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'branches.json');
    mkdirSync(rootDir, { recursive: true });
  }

  get(conversationKey: string): BranchRecord | undefined { return this.load().conversations[conversationKey]; }

  set(conversationKey: string, record: BranchRecord): void {
    const stored = this.load();
    stored.conversations[conversationKey] = record;
    this.save(stored);
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
    let conversations: Record<string, unknown> | undefined;
    try { conversations = objectValue(objectValue(JSON.parse(text))?.conversations); } catch { /* moved aside below */ }
    if (!conversations) {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      return this.stored = stored;
    }
    for (const [key, value] of Object.entries(conversations)) {
      const entry = coerceEntry(value);
      if (entry) stored.conversations[key] = entry;
    }
    return this.stored = stored;
  }

  private save(stored: StoredBranches): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}

/**
 * Whether a conversation must run read-only. A store that cannot be read cannot say it is not a side chat,
 * so an error counts as one: the agents ask this before every run and fail closed.
 */
export function isSideChat(branches: Pick<BranchStore, 'get'>, conversationKey: string): boolean {
  try { return branches.get(conversationKey)?.kind === 'side-chat'; } catch { return true; }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function coerceEntry(value: unknown): BranchRecord | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const { parentKey, afterTurnId, inheritedTurnCount, note, createdAt } = record;
  if (typeof parentKey !== 'string') return undefined;
  if (afterTurnId !== null && typeof afterTurnId !== 'string') return undefined;
  if (typeof inheritedTurnCount !== 'number' || !Number.isInteger(inheritedTurnCount) || inheritedTurnCount < 0) return undefined;
  if (note !== undefined && typeof note !== 'string') return undefined;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined;
  let kind: BranchKind;
  try { kind = parseBranchKind(record.kind); } catch { return undefined; }
  const entry: BranchRecord = { kind, parentKey, afterTurnId: afterTurnId as string | null, inheritedTurnCount, createdAt };
  if (typeof note === 'string') entry.note = note;
  return entry;
}
