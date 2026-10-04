import { canonicalizeProjectPath, groupConversationsByProject, type Realpath } from '@/main/harness/project-path';
import type { HarnessAdapter } from '@/main/harness/types';
import { conversationKey, type ConversationRef, type ConversationSummary, type HarnessStatus, type ProviderId } from '@/shared/conversation-contract';
import { parseConversationRef } from '@/shared/conversation-ipc';

export class ConversationRegistry {
  private readonly adapters = new Map<ProviderId, HarnessAdapter>();
  private readonly summaries = new Map<ProviderId, ConversationSummary[]>();
  private readonly statuses = new Map<ProviderId, HarnessStatus>();
  private readonly refreshing = new Map<ProviderId, Promise<void>>();

  constructor(adapters: HarnessAdapter[], private readonly realpath: Realpath) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider)) throw new Error('Duplicate conversation provider');
      this.adapters.set(adapter.provider, adapter);
    }
  }

  async list() {
    await Promise.all(Array.from(this.adapters.keys(), (provider) => this.refreshProvider(provider)));
    const projects = await groupConversationsByProject(Array.from(this.summaries.values()).flat(), async (path) => path);
    const providers = Array.from(this.adapters.keys(), (provider) => {
      const status = this.statuses.get(provider);
      if (!status) throw new Error('Conversation provider status is unavailable');
      return status;
    });
    return structuredClone({ projects, providers });
  }

  /** Whether discovery has found a conversation in this canonical project path, as of its last run. */
  hasProject(projectPath: string): boolean {
    for (const summaries of this.summaries.values()) {
      if (summaries.some((summary) => summary.ref.projectPath === projectPath)) return true;
    }
    return false;
  }

  resolve(ref: ConversationRef): HarnessAdapter {
    const parsed = parseConversationRef(ref);
    const adapter = this.adapters.get(parsed.provider);
    if (!adapter) throw new Error('Conversation provider is not registered');
    return adapter;
  }

  async create(provider: ProviderId, projectPath: string): Promise<ConversationRef> {
    await this.refreshProvider(provider);
    const adapter = this.adapters.get(provider);
    const status = this.statuses.get(provider);
    if (!adapter || status?.availability !== 'available' || !status.capabilities.create) throw new Error('Conversation creation is not available');
    const ref = parseConversationRef(await adapter.createConversation(projectPath));
    if (ref.provider !== provider || ref.projectPath !== projectPath) throw new Error('Created conversation does not match the selected provider and project');
    return structuredClone(ref);
  }

  async validate(ref: ConversationRef): Promise<ConversationSummary> {
    const parsed = parseConversationRef(ref);
    this.resolve(parsed);
    await this.refreshProvider(parsed.provider);
    const summary = this.summaries.get(parsed.provider)?.find((item) => conversationKey(item.ref) === conversationKey(parsed) && item.ref.projectPath === parsed.projectPath);
    if (!summary) throw new Error('Conversation is not currently available in this project');
    return structuredClone(summary);
  }

  refreshProvider(provider: ProviderId): Promise<void> {
    const existing = this.refreshing.get(provider);
    if (existing) return existing;
    const adapter = this.adapters.get(provider);
    if (!adapter) return Promise.reject(new Error('Conversation provider is not registered'));
    const pending = this.discover(adapter).finally(() => { this.refreshing.delete(provider); });
    this.refreshing.set(provider, pending);
    return pending;
  }

  private async discover(adapter: HarnessAdapter): Promise<void> {
    const provider = adapter.provider;
    try {
      const status = await adapter.probe();
      const summaries: ConversationSummary[] = [];
      if (status.availability === 'available') {
        for (const item of await adapter.listConversations()) {
          const ref = parseConversationRef(item.ref);
          if (ref.provider !== provider) throw new Error('Mismatched conversation provider');
          ref.projectPath = await canonicalizeProjectPath(ref.projectPath, this.realpath);
          // Cache summaries only; adapter-owned file/thread locators never cross this boundary.
          summaries.push({ ref, title: item.title, updatedAt: item.updatedAt, runtime: item.runtime, captureCompleteness: item.captureCompleteness, ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }), ...(item.parentId === undefined ? {} : { parentId: item.parentId }) });
        }
      }
      this.summaries.set(provider, summaries);
      this.statuses.set(provider, structuredClone({ ...status, provider }));
    } catch {
      this.summaries.set(provider, []);
      this.statuses.set(provider, { provider, availability: 'unavailable', capabilities: { create: false, partialStreaming: false, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false }, message: 'Conversation discovery failed for this provider.' });
    }
  }
}
