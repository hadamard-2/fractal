import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { discoverClaudeConversations, readClaudeConversation, readClaudeLastRun, watchClaudeConversation } from '@/main/harness/claude/claude-history';
import type { NativeEvent } from '@/main/harness/reconciler';

const fixtureRoot = path.join(import.meta.dirname, '__fixtures__');
const partialFixturePath = path.join(fixtureRoot, 'partial-session.jsonl');

async function collect(events: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  const result: NativeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Claude native history', () => {
  test('reads the model and effort of the last real assistant record', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-last-run-'));
    const file = path.join(directory, 'session.jsonl');
    const records = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', effort: 'low', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] as unknown[] } },
      { type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] as unknown[] } },
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] as unknown[] } },
      { type: 'user', message: { role: 'user', content: 'thanks' } },
    ];
    await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    await expect(readClaudeLastRun(file)).resolves.toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    await writeFile(file, JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [] } }));
    await expect(readClaudeLastRun(file)).resolves.toEqual({ model: 'claude-haiku-4-5-20251001' });
    await writeFile(file, `${JSON.stringify({ type: 'user', message: { content: 'only' } })}\n`);
    await expect(readClaudeLastRun(file)).resolves.toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });

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

  test('identifies a session by its file name even when its first records carry an earlier session ID', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-identity-'));
    const record = (sessionId: string, text: string) => `{"type":"user","uuid":"${sessionId}-${text}","sessionId":"${sessionId}","cwd":"/work/identity","message":{"role":"user","content":"${text}"}}\n`;
    await writeFile(path.join(directory, 'original.jsonl'), record('original', 'Start'));
    await writeFile(path.join(directory, 'continued.jsonl'), record('original', 'Start') + record('continued', 'Carry on'));

    const ids = (await discoverClaudeConversations(directory)).map((item) => item.ref.nativeSessionId);
    expect(ids.sort()).toEqual(['continued', 'original']);
    await rm(directory, { recursive: true, force: true });
  });

  test('lists a subagent transcript as a child of the session that spawned it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-subagent-'));
    const project = path.join(directory, '-work-subagent');
    await mkdir(path.join(project, 'parent', 'subagents'), { recursive: true });
    await writeFile(path.join(project, 'parent.jsonl'), '{"type":"user","uuid":"p","sessionId":"parent","cwd":"/work/subagent","message":{"role":"user","content":"Parent"}}\n');
    await writeFile(path.join(project, 'parent', 'subagents', 'agent-a1.jsonl'), '{"type":"user","uuid":"c","isSidechain":true,"agentId":"a1","sessionId":"parent","cwd":"/work/subagent","message":{"role":"user","content":"Child"}}\n');
    await writeFile(path.join(project, 'parent', 'subagents', 'agent-a1.meta.json'), '{}');

    const found = await discoverClaudeConversations(directory);
    expect(found.map((item) => ({ id: item.ref.nativeSessionId, parentId: item.summary.parentId })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'parent', parentId: undefined },
      { id: 'parent/agent-a1', parentId: 'parent' },
    ]);
    await rm(directory, { recursive: true, force: true });
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

    expect(events.filter((event) => event.nativeId === 'watch-assistant-message:text:0')).toHaveLength(2);
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

  test('marks a bounded large scan unknown rather than complete because its middle was not sampled', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-large-'));
    const filePath = path.join(directory, 'large.jsonl');
    const first = '{"type":"user","uuid":"large","sessionId":"large-session","cwd":"/work/large","timestamp":"2026-09-12T01:00:00.000Z","message":{"role":"user","content":"Large title"}}\n';
    const filler = '{"type":"assistant","uuid":"filler","message":{"role":"assistant","content":[{"type":"text","text":"' + 'x'.repeat(1024) + '"}]}}\n';
    const last = '{"type":"assistant","uuid":"large-last","sessionId":"large-session","cwd":"/work/large","timestamp":"2026-09-12T01:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Done"}]}}\n';
    await writeFile(filePath, first + filler.repeat(140) + last);

    expect((await discoverClaudeConversations(directory))[0]?.summary.captureCompleteness).toBe('unknown');
    await rm(directory, { recursive: true, force: true });
  });

  test('titles a conversation by its latest rename, then its generated name, then its first prompt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-summary-named-'));
    const user = (id: string) => `{"type":"user","uuid":"${id}-user","cwd":"/work/named","message":{"role":"user","content":"First prompt"}}\n`;
    await writeFile(path.join(directory, 'renamed.jsonl'), `${user('renamed')}{"type":"ai-title","aiTitle":"Generated"}\n{"type":"custom-title","customTitle":"Old name"}\n{"type":"custom-title","customTitle":"New name"}\n`);
    await writeFile(path.join(directory, 'generated.jsonl'), `${user('generated')}{"type":"ai-title","aiTitle":"Generated"}\n`);
    await writeFile(path.join(directory, 'plain.jsonl'), user('plain'));

    const titles = Object.fromEntries((await discoverClaudeConversations(directory)).map((item) => [item.ref.nativeSessionId, item.summary.title]));
    expect(titles).toEqual({ renamed: 'New name', generated: 'Generated', plain: 'First prompt' });
    await rm(directory, { recursive: true, force: true });
  });

  test('lowers discovery completeness for well-formed unknown sampled records', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-summary-unknown-'));
    await writeFile(path.join(directory, 'unknown.jsonl'), '{"type":"user","uuid":"unknown-user","sessionId":"unknown-session","cwd":"/work/unknown","message":{"role":"user","content":"Known title"}}\n{"type":"future_event","uuid":"future"}\n');

    expect((await discoverClaudeConversations(directory))[0]?.summary.captureCompleteness).toBe('partial');
    await rm(directory, { recursive: true, force: true });
  });

  test('lowers discovery completeness for sampled recognized records with nested unsupported activity', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-summary-nested-'));
    const user = '{"type":"user","uuid":"nested-user","sessionId":"nested-session","cwd":"/work/nested","message":{"role":"user","content":"Known title"}}\n';
    await writeFile(path.join(directory, 'assistant.jsonl'), `${user}{"type":"assistant","uuid":"nested-assistant","message":{"role":"assistant","content":[{"type":"future_block","secret":"hidden"}]}}\n`);
    await writeFile(path.join(directory, 'result.jsonl'), `${user}{"type":"result","uuid":"nested-result","subtype":"future_result"}\n`);

    expect((await discoverClaudeConversations(directory)).map((item) => item.summary.captureCompleteness)).toEqual(['partial', 'partial']);
    await rm(directory, { recursive: true, force: true });
  });

  test('stops mid-record delivery immediately when the sink disposes the watcher', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-dispose-mid-record-'));
    const filePath = path.join(directory, 'session.jsonl');
    const events: NativeEvent[] = [];
    let trigger: (() => void) | undefined;
    await writeFile(filePath, '');
    const unsubscribe = await watchClaudeConversation(filePath, (event) => {
      events.push(event);
      unsubscribe();
    }, {
      watch: ((_path, _options, listener) => {
        trigger = () => (listener as unknown as (eventType: 'change', filename: string) => void)('change', 'session.jsonl');
        return { close: (): void => undefined } as unknown as FSWatcher;
      }) as typeof import('node:fs').watch,
    });

    await writeFile(filePath, '{"type":"assistant","uuid":"two-events","message":{"role":"assistant","content":[{"type":"text","text":"First"},{"type":"image","source":"hidden"}]}}\n');
    if (!trigger) throw new Error('watcher callback was not registered');
    trigger();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rm(directory, { recursive: true, force: true });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload.kind).toBe('assistant-text');
  });

  test('closes the directory watcher when bootstrap reading fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-bootstrap-failure-'));
    const filePath = path.join(directory, 'session.jsonl');
    let closed = false;
    await writeFile(filePath, 'x');

    await expect(watchClaudeConversation(filePath, () => undefined, {
      createReadStream: (() => Readable.from((async function* () { yield await Promise.reject(new Error('bootstrap failed')); })())) as unknown as typeof import('node:fs').createReadStream,
      watch: (() => ({ close: (): void => { closed = true; } }) as unknown as FSWatcher) as typeof import('node:fs').watch,
    })).rejects.toThrow('bootstrap failed');
    expect(closed).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });
});
