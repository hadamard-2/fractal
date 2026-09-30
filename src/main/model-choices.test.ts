import { describe, expect, test, vi } from 'vitest';
import { ModelChoices } from './model-choices';
import type { AgentModel, ConversationRef, ModelChoice, ProviderId } from '@/shared/conversation-contract';

const claudeRef: ConversationRef = { provider: 'claude', nativeSessionId: 'a', projectPath: '/work' };
const codexRef: ConversationRef = { provider: 'codex', nativeSessionId: 'b', projectPath: '/work' };
const opus: AgentModel = { id: 'opus', label: 'Opus', efforts: ['high'] };

function memoryStore() {
  const conversations = new Map<string, ModelChoice>();
  const last = new Map<ProviderId, ModelChoice>();
  return {
    conversations, last,
    get: (key: string) => conversations.get(key),
    set: (key: string, choice: ModelChoice) => { conversations.set(key, choice); },
    lastUsed: (provider: ProviderId) => last.get(provider),
    setLastUsed: (provider: ProviderId, choice: ModelChoice | null) => { if (choice) last.set(provider, choice); else last.delete(provider); },
  };
}

describe('ModelChoices', () => {
  test('fetches each catalog once and treats a failure or missing lister as empty', async () => {
    const listModels = vi.fn(async () => [opus]);
    const choices = new ModelChoices([
      { provider: 'claude', listModels },
      { provider: 'codex', listModels: async () => { throw new Error('offline'); } },
    ], memoryStore());
    expect(choices.catalog('claude')).toEqual([]);
    await choices.fetchCatalogs();
    expect(choices.catalog('claude')).toEqual([opus]);
    expect(choices.catalog('codex')).toEqual([]);
    choices.catalog('claude').pop();
    expect(choices.catalog('claude')).toEqual([opus]);
    expect(listModels).toHaveBeenCalledOnce();
    const bare = new ModelChoices([{ provider: 'claude' }], memoryStore());
    await bare.fetchCatalogs();
    expect(bare.catalog('claude')).toEqual([]);
  });

  test('resolves a saved choice before the last run, and falls back to the agent default', async () => {
    const store = memoryStore();
    const readLastRun = vi.fn(async (): Promise<ModelChoice | undefined> => ({ model: 'claude-opus-5-5', effort: 'high' }));
    const choices = new ModelChoices([{ provider: 'claude', readLastRun }, { provider: 'codex', readLastRun: async () => { throw new Error('gone'); } }], store);
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    choices.choose(claudeRef, { model: 'opus' });
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ model: 'opus' });
    expect(readLastRun).toHaveBeenCalledOnce();
    await expect(choices.resolve(codexRef)).resolves.toBeNull();
    readLastRun.mockResolvedValueOnce(undefined);
    await expect(new ModelChoices([{ provider: 'claude', readLastRun }], memoryStore()).resolve(claudeRef)).resolves.toBeNull();
  });

  test('seeds a new conversation from the last choice sent with its agent', () => {
    const store = memoryStore();
    const choices = new ModelChoices([], store);
    choices.seed(claudeRef);
    expect(store.conversations.size).toBe(0);
    store.last.set('claude', { model: 'opus', effort: 'high' });
    choices.seed(claudeRef);
    expect(store.conversations.get('claude:a')).toEqual({ model: 'opus', effort: 'high' });
  });

  test('records a send as the conversation choice and the agent last choice; a default send clears only the latter', () => {
    const store = memoryStore();
    const choices = new ModelChoices([], store);
    choices.recordSend(codexRef, { model: 'gpt-5.5', effort: 'high' });
    expect(store.conversations.get('codex:b')).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(store.last.get('codex')).toEqual({ model: 'gpt-5.5', effort: 'high' });
    choices.recordSend(codexRef, null);
    expect(store.last.has('codex')).toBe(false);
    expect(store.conversations.get('codex:b')).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });
});
