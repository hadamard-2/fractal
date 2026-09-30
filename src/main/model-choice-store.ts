import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelChoice, ProviderId } from '@/shared/conversation-contract';
import { parseModelChoice } from '@/shared/conversation-ipc';

interface StoredChoices {
  conversations: Record<string, ModelChoice>;
  lastUsed: Partial<Record<ProviderId, ModelChoice>>;
}

const PROVIDERS: readonly ProviderId[] = ['codex', 'claude'];
const empty = (): StoredChoices => ({ conversations: {}, lastUsed: {} });

/**
 * Per-conversation model choices and the last choice sent with each agent.
 * Kept apart from settings.json so a renderer settings patch can never
 * overwrite them. This is Fractal's own convenience state, so an unreadable
 * file reads as empty and is replaced on the next write rather than blocking
 * a conversation.
 */
export class ModelChoiceStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'model-choices.json');
    mkdirSync(rootDir, { recursive: true });
  }

  get(conversationKey: string): ModelChoice | undefined { return this.load().conversations[conversationKey]; }

  set(conversationKey: string, choice: ModelChoice): void {
    const stored = this.load();
    stored.conversations[conversationKey] = choice;
    this.save(stored);
  }

  lastUsed(provider: ProviderId): ModelChoice | undefined { return this.load().lastUsed[provider]; }

  setLastUsed(provider: ProviderId, choice: ModelChoice | null): void {
    const stored = this.load();
    if (choice) stored.lastUsed[provider] = choice;
    else delete stored.lastUsed[provider];
    this.save(stored);
  }

  private load(): StoredChoices {
    if (!existsSync(this.filePath)) return empty();
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { return empty(); }
    const record = objectValue(parsed);
    const stored = empty();
    for (const [key, value] of Object.entries(objectValue(record?.conversations) ?? {})) {
      const choice = coerceChoice(value);
      if (choice) stored.conversations[key] = choice;
    }
    const lastUsed = objectValue(record?.lastUsed);
    for (const provider of PROVIDERS) {
      const choice = coerceChoice(lastUsed?.[provider]);
      if (choice) stored.lastUsed[provider] = choice;
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

function coerceChoice(value: unknown): ModelChoice | undefined {
  try { return parseModelChoice(value) ?? undefined; } catch { return undefined; }
}
