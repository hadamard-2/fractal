import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
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

  test('seeds the tail decoder and turn context before watching appended completion bytes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-tail-'));
    const filePath = path.join(directory, 'session.jsonl');
    const user = '{"type":"user","uuid":"old-user","message":{"id":"old-user-message","role":"user","content":"Continue"}}\n';
    const incompleteAssistant = '{"type":"assistant","uuid":"old-assistant","parentUuid":"old-user","message":{"id":"old-assistant-message","role":"assistant","content":[{"type":"tool_use","id":"old-tool","name":"Read","input":{"file_path":"a.ts"}}]}}';
    const events: NativeEvent[] = [];
    let trigger: (() => void) | undefined;

    await writeFile(filePath, user + incompleteAssistant);
    const unsubscribe = await watchClaudeConversation(filePath, (event) => events.push(event), {
      watch: ((_path, _options, listener) => {
        trigger = () => (listener as unknown as (eventType: 'change', filename: string) => void)('change', 'session.jsonl');
        return { close: (): void => undefined } as unknown as FSWatcher;
      }) as typeof import('node:fs').watch,
    });
    await appendFile(filePath, '\n');
    if (!trigger) throw new Error('watcher callback was not registered');
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    await rm(directory, { recursive: true, force: true });

    expect(events).toMatchObject([{ nativeId: 'old-tool', payload: { kind: 'action-requested', turnId: 'old-user' } }]);
  });

  test('bounds append reads to the observed stat range and retries bytes after a read failure', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-range-'));
    const filePath = path.join(directory, 'session.jsonl');
    const user = '{"type":"user","uuid":"range-user","message":{"id":"range-message","role":"user","content":"Bound it"}}\n';
    const events: NativeEvent[] = [];
    const ranges: Array<{ start?: number; end?: number }> = [];
    let trigger: (() => void) | undefined;
    let attempts = 0;

    await writeFile(filePath, '');
    const unsubscribe = await watchClaudeConversation(filePath, (event) => events.push(event), {
      createReadStream: ((_path, options?: { start?: number; end?: number }) => {
        ranges.push(options ?? {});
        attempts += 1;
        if (attempts === 1) return Readable.from((async function* () { yield await Promise.reject(new Error('transient read failure')); })());
        return Readable.from([Buffer.from(user)]);
      }) as typeof import('node:fs').createReadStream,
      watch: ((_path, _options, listener) => {
        trigger = () => (listener as unknown as (eventType: 'change', filename: string) => void)('change', 'session.jsonl');
        return { close: (): void => undefined } as unknown as FSWatcher;
      }) as typeof import('node:fs').watch,
    });
    await writeFile(filePath, user);
    if (!trigger) throw new Error('watcher callback was not registered');
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 10));
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    await rm(directory, { recursive: true, force: true });

    expect(ranges).toEqual([{ start: 0, end: Buffer.byteLength(user) - 1 }, { start: 0, end: Buffer.byteLength(user) - 1 }]);
    expect(events).toMatchObject([{ nativeId: 'range-user', payload: { kind: 'turn-started' } }]);
  });

  test('watches the parent directory and suppresses an in-flight stream after disposal', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-dispose-'));
    const filePath = path.join(directory, 'session.jsonl');
    const events: NativeEvent[] = [];
    const watchedPaths: string[] = [];
    let trigger: (() => void) | undefined;
    let release: (() => void) | undefined;

    await writeFile(filePath, '');
    const unsubscribe = await watchClaudeConversation(filePath, (event) => events.push(event), {
      createReadStream: ((streamPath) => {
        void streamPath;
        return Readable.from((async function* () {
        await new Promise<void>((resolve) => { release = resolve; });
        yield Buffer.from('{"type":"user","uuid":"late","message":{"id":"late-message","role":"user","content":"Late"}}\n');
        })());
      }) as typeof import('node:fs').createReadStream,
      watch: ((watchPath, _options, listener) => {
        watchedPaths.push(watchPath.toString());
        trigger = () => (listener as unknown as (eventType: 'change', filename: string) => void)('change', 'session.jsonl');
        return { close: (): void => undefined } as unknown as FSWatcher;
      }) as typeof import('node:fs').watch,
    });
    await writeFile(filePath, '{"type":"user","uuid":"late","message":{"id":"late-message","role":"user","content":"Late"}}\n');
    if (!trigger) throw new Error('watcher callback was not registered');
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    if (!release) throw new Error('stream did not begin');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rm(directory, { recursive: true, force: true });

    expect(watchedPaths).toEqual([directory]);
    expect(events).toEqual([]);
  });

  test('quarantines valid JSON with an invalid record shape and skips summaries without a native project path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-shape-'));
    const filePath = path.join(directory, 'session.jsonl');
    const user = '{"type":"user","uuid":"shape-user","cwd":"/work/shape","message":{"id":"shape-message","role":"user","content":[{"type":"text","text":"Array title"}]}}\n';
    await writeFile(filePath, `null\n${user}`);

    const read = readClaudeConversation(filePath);
    const events = await collect(read.events);
    await read.completion;
    expect(events.map((event) => event.nativeType)).toEqual(['invalid-record', 'user']);
    expect(events[0].payload).toMatchObject({ kind: 'unsupported', captureCompleteness: 'partial' });
    expect((await discoverClaudeConversations(directory))[0]?.summary.title).toBe('Array title');

    await writeFile(path.join(directory, 'missing-path.jsonl'), '{"type":"user","uuid":"missing","message":{"role":"user","content":"No path"}}\n');
    expect((await discoverClaudeConversations(directory)).map((item) => item.ref.nativeSessionId)).not.toContain('missing');
    await rm(directory, { recursive: true, force: true });
  });

  test('marks a healthy bounded large scan complete rather than incomplete because it was clipped', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-large-'));
    const filePath = path.join(directory, 'large.jsonl');
    const first = '{"type":"user","uuid":"large","sessionId":"large-session","cwd":"/work/large","timestamp":"2026-09-12T01:00:00.000Z","message":{"role":"user","content":"Large title"}}\n';
    const filler = '{"type":"assistant","uuid":"filler","message":{"role":"assistant","content":[{"type":"text","text":"' + 'x'.repeat(1024) + '"}]}}\n';
    const last = '{"type":"assistant","uuid":"large-last","sessionId":"large-session","cwd":"/work/large","timestamp":"2026-09-12T01:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}\n';
    await writeFile(filePath, first + filler.repeat(140) + last);

    expect((await discoverClaudeConversations(directory))[0]?.summary.captureCompleteness).toBe('complete');
    await rm(directory, { recursive: true, force: true });
  });
});
