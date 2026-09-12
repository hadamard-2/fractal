import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { discoverClaudeConversations, readClaudeConversation, watchClaudeConversation } from '@/main/harness/claude/claude-history';
import type { NativeEvent } from '@/main/harness/reconciler';

const fixtureRoot = path.join(import.meta.dirname, '__fixtures__');
const partialFixturePath = path.join(fixtureRoot, 'partial-and-unknown.jsonl');

async function collect(events: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  const result: NativeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Claude native history', () => {
  test('discovers bounded summaries without loading full transcripts', async () => {
    const result = await discoverClaudeConversations(fixtureRoot);

    expect(result.find((item) => item.ref.nativeSessionId === 'claude-session-1')).toMatchObject({
      ref: { provider: 'claude', nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' },
      summary: {
        title: 'Inspect the parser',
        createdAt: Date.parse('2026-09-12T01:00:00.000Z'),
        updatedAt: Date.parse('2026-09-12T01:00:05.000Z'),
        captureCompleteness: 'complete',
      },
    });
    expect(result.map((item) => item.summary.updatedAt)).toEqual([...result.map((item) => item.summary.updatedAt)].sort((a, b) => b - a));
  });

  test('streams valid UTF-8 records, continues after malformed lines, and marks a truncated tail partial', async () => {
    const result = readClaudeConversation(partialFixturePath);
    const events = await collect(result.events);
    const completion = await result.completion;

    expect(events.some((event) => event.payload.kind === 'assistant-text' && event.payload.text === 'café')).toBe(true);
    expect(events.filter((event) => event.payload.kind === 'unsupported').map((event) => event.nativeType)).toEqual([
      'malformed-json',
      'future_event',
    ]);
    expect(completion).toEqual({ incompleteTail: true, captureCompleteness: 'partial' });
  });

  test('replays a replacement after truncation with the same stable native IDs for reconciler deduplication', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-history-'));
    const filePath = path.join(directory, 'session.jsonl');
    const user = '{"type":"user","uuid":"watch-user","message":{"id":"watch-message","role":"user","content":"Watch this"}}\n';
    const assistant = '{"type":"assistant","uuid":"watch-assistant","parentUuid":"watch-user","message":{"id":"watch-assistant-message","role":"assistant","content":[{"type":"text","text":"Observed"}]}}\n';
    const events: NativeEvent[] = [];
    let trigger: (() => void) | undefined;
    const watcher = { close: (): void => undefined } as unknown as FSWatcher;
    const flushWatch = () => new Promise((resolve) => setTimeout(resolve, 10));
    const triggerWatch = (): void => {
      if (!trigger) throw new Error('watcher callback was not registered');
      trigger();
    };

    await writeFile(filePath, user);
    const unsubscribe = await watchClaudeConversation(filePath, (event) => events.push(event), {
      watch: ((_path, _options, listener) => {
        trigger = () => (listener as unknown as (eventType: 'change', filename: string) => void)('change', 'session.jsonl');
        return watcher;
      }) as typeof import('node:fs').watch,
    });
    await appendFile(filePath, assistant);
    triggerWatch();
    await flushWatch();
    await writeFile(filePath, user);
    triggerWatch();
    await flushWatch();
    await appendFile(filePath, assistant);
    triggerWatch();
    await flushWatch();
    unsubscribe();
    await rm(directory, { recursive: true, force: true });

    expect(events.filter((event) => event.nativeId === 'watch-assistant:text:0')).toHaveLength(2);
    expect(events.filter((event) => event.nativeId === 'watch-user')).toHaveLength(1);
  });
});
