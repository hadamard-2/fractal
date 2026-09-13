import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { ClaudeAdapter } from '@/main/harness/claude/claude-adapter';
import type { NativeEvent } from '@/main/harness/reconciler';

const root = path.join(import.meta.dirname, '__fixtures__');
const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/canonical/fractal' };
const realpath = async (input: string) => input === '/work/fractal' ? '/canonical/fractal' : input;
describe('Claude read-only adapter', () => {
  test('discovers canonical summaries without leaking native file locators', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    expect((await adapter.probe()).availability).toBe('available');
    const summaries = await adapter.listConversations();
    expect(summaries.find((item) => item.ref.nativeSessionId === ref.nativeSessionId)).toMatchObject({ ref, title: 'Inspect the parser' });
    expect(JSON.stringify(summaries)).not.toContain('.jsonl');
    expect(adapter.capabilities()).toMatchObject({ create: false, approvals: false, questions: false, interrupt: false });
  });
  test('loads normalized history using a discovered locator and rejects forged refs', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    const loaded = await adapter.loadConversation(ref); const events: NativeEvent[] = [];
    for await (const event of loaded.events) events.push(event);
    expect(loaded.summary.ref).toEqual(ref);
    expect(events.some((event) => event.payload.kind === 'turn-started' && event.payload.text === 'Inspect the parser')).toBe(true);
    for (const forged of [{ ...ref, projectPath: '/wrong' }, { ...ref, nativeSessionId: '../../private' }, { ...ref, provider: 'codex' as const }]) {
      await expect(adapter.loadConversation(forged)).rejects.toThrow();
      await expect(adapter.watchConversation(forged, vi.fn())).rejects.toThrow();
    }
  });
  test('opens and releases the reviewed native watcher', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    const unsubscribe = await adapter.watchConversation(ref, vi.fn());
    expect(unsubscribe).toBeTypeOf('function'); unsubscribe(); unsubscribe();
  });
  test('reports missing history without native error details and rejects creation/continuation', async () => {
    const adapter = new ClaudeAdapter(path.join(root, 'absent-private-path'), { realpath });
    expect(await adapter.probe()).toMatchObject({ provider: 'claude', availability: 'unavailable', message: 'Claude conversation history is unavailable.' });
    await expect(adapter.createConversation('/repo')).rejects.toThrow('not available');
    await expect(adapter.continueConversation(ref, { text: 'hi' })).rejects.toThrow('not available');
  });
});
