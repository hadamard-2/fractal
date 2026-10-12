import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Options, SDKUserMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test, vi } from 'vitest';
import type { NativeEvent } from '@/main/harness/reconciler';
import { runClaudeTurn, type ClaudeChildProcess, type RunClaudeTurnOptions } from './claude-runner';

const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' };

type FakeChild = ClaudeChildProcess & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; signals: NodeJS.Signals[];
  /** claude exits with `code`, or is ended by `signal`. */
  finish(code?: number | null, signal?: NodeJS.Signals | null): void;
  /** The process reports an error, as a failed launch does. */
  fail(error: Error): void;
};

/** `null` is a process that never got a pid (an `undefined` argument would take the default). */
function fakeChild(pid: number | null = 123): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  return Object.assign(emitter, {
    pid: pid ?? undefined, stdin, stdout, stderr, signals, killed: false, exitCode: null, signalCode: null,
    kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
    finish(code: number | null = 0, signal: NodeJS.Signals | null = null) { stdout.end(); stderr.end(); emitter.emit('exit', code, signal); },
    fail(error: Error) { emitter.emit('error', error); },
  }) as unknown as FakeChild;
}

interface FakeTurn {
  query: NonNullable<RunClaudeTurnOptions['query']>;
  spawnProcess: ReturnType<typeof vi.fn>;
  child: FakeChild;
  /** The options the runner gave the SDK. */
  options(): Options;
  /** Reads the next message from the prompt stream the runner gave the SDK. */
  nextMessage(): Promise<IteratorResult<SDKUserMessage>>;
  /** The SDK yields a record, as claude printed it. */
  push(record: object): void;
  /** The SDK's stream ends. */
  end(): void;
  /** The SDK's stream throws. */
  fail(error: Error): void;
  /** The stream ends and claude exits with `code`, or is ended by `signal`; see fakeTurn for how the stream reports a nonzero exit. */
  exit(code?: number | null, signal?: NodeJS.Signals | null): void;
  readonly interrupts: number;
}

/**
 * Stands in for the SDK's query(): spawns through the runner's hook the way the SDK does, then yields what the test pushes.
 * Like the real SDK, its stream ends cleanly when claude exits 0, and otherwise throws once claude's exit has been emitted:
 * "returned an error result" when the last record was an error result, else "process exited with code N" or "terminated by signal".
 */
