import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * An unreadable file or invalid entry reads as absent and is replaced on the
 * next write rather than blocking a conversation.
 */
export class BranchStore {
  private readonly filePath: string;

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
    const stored: StoredBranches = { conversations: {} };
    if (!existsSync(this.filePath)) return stored;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { return stored; }
    for (const [key, value] of Object.entries(objectValue(objectValue(parsed)?.conversations) ?? {})) {
      const entry = coerceEntry(value);
      if (entry) stored.conversations[key] = entry;
    }
    return stored;
  }

  private save(stored: StoredBranches): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2));
    renameSync(tmpPath, this.filePath);
  }
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
