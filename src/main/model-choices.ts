import type { HarnessAdapter } from '@/main/harness/types';
import type { ModelChoiceStore } from '@/main/model-choice-store';
import { conversationKey, type AgentModel, type ConversationRef, type ModelChoice, type ProviderId } from '@/shared/conversation-contract';

type ModelSource = Pick<HarnessAdapter, 'provider' | 'listModels' | 'readLastRun'>;
type ChoiceStore = Pick<ModelChoiceStore, 'get' | 'set' | 'lastUsed' | 'setLastUsed'>;

/**
 * Which model and effort each conversation runs with. Catalogs are fetched
 * once per launch; a conversation's choice is what Fractal saved for it,
 * else what its own history last ran with, else the agent's default (null).
 */
export class ModelChoices {
  private readonly sources = new Map<ProviderId, ModelSource>();
  private readonly catalogs = new Map<ProviderId, AgentModel[]>();

  constructor(sources: ModelSource[], private readonly store: ChoiceStore) {
    for (const source of sources) this.sources.set(source.provider, source);
  }

  /** A failed or missing lister leaves that agent's list empty; the picker then offers only the current choice. */
  async fetchCatalogs(): Promise<void> {
    await Promise.all([...this.sources.values()].map(async (source) => {
      try { this.catalogs.set(source.provider, await source.listModels?.() ?? []); }
      catch { this.catalogs.set(source.provider, []); }
    }));
  }

  catalog(provider: ProviderId): AgentModel[] { return structuredClone(this.catalogs.get(provider) ?? []); }

  async resolve(ref: ConversationRef): Promise<ModelChoice | null> {
    const saved = this.store.get(conversationKey(ref));
    if (saved) return saved;
    try { return await this.sources.get(ref.provider)?.readLastRun?.(ref) ?? null; }
    catch { return null; }
  }

  /** A new conversation starts from the last choice sent with its agent. */
  seed(ref: ConversationRef): void {
    const last = this.store.lastUsed(ref.provider);
    if (last) this.store.set(conversationKey(ref), last);
  }

  choose(ref: ConversationRef, choice: ModelChoice): void { this.store.set(conversationKey(ref), choice); }

  /** Only a send moves the agent's last choice, so browsing options does not change what new conversations start with. */
  recordSend(ref: ConversationRef, choice: ModelChoice | null): void {
    if (choice) this.store.set(conversationKey(ref), choice);
    this.store.setLastUsed(ref.provider, choice);
  }
}