function fakeTurn(child: FakeChild = fakeChild()): FakeTurn {
  const records: object[] = [];
  let last: { type?: unknown; is_error?: unknown } | undefined;
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  let interrupts = 0;
  let options!: Options;
  let prompt!: AsyncIterator<SDKUserMessage>;
  const poke = (): void => { wake?.(); wake = undefined; };
  child.once('exit', (code, signal) => {
    if (code === 0 && !signal) return;
    failure ??= new Error(last?.type === 'result' && last.is_error === true
      ? 'Claude Code returned an error result: [ede_diagnostic] result_type=user'
      : signal ? `Claude Code process terminated by signal ${signal}` : `Claude Code process exited with code ${code}`);
    poke();
  });
  const spawnProcess = vi.fn(() => child);
  const query: FakeTurn['query'] = (params) => {
    options = params.options;
    prompt = params.prompt[Symbol.asyncIterator]();
    // The real SDK spawns claude inside query() itself, before it returns.
    params.options.spawnClaudeCodeProcess?.({ command: 'claude-from-sdk', args: ['--from-sdk'], cwd: params.options.cwd, env: { PATH: '/usr/bin' } } as unknown as SpawnOptions);
    const stream = (async function* () {
      while (true) {
        const record = records.shift();
        if (record) { yield record; continue; }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })();
    return Object.assign(stream, { interrupt: async () => { interrupts += 1; } });
  };
  return {
    query, spawnProcess, child,
    options: () => options,
    nextMessage: () => prompt.next(),
    push: (record) => { records.push(record); last = record; poke(); },
    end: () => { ended = true; poke(); },
    fail: (error) => { failure = error; poke(); },
    exit: (code = 0, signal = null) => { ended = true; poke(); child.finish(code, signal); },
    get interrupts() { return interrupts; },
  };
}

function start(turn: FakeTurn, overrides: Partial<RunClaudeTurnOptions> = {}) {
  return runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', query: turn.query, spawnProcess: turn.spawnProcess, rereadNative: async () => [], ...overrides });
}

function recordingWatchdog() {
  const calls: unknown[][] = [];
  return {
    calls,
    watch(pid: number, signal: string) { calls.push(['watch', pid, signal]); },
    unwatch(pid: number) { calls.push(['unwatch', pid]); },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of iterable) values.push(value); return values; }

const messageStart: object = { type: 'stream_event', session_id: 'claude-session-1', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } } };
const textDelta = (text: string) => ({ type: 'stream_event', session_id: 'claude-session-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const userRecord = (uuid: string, content: string) => ({ type: 'user', uuid, message: { role: 'user', content } });

describe('runClaudeTurn', () => {
  test('gives the SDK the user\'s claude, the project and the session to resume', async () => {
    const turn = fakeTurn();
    const run = start(turn, { executable: '/usr/bin/claude' });
    turn.exit(); await run.completion;
    expect(turn.options()).toMatchObject({ pathToClaudeCodeExecutable: '/usr/bin/claude', cwd: '/work/fractal', resume: 'claude-session-1', includePartialMessages: true });
    expect(turn.options()).not.toHaveProperty('sessionId');
  });

  test('asks for Claude Code\'s own system prompt, since the SDK sends an empty one when none is given', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.exit(); await run.completion;
    expect(turn.options().systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  test.each([undefined, '0.0.1'])('leaves CLAUDE_AGENT_SDK_VERSION in Fractal\'s environment as it was (before: %s), though query() sets it', async (before) => {
    const saved = process.env.CLAUDE_AGENT_SDK_VERSION;
    const restore = (value: string | undefined): void => { if (value === undefined) delete process.env.CLAUDE_AGENT_SDK_VERSION; else process.env.CLAUDE_AGENT_SDK_VERSION = value; };
    try {
      restore(before);
      const turn = fakeTurn();
      const run = start(turn, { query: (params) => { process.env.CLAUDE_AGENT_SDK_VERSION = '9.9.9'; return turn.query(params); } });
      expect(process.env.CLAUDE_AGENT_SDK_VERSION).toBe(before);
      turn.exit(); await run.completion;
      expect(process.env.CLAUDE_AGENT_SDK_VERSION).toBe(before);
    } finally {
      restore(saved);
    }
  });

  test('passes the bare name claude through unchanged, never the SDK\'s own binary', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.exit(); await run.completion;
    expect(turn.options().pathToClaudeCodeExecutable).toBe('claude');
  });

  test('spawns exactly what the SDK asks for, in the project, with its environment, without a shell', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.exit(); await run.completion;
    expect(turn.spawnProcess).toHaveBeenCalledWith('claude-from-sdk', ['--from-sdk'], {
      cwd: '/work/fractal', env: { PATH: '/usr/bin' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  test('starts a new session under its own id', async () => {
    const turn = fakeTurn();
    const run = start(turn, { newSession: true });
    turn.exit(); await run.completion;
    expect(turn.options()).toMatchObject({ sessionId: 'claude-session-1' });
    expect(turn.options()).not.toHaveProperty('resume');
  });

  test('passes the chosen model, effort and permission mode, and leaves them to Claude when none is chosen', async () => {
    const chosen = fakeTurn();
    const first = start(chosen, { model: 'opus', effort: 'high', permissionMode: 'plan' });
    chosen.exit(); await first.completion;
    expect(chosen.options()).toMatchObject({ model: 'opus', effort: 'high', permissionMode: 'plan' });

    const unchosen = fakeTurn();
    const second = start(unchosen);
    unchosen.exit(); await second.completion;
    for (const key of ['model', 'effort', 'permissionMode']) expect(unchosen.options()).not.toHaveProperty(key);
  });

  test('hands Claude\'s permission prompts to canUseTool only when given one', async () => {
    const canUseTool = vi.fn();
    const withTool = fakeTurn();
    const first = start(withTool, { canUseTool });
    withTool.exit(); await first.completion;
    expect(withTool.options().canUseTool).toBe(canUseTool);

    const withoutTool = fakeTurn();
    const second = start(withoutTool);
    withoutTool.exit(); await second.completion;
    expect(withoutTool.options()).not.toHaveProperty('canUseTool');
  });

  test('sends the prompt as one user message carrying the turn id', async () => {
    const turn = fakeTurn();
    const run = start(turn, { prompt: { text: 'fix; $(touch /tmp/nope)' }, turnId: 'turn-1' });
    await expect(turn.nextMessage()).resolves.toEqual({ done: false, value: {
      type: 'user', uuid: 'turn-1', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'fix; $(touch /tmp/nope)' }] },
    } });
    turn.exit(); await run.completion;
  });

  test('puts image blocks after the text and drops an empty text block', async () => {
    const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
    const withText = fakeTurn();
    const first = start(withText, { prompt: { text: 'What is this?', images: [image] } });
    expect((await withText.nextMessage()).value?.message.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    withText.exit(); await first.completion;

    const imageOnly = fakeTurn();
    const second = start(imageOnly, { prompt: { text: '', images: [image] } });
    const content = (await imageOnly.nextMessage()).value?.message.content as Array<{ type: string }>;
    expect(content.map((block) => block.type)).toEqual(['image']);
    imageOnly.exit(); await second.completion;
  });

  test('keeps the prompt input open until the turn\'s result arrives', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    await turn.nextMessage();
    let closed = false;
    const after = turn.nextMessage().then((step) => { closed = step.done === true; });
    turn.push(messageStart);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    turn.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1' });
    await after;
    expect(closed).toBe(true);
    turn.exit(); await run.completion;
  });

  test('normalizes records and reconciles native history even after a nonzero exit', async () => {
    const turn = fakeTurn();
    const reconciled: NativeEvent = { provider: 'claude', nativeId: 'file-result', nativeType: 'result', observedAt: 3, payload: { kind: 'turn-finished', turnId: 'user-1', status: 'failed' } };
    const run = start(turn, { rereadNative: async () => [reconciled] });
    turn.child.stderr.write('token=secret\u0000 bad\n');
    turn.push(userRecord('user-1', 'go'));
    turn.exit(1);
    const observed: NativeEvent[] = [];
    const reading = (async () => { for await (const event of run.events) observed.push(event); })();
    await expect(reading).rejects.toThrow('Claude process exited with code 1');
    expect(observed.some((event) => event.payload.kind === 'turn-started')).toBe(true);
    expect(observed.at(-1)).toEqual(reconciled);
    await expect(run.completion).rejects.toThrow('Claude process exited with code 1');
  });

  test('interrupt asks the SDK to stop the turn, then SIGTERMs claude if it is still running two seconds later', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const interrupted = run.interrupt();
      expect(turn.interrupts).toBe(1);
      expect(turn.child.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_999); expect(turn.child.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); expect(turn.child.signals).toEqual(['SIGTERM']);
      turn.exit(); await interrupted; await run.completion;
    } finally {
      vi.useRealTimers();
    }
  });

  test('ends a stopped turn as interrupted, not failed, when claude exits nonzero after an error result and the SDK throws', async () => {
    const turn = fakeTurn();
    const rereadNative = vi.fn(async () => []);
    const run = start(turn, { rereadNative });
    const interrupted = run.interrupt();
    turn.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-session-1' });
    turn.exit(1);
    await interrupted;
    await expect(run.completion).resolves.toEqual({ exitCode: 1, signal: null, interrupted: true });
    // Once to find the turn's anchor, once for the final reconcile.
    expect(rereadNative).toHaveBeenCalledTimes(2);
  });

  test('publishes the result of a stopped turn as interrupted, not as an unsupported record', async () => {
    const turn = fakeTurn();
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'turn-1', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'turn-1', userMessageId: 'turn-1', text: 'go' } };
    const run = start(turn, { turnId: 'turn-1', rereadNative: async () => [anchor] });
    const interrupted = run.interrupt();
    turn.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-session-1' });
    turn.exit(1);
    await interrupted;
    const events = await collect(run.events);
    expect(events.map((event) => event.payload.kind)).toEqual(['turn-started', 'turn-finished']);
    expect(events.at(-1)?.payload).toMatchObject({ turnId: 'turn-1', status: 'interrupted' });
  });

  test('leaves a turn that finished before the stop took effect as completed', async () => {
    const turn = fakeTurn();
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'turn-1', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'turn-1', userMessageId: 'turn-1', text: 'go' } };
    const run = start(turn, { turnId: 'turn-1', rereadNative: async () => [anchor] });
    const interrupted = run.interrupt();
    turn.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1' });
    turn.exit();
    await interrupted;
    expect((await collect(run.events)).at(-1)?.payload).toMatchObject({ kind: 'turn-finished', status: 'completed' });
  });

  test('still fails a stopped turn that claude only ends when the runner SIGTERMs it', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const completion = run.completion.then((): undefined => undefined, (error: unknown): unknown => error);
      const interrupted = run.interrupt();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(turn.child.signals).toEqual(['SIGTERM']);
      turn.exit(null, 'SIGTERM');
      await interrupted;
      await expect(completion).resolves.toMatchObject({ message: 'Claude process terminated by SIGTERM' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps publishing records that arrive after an interrupt', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const interrupted = run.interrupt();
      turn.push(userRecord('after', 'kept'));
      turn.exit(130);
      await interrupted;
      await expect(run.completion).resolves.toMatchObject({ exitCode: 130, interrupted: true });
      expect((await collect(run.events)).map((event) => event.nativeId)).toEqual(['after']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('still fails a turn whose stream breaks after claude exited cleanly, when nobody asked it to stop', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    const events = collect(run.events);
    turn.fail(new Error('token=private-value stream broke'));
    turn.child.finish(0);
    await expect(run.completion).rejects.toThrow('token=[redacted] stream broke');
    await expect(events).rejects.toThrow('token=[redacted] stream broke');
  });

  test('stops an owned live child and settles subscribers when the stream fails before claude exits', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const completion = run.completion.then((): undefined => undefined, (error: unknown): unknown => error);
      const events = collect(run.events).then((): undefined => undefined, (error: unknown): unknown => error);
      turn.fail(new Error('secret=never-show pipe failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(turn.child.signals).toEqual(['SIGINT']);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(turn.child.signals).toEqual(['SIGINT', 'SIGTERM']);
      await expect(completion).resolves.toMatchObject({ message: 'secret=[redacted] pipe failed' });
      await expect(events).resolves.toMatchObject({ message: 'secret=[redacted] pipe failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('contains launch errors without signaling the failed child or interrupting the SDK', async () => {
    const turn = fakeTurn();
    const run = start(turn, { executable: 'missing' });
    turn.child.fail(Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }));
    turn.fail(new Error('Claude Code native binary not found at missing'));
    await expect(run.completion).rejects.toThrow('spawn missing ENOENT');
    await run.interrupt();
    expect(turn.child.signals).toEqual([]);
    expect(turn.interrupts).toBe(0);
    await expect(collect(run.events)).rejects.toThrow('spawn missing ENOENT');
  });

  test('has the watchdog interrupt claude if Fractal dies mid-turn, and withdraws that once claude exits', async () => {
    const watchdog = recordingWatchdog();
    const turn = fakeTurn();
    const run = start(turn, { watchdog });
    expect(watchdog.calls).toEqual([['watch', 123, 'SIGINT']]);
    turn.exit(); await run.completion;
    expect(watchdog.calls).toEqual([['watch', 123, 'SIGINT'], ['unwatch', 123]]);
  });

  test('withdraws the watch when the process fails after launch', async () => {
    const watchdog = recordingWatchdog();
    const turn = fakeTurn();
    const run = start(turn, { watchdog });
    turn.child.fail(new Error('pipe broke'));
    turn.fail(new Error('pipe broke'));
    await run.completion.catch((): void => undefined);
    expect(watchdog.calls).toEqual([['watch', 123, 'SIGINT'], ['unwatch', 123]]);
  });

  test('does not watch a process that never got a pid', async () => {
    const watchdog = recordingWatchdog();
    const turn = fakeTurn(fakeChild(null));
    const run = start(turn, { watchdog, executable: 'missing' });
    turn.child.fail(Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }));
    turn.fail(new Error('Claude Code native binary not found at missing'));
    await run.completion.catch((): void => undefined);
    expect(watchdog.calls).toEqual([]);
  });

  test('authoritative native reread replaces overlapping process observations', async () => {
    const turn = fakeTurn();
    const authoritative: NativeEvent = { provider: 'claude', nativeId: 'user-1', nativeType: 'user', observedAt: 9, payload: { kind: 'turn-started', turnId: 'user-1', userMessageId: 'user-1', text: 'canonical file text' } };
    const run = start(turn, { rereadNative: async () => [authoritative] });
    turn.push(userRecord('user-1', 'stream text'));
    turn.exit();
    const events = await collect(run.events);
    expect(events.filter((event) => event.nativeId === 'user-1')).toEqual([authoritative]);
  });

  test('active subscribers receive changed authoritative replacements but no identical duplicates', async () => {
    const turn = fakeTurn();
    const streamed: NativeEvent = { provider: 'claude', nativeId: 'live', nativeType: 'user', observedAt: 0, payload: { kind: 'turn-started', turnId: 'live', userMessageId: 'live', text: 'stream', createdAt: 0 } };
    const authoritative: NativeEvent = { provider: 'claude', nativeId: 'live', nativeType: 'user', observedAt: 2, payload: { kind: 'turn-started', turnId: 'live', userMessageId: 'live', text: 'file', createdAt: 0 } };
    const run = start(turn, { rereadNative: async () => [authoritative, authoritative] });
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(userRecord('live', 'stream'));
    await expect(iterator.next()).resolves.toMatchObject({ value: streamed });
    turn.exit();
    await expect(iterator.next()).resolves.toMatchObject({ value: authoritative });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('owns draining and completion when events are never consumed', async () => {
    const turn = fakeTurn();
    const rereadNative = vi.fn(async () => []);
    const run = start(turn, { rereadNative });
    turn.push(userRecord('user-1', 'go'));
    turn.exit();
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(rereadNative).toHaveBeenCalledOnce();
    expect(await collect(run.events)).toHaveLength(1);
  });

  test('publishes normalized records before claude exits', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(userRecord('live', 'live now'));
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { nativeId: 'live' } });
    turn.exit(); await run.completion; await iterator.return?.();
  });

  test('anchors on a composed prompt containing an attachments block', async () => {
    const turn = fakeTurn();
    const composed = 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>';
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'file-user', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'file-user', userMessageId: 'file-user', text: composed } };
    const run = start(turn, { prompt: { text: composed }, turnId: 'file-user', rereadNative: async () => [anchor] });
    turn.push(messageStart);
    turn.exit();
    expect(await collect(run.events)).toContainEqual(anchor);
  });

  test('anchors the live stream on the record carrying its own turn id, not an earlier turn with the same text', async () => {
    const turn = fakeTurn();
    const earlier: NativeEvent = { provider: 'claude', nativeId: 'earlier', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'earlier', userMessageId: 'earlier', text: 'continue' } };
    const mine: NativeEvent = { provider: 'claude', nativeId: 'turn-2', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'turn-2', userMessageId: 'turn-2', text: 'continue' } };
    const run = start(turn, { prompt: { text: 'continue' }, turnId: 'turn-2', rereadNative: async () => [earlier, mine] });
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(messageStart);
    turn.push(textDelta('Hi'));
    await expect(iterator.next()).resolves.toMatchObject({ value: mine });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'assistant-text', turnId: 'turn-2' } } });
    turn.exit();
    await collect({ [Symbol.asyncIterator]: () => iterator });
  });

  test('waits for the persisted user anchor before streaming partials and reconciles by message id', async () => {
    const turn = fakeTurn();
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'file-user', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'file-user', userMessageId: 'file-user', text: 'go' } };
    const final: NativeEvent = { provider: 'claude', nativeId: 'msg-1:text:0', nativeType: 'text', observedAt: 3, payload: { kind: 'assistant-text', turnId: 'file-user', blockId: 'msg-1:text:0', text: 'Hello world', final: true } };
    let available = false;
    const run = start(turn, { turnId: 'file-user', rereadNative: async () => available ? [anchor, final] : [] });
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(messageStart);
    turn.push(textDelta('Hello'));
    await new Promise<void>((resolve) => setImmediate(resolve)); available = true;
    turn.push(textDelta(' world'));
    await expect(iterator.next()).resolves.toMatchObject({ value: anchor });
    await expect(iterator.next()).resolves.toMatchObject({ value: { nativeId: 'msg-1:text:0', payload: { turnId: 'file-user', text: 'Hello world', final: false } } });
    turn.exit();
    await expect(iterator.next()).resolves.toMatchObject({ value: final });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('keeps draining and supports late replay after an iterator returns early', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.push(userRecord('one', 'one'));
    turn.push(userRecord('two', 'two'));
    turn.exit();
    for await (const event of run.events) { expect(event.nativeId).toBe('one'); break; }
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(await collect(run.events)).toHaveLength(2);
  });

  test('bounds and sanitizes stderr diagnostics', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.child.stderr.write(`token=super-secret\u0000 ${'x'.repeat(5_000)}`);
    turn.exit(1);
    await expect(run.completion).rejects.toThrow('token=[redacted]');
  });
});
