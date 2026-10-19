import { describe, expect, test, vi } from 'vitest';
import { ConversationRegistry } from '@/main/conversation-registry';
import type { HarnessAdapter } from '@/main/harness/types';
import type { ConversationSummary, HarnessCapabilities, ProviderId } from '@/shared/conversation-contract';

const capabilities: HarnessCapabilities = { create: false, partialStreaming: true, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false };
function adapter(provider: ProviderId, projectPath = '/repo'): HarnessAdapter {
  return {
    provider, capabilities: () => capabilities,
    probe: vi.fn(async () => ({ provider, availability: 'available' as const, capabilities })),
    listConversations: vi.fn(async (): Promise<ConversationSummary[]> => [{ ref: { provider, projectPath, nativeSessionId: provider }, title: provider, updatedAt: provider === 'codex' ? 2 : 1, runtime: 'idle', captureCompleteness: 'complete' }]),
    loadConversation: vi.fn(), watchConversation: vi.fn(), createConversation: vi.fn(), continueConversation: vi.fn(),
  };
}
const realpath = async (path: string) => path === '/link' ? '/repo' : path;

describe('ConversationRegistry', () => {
  test('canonicalizes and groups both providers without retaining caller mutations', async () => {
    const registry = new ConversationRegistry([adapter('claude', '/link'), adapter('codex')], realpath);
    const result = await registry.list();
    expect(result.projects.map((group) => [group.projectPath, group.conversations.map((item) => item.ref.provider)])).toEqual([['/repo', ['codex', 'claude']]]);
    result.projects[0].conversations[0].ref.projectPath = '/forged';
    expect((await registry.validate({ provider: 'codex', projectPath: '/repo', nativeSessionId: 'codex' })).ref.projectPath).toBe('/repo');
  });

  test('keeps the parent link on a child conversation', async () => {
    const claude = adapter('claude');
    vi.mocked(claude.listConversations).mockResolvedValue([
      { ref: { provider: 'claude', projectPath: '/repo', nativeSessionId: 'parent/agent-a1' }, title: 'child', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete', parentId: 'parent' },
    ]);
    const result = await new ConversationRegistry([claude], realpath).list();
    expect(result.projects[0].conversations[0].parentId).toBe('parent');
  });

  test.each(['probe', 'listConversations'] as const)('isolates a rejected %s and clears stale provider summaries', async (method) => {
    const codex = adapter('codex');
    const registry = new ConversationRegistry([codex, adapter('claude')], realpath);
    await registry.list();
    vi.mocked(codex[method]).mockRejectedValue(new Error('/private/token secret'));
    const result = await registry.list();
    expect(result.projects[0].conversations.map((item) => item.ref.provider)).toEqual(['claude']);
    expect(result.providers.find((item) => item.provider === 'codex')?.availability).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret');
    await expect(registry.validate({ provider: 'codex', nativeSessionId: 'codex', projectPath: '/repo' })).rejects.toThrow();
  });

  test('preserves unsupported status and does not discover an unavailable provider', async () => {
    const codex = adapter('codex');
    vi.mocked(codex.probe).mockResolvedValue({ provider: 'codex', availability: 'unsupported', version: '1', capabilities });
    const result = await new ConversationRegistry([codex, adapter('claude')], realpath).list();
    expect(result.providers[0]).toMatchObject({ availability: 'unsupported', version: '1' });
    expect(codex.listConversations).not.toHaveBeenCalled();
  });

  test('requires the currently discovered provider/session/canonical project tuple', async () => {
    const codex = adapter('codex');
    const registry = new ConversationRegistry([codex], realpath);
    const ref = { provider: 'codex' as const, nativeSessionId: 'codex', projectPath: '/repo' };
    expect(registry.resolve(ref)).toBe(codex);
    await expect(registry.validate({ ...ref, projectPath: '/elsewhere' })).rejects.toThrow();
    await expect(registry.validate({ ...ref, nativeSessionId: 'forged' })).rejects.toThrow();
    await expect(registry.validate({ ...ref, projectPath: '/link' })).rejects.toThrow();
    expect((await registry.validate(ref)).title).toBe('codex');
    vi.mocked(codex.listConversations).mockResolvedValue([]);
    await registry.refreshProvider('codex');
    await expect(registry.validate(ref)).rejects.toThrow();
    expect(() => registry.resolve({ ...ref, provider: 'claude' })).toThrow();
  });

  describe('lookup', () => {
    const ref = { provider: 'codex' as const, nativeSessionId: 'codex', projectPath: '/repo' };

    test('returns a copy of the summary the listing has', async () => {
      const registry = new ConversationRegistry([adapter('codex')], realpath);
      const found = await registry.lookup(ref);
      expect(found?.title).toBe('codex');
      if (found) found.title = 'forged';
      expect((await registry.lookup(ref))?.title).toBe('codex');
    });

    test('returns null when a working listing does not have the conversation', async () => {
      const codex = adapter('codex');
      const registry = new ConversationRegistry([codex], realpath);
      await expect(registry.lookup({ ...ref, nativeSessionId: 'gone' })).resolves.toBeNull();
      vi.mocked(codex.listConversations).mockResolvedValue([]);
      await expect(registry.lookup(ref)).resolves.toBeNull();
    });

    test('throws when the conversation is listed under another project', async () => {
      const registry = new ConversationRegistry([adapter('codex')], realpath);
      await expect(registry.lookup({ ...ref, projectPath: '/elsewhere' })).rejects.toThrow('Conversation is not currently available in this project');
    });

    test.each(['probe', 'listConversations'] as const)('throws when the provider cannot list because %s fails', async (method) => {
      const codex = adapter('codex');
      vi.mocked(codex[method]).mockRejectedValue(new Error('boom'));
      await expect(new ConversationRegistry([codex], realpath).lookup(ref)).rejects.toThrow('Conversation provider is not available');
    });

    test('throws when the provider reports itself unavailable, or is not registered', async () => {
      const codex = adapter('codex');
      vi.mocked(codex.probe).mockResolvedValue({ provider: 'codex', availability: 'unavailable', capabilities, message: 'not installed' });
      await expect(new ConversationRegistry([codex], realpath).lookup(ref)).rejects.toThrow('Conversation provider is not available');
      await expect(new ConversationRegistry([], realpath).lookup(ref)).rejects.toThrow('Conversation provider is not registered');
    });
  });

  test('knows a project only once discovery has found a conversation in it', async () => {
    const registry = new ConversationRegistry([adapter('codex')], realpath);
    expect(registry.hasProject('/repo')).toBe(false);
    await registry.list();
    expect(registry.hasProject('/repo')).toBe(true);
    expect(registry.hasProject('/elsewhere')).toBe(false);
  });

  describe('fork', () => {
    const source = { provider: 'codex' as const, nativeSessionId: 'codex', projectPath: '/repo' };
    const forkCapabilities = { ...capabilities, fork: true };
    function forking(forked = { ...source, nativeSessionId: 'forked' }, fork = true) {
      const codex = adapter('codex');
      vi.mocked(codex.probe).mockResolvedValue({ provider: 'codex', availability: 'available', capabilities: fork ? forkCapabilities : capabilities });
      codex.forkConversation = vi.fn(async () => forked);
      return codex;
    }

    test('forks through the adapter and refreshes discovery', async () => {
      const codex = forking();
      const registry = new ConversationRegistry([codex], realpath);
      const options = { readOnly: true, note: 'note', title: 'Title' };
      await expect(registry.fork(source, 't1', options)).resolves.toEqual({ ...source, nativeSessionId: 'forked' });
      expect(codex.forkConversation).toHaveBeenCalledWith(source, 't1', options);
      expect(codex.listConversations).toHaveBeenCalledTimes(2);
    });

    test('refuses when the agent cannot fork', async () => {
      const codex = forking(undefined, false);
      await expect(new ConversationRegistry([codex], realpath).fork(source, 't1', { readOnly: false, title: 'T' })).rejects.toThrow('Conversation forking is not available');
      expect(codex.forkConversation).not.toHaveBeenCalled();
    });

    test('refuses a fork that lands in another project', async () => {
      const codex = forking({ ...source, nativeSessionId: 'forked', projectPath: '/elsewhere' });
      await expect(new ConversationRegistry([codex], realpath).fork(source, 't1', { readOnly: false, title: 'T' })).rejects.toThrow('does not match');
    });
  });

  describe('delete', () => {
    const source = { provider: 'codex' as const, nativeSessionId: 'codex', projectPath: '/repo' };

    test('deletes through the adapter and refreshes discovery', async () => {
      const codex = adapter('codex');
      codex.deleteConversation = vi.fn(async () => undefined);
      const registry = new ConversationRegistry([codex], realpath);
      await registry.delete(source);
      expect(codex.deleteConversation).toHaveBeenCalledWith(source);
      expect(codex.listConversations).toHaveBeenCalledTimes(1);
    });

    test('refuses when the agent cannot delete', async () => {
      const codex = adapter('codex');
      await expect(new ConversationRegistry([codex], realpath).delete(source)).rejects.toThrow('Conversation deletion is not available');
      expect(codex.listConversations).not.toHaveBeenCalled();
    });

    test('does not refresh when the delete fails', async () => {
      const codex = adapter('codex');
      codex.deleteConversation = vi.fn(async () => { throw new Error('refused'); });
      await expect(new ConversationRegistry([codex], realpath).delete(source)).rejects.toThrow('refused');
      expect(codex.listConversations).not.toHaveBeenCalled();
    });
  });
});
