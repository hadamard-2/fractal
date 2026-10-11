import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AccessState } from '@/shared/conversation-contract';
import { parseAccessState } from '@/shared/conversation-ipc';

export interface StoredAccess {
  state: AccessState;
  /** False once picked, true after a turn has been sent with it. */
  sent: boolean;
}

interface StoredChoices { conversations: Record<string, StoredAccess> }

/**
 * Per-conversation access levels the user picked. Kept apart from settings.json
 * so a renderer settings patch can never overwrite them. This is Fractal's own
 * convenience state, so an unreadable file or invalid entry reads as absent and
 * is replaced on the next write rather than blocking a conversation.
 */
export class AccessChoiceStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'access-choices.json');
    mkdirSync(rootDir, { recursive: true });
  }

  get(conversationKey: string): StoredAccess | undefined { return this.load().conversations[conversationKey]; }

  set(conversationKey: string, value: StoredAccess): void {
    const stored = this.load();
    stored.conversations[conversationKey] = value;
    this.save(stored);
  }

  private load(): StoredChoices {
    const stored: StoredChoices = { conversations: {} };
    if (!existsSync(this.filePath)) return stored;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { return stored; }
    for (const [key, value] of Object.entries(objectValue(objectValue(parsed)?.conversations) ?? {})) {
      const entry = coerceEntry(value);
      if (entry) stored.conversations[key] = entry;
    }
    return stored;
  }

  private save(stored: StoredChoices): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function coerceEntry(value: unknown): StoredAccess | undefined {
  const record = objectValue(value);
  if (!record || typeof record.sent !== 'boolean') return undefined;
  try { return { state: parseAccessState(record.state), sent: record.sent }; } catch { return undefined; }
}
