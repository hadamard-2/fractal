import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import type { NativeEvent } from '@/main/harness/reconciler';
import { runClaudeTurn, type ClaudeChildProcess } from './claude-runner';

const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' };
const bridge = { configPath: '/tmp/bridge.json', toolName: 'fractal_permission' };

function fakeProcess(): ClaudeChildProcess & { stdout: PassThrough; stderr: PassThrough; finish(code?: number): void; fail(error: Error): void; signals: NodeJS.Signals[] } {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  return Object.assign(emitter, {
    stdout, stderr, signals, pid: 123,
    kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
    finish(code = 0) { stdout.end(); stderr.end(); emitter.emit('close', code, null); },
    fail(error: Error) { stdout.destroy(); stderr.destroy(); emitter.emit('error', error); },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of iterable) values.push(value); return values; }

describe('runClaudeTurn', () => {
  test('spawns resume as an exact argument array without a shell', async () => {
    const child = fakeProcess();
    const spawnProcess = vi.fn(() => child);
    const run = runClaudeTurn({ ref, prompt: { text: 'fix; $(touch /tmp/nope)' }, executable: '/usr/bin/claude', spawnProcess, permissionBridge: bridge, rereadNative: async () => [] });
    child.finish(); await collect(run.events);
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/claude', [
      '--resume', 'claude-session-1', '--print', 'fix; $(touch /tmp/nope)', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--mcp-config', '/tmp/bridge.json', '--permission-prompt-tool', 'fractal_permission',
    ], { cwd: '/work/fractal', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  test('uses session-id for the first turn', async () => {
    const child = fakeProcess(); const spawnProcess = vi.fn(() => child);
    const run = runClaudeTurn({ ref, prompt: { text: 'begin' }, executable: 'claude', spawnProcess, permissionBridge: bridge, newSession: true, rereadNative: async () => [] });
    child.finish(); await collect(run.events);
    const call = spawnProcess.mock.calls[0] as unknown as [string, string[]];
    expect(call[1].slice(0, 2)).toEqual(['--session-id', 'claude-session-1']);
  });

  test('normalizes parsable stdout and reconciles native history even after a nonzero exit', async () => {
    const child = fakeProcess();
    const reconciled: NativeEvent = { provider: 'claude', nativeId: 'file-result', nativeType: 'result', observedAt: 3, payload: { kind: 'turn-finished', turnId: 'user-1', status: 'failed' } };
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [reconciled] });
    child.stderr.write('token=secret\u0000 bad\n');
    child.stdout.write('{"type":"user","uuid":"user-1","message":{"role":"user","content":"go"}}\n');
    child.finish(1);
    const observed: NativeEvent[] = [];
    const reading = (async () => { for await (const event of run.events) observed.push(event); })();
    await expect(reading).rejects.toThrow('Claude process exited with code 1');
    expect(observed.some((event) => event.payload.kind === 'turn-started')).toBe(true);
    expect(observed.at(-1)).toEqual(reconciled);
    await expect(run.completion).rejects.toThrow('Claude process exited with code 1');
  });

  test('interrupt signals only its owned child with SIGINT then SIGTERM after two seconds', async () => {
    vi.useFakeTimers();
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    const interrupted = run.interrupt();
    expect(child.signals).toEqual(['SIGINT']);
    await vi.advanceTimersByTimeAsync(1_999); expect(child.signals).toEqual(['SIGINT']);
    await vi.advanceTimersByTimeAsync(1); expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    child.finish(); await interrupted; await collect(run.events);
    vi.useRealTimers();
  });

  test('authoritative native reread replaces overlapping process observations', async () => {
    const child = fakeProcess();
    const authoritative: NativeEvent = { provider: 'claude', nativeId: 'user-1', nativeType: 'user', observedAt: 9, payload: { kind: 'turn-started', turnId: 'user-1', userMessageId: 'user-1', text: 'canonical file text' } };
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [authoritative] });
    child.stdout.write('{"type":"user","uuid":"user-1","message":{"role":"user","content":"stream text"}}\n'); child.finish();
    const events = await collect(run.events);
    expect(events.filter((event) => event.nativeId === 'user-1')).toEqual([authoritative]);
  });

  test('active subscribers receive changed authoritative replacements but no identical duplicates', async () => {
    const child = fakeProcess();
    const streamed: NativeEvent = { provider: 'claude', nativeId: 'live', nativeType: 'user', observedAt: 0, payload: { kind: 'turn-started', turnId: 'live', userMessageId: 'live', text: 'stream', createdAt: 0 } };
    const authoritative: NativeEvent = { provider: 'claude', nativeId: 'live', nativeType: 'user', observedAt: 2, payload: { kind: 'turn-started', turnId: 'live', userMessageId: 'live', text: 'file', createdAt: 0 } };
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [authoritative, authoritative] });
    const iterator = run.events[Symbol.asyncIterator]();
    child.stdout.write('{"type":"user","uuid":"live","message":{"role":"user","content":"stream"}}\n');
    await expect(iterator.next()).resolves.toMatchObject({ value: streamed });
    child.finish();
    await expect(iterator.next()).resolves.toMatchObject({ value: authoritative });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('owns draining and completion when events are never consumed', async () => {
    const child = fakeProcess(); const rereadNative = vi.fn(async () => []);
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative });
    child.stdout.write('{"type":"user","uuid":"user-1","message":{"role":"user","content":"go"}}\n'); child.finish();
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(rereadNative).toHaveBeenCalledOnce();
    expect(await collect(run.events)).toHaveLength(1);
  });

  test('publishes normalized stdout before the child exits', async () => {
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    const iterator = run.events[Symbol.asyncIterator]();
    child.stdout.write('{"type":"user","uuid":"live","message":{"role":"user","content":"live now"}}\n');
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { nativeId: 'live' } });
    child.finish(); await run.completion; await iterator.return?.();
  });

  test('waits for the persisted user anchor before streaming partials and reconciles by message id', async () => {
    const child = fakeProcess();
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'file-user', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'file-user', userMessageId: 'file-user', text: 'go' } };
    const final: NativeEvent = { provider: 'claude', nativeId: 'msg-1:text:0', nativeType: 'text', observedAt: 3, payload: { kind: 'assistant-text', turnId: 'file-user', blockId: 'msg-1:text:0', text: 'Hello world', final: true } };
    let available = false;
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, rereadNative: async () => available ? [anchor, final] : [] });
    const iterator = run.events[Symbol.asyncIterator]();
    child.stdout.write('{"type":"stream_event","session_id":"claude-session-1","parent_tool_use_id":null,"event":{"type":"message_start","message":{"id":"msg-1","role":"assistant","content":[]}}}\n');
    child.stdout.write('{"type":"stream_event","session_id":"claude-session-1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}\n');
    await new Promise<void>((resolve) => setImmediate(resolve)); available = true;
    child.stdout.write('{"type":"stream_event","session_id":"claude-session-1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}}\n');
    await expect(iterator.next()).resolves.toMatchObject({ value: anchor });
    await expect(iterator.next()).resolves.toMatchObject({ value: { nativeId: 'msg-1:text:0', payload: { turnId: 'file-user', text: 'Hello world', final: false } } });
    child.finish();
    await expect(iterator.next()).resolves.toMatchObject({ value: final });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('keeps draining and supports late replay after an iterator returns early', async () => {
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    child.stdout.write('{"type":"user","uuid":"one","message":{"role":"user","content":"one"}}\n');
    child.stdout.write('{"type":"user","uuid":"two","message":{"role":"user","content":"two"}}\n'); child.finish();
    for await (const event of run.events) { expect(event.nativeId).toBe('one'); break; }
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(await collect(run.events)).toHaveLength(2);
  });

  test('contains launch errors without waiting for close or signaling the failed child', async () => {
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'missing', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    child.fail(Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }));
    await expect(run.completion).rejects.toThrow('spawn missing ENOENT');
    await run.interrupt(); expect(child.signals).toEqual([]);
    await expect(collect(run.events)).rejects.toThrow('spawn missing ENOENT');
  });

  test('surfaces a sanitized post-launch stdout failure to completion and subscribers', async () => {
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    const events = collect(run.events);
    child.stdout.destroy(new Error('token=private-value stream broke')); child.finish(1);
    await expect(run.completion).rejects.toThrow('token=[redacted] stream broke');
    await expect(events).rejects.toThrow('token=[redacted] stream broke');
  });

  test('terminates an owned live child and settles subscribers when a pipe fails before exit', async () => {
    vi.useFakeTimers();
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    const completion = run.completion.then((): undefined => undefined, (error: unknown): unknown => error);
    const events = collect(run.events).then((): undefined => undefined, (error: unknown): unknown => error);
    child.stdout.destroy(new Error('secret=never-show pipe failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(child.signals).toEqual(['SIGINT']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    await expect(completion).resolves.toMatchObject({ message: 'secret=[redacted] pipe failed' });
    await expect(events).resolves.toMatchObject({ message: 'secret=[redacted] pipe failed' });
    vi.useRealTimers();
  });

  test('drains parsable records after interrupt and ignores malformed or partial NDJSON', async () => {
    vi.useFakeTimers(); const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    const interrupted = run.interrupt();
    child.stdout.write('not-json\n');
    child.stdout.write('{"type":"user","uuid":"after","message":{"role":"user","content":"kept"}}\n');
    child.stdout.write('{"partial":'); child.finish(130);
    await interrupted;
    const observed: NativeEvent[] = [];
    await expect((async () => { for await (const event of run.events) observed.push(event); })()).rejects.toThrow('Claude process exited with code 130');
    expect(observed.map((event) => event.nativeId)).toEqual(['after']);
    vi.useRealTimers();
  });

  test('bounds and sanitizes stderr diagnostics', async () => {
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    child.stderr.write(`token=super-secret\u0000 ${'x'.repeat(5_000)}`); child.finish(1);
    await expect(run.completion).rejects.toThrow('token=[redacted]');
  });
});
