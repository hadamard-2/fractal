import path from 'node:path';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test, vi } from 'vitest';
import { ClaudeAdapter, CLAUDE_READ_ONLY_TOOLS } from '@/main/harness/claude/claude-adapter';
import type { NativeEvent } from '@/main/harness/reconciler';
import type { HarnessStatus } from '@/shared/conversation-contract';
import type { ClaudeTurnRun, RunClaudeTurnOptions } from './claude-runner';
import { ClaudeOwnedProcessRegistry } from './claude-owned-process-registry';

const root = path.join(import.meta.dirname, '__fixtures__');
const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/canonical/fractal' };
const realpath = async (input: string) => input === '/work/fractal' ? '/canonical/fractal' : input;
const available: HarnessStatus = {
  provider: 'claude', availability: 'available',
  capabilities: { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false },
};

/** What the SDK passes canUseTool for one tool call. */
function toolCall(toolUseID: string, signal: AbortSignal = new AbortController().signal): Parameters<CanUseTool>[2] {
  return { signal, toolUseID, requestId: `request-${toolUseID}` };
}

/** A runner whose events stay open until `finish()`; it records the options each turn was given. */
function heldRunner() {
  let finish!: () => void;
  const runTurn = vi.fn<(options: RunClaudeTurnOptions) => ClaudeTurnRun>(() => ({
    events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
    completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined),
  }));
  return { runTurn, finish: () => finish(), canUseTool: () => { const tool = runTurn.mock.calls[0][0].canUseTool; if (!tool) throw new Error('no canUseTool'); return tool; } };
}

describe('Claude adapter', () => {
  test('discovers canonical summaries without leaking native file locators', async () => {
    const adapter = new ClaudeAdapter(root, { realpath });
    expect((await adapter.probe()).availability).toBe('available');
    const summaries = await adapter.listConversations();
    expect(summaries.find((item) => item.ref.nativeSessionId === ref.nativeSessionId)).toMatchObject({ ref, title: 'Inspect the parser' });
    expect(JSON.stringify(summaries)).not.toContain('.jsonl');
    expect(adapter.capabilities()).toMatchObject({ create: false, approvals: false, questions: false, interrupt: false });
  });
  test('hands the prompt model choice to the runner', async () => {
    const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Go', model: 'opus', effort: 'high' });
    expect(runTurn.mock.calls[0][0]).toMatchObject({ model: 'opus', effort: 'high' });
    await run.dispose();
  });

  test('hands its watchdog to every turn', async () => {
    const watchdog = { watch: vi.fn(), unwatch: vi.fn() };
    const runTurn = vi.fn<(options: RunClaudeTurnOptions) => ClaudeTurnRun>(() => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn, watchdog });
    const run = await adapter.continueConversation(ref, { text: 'Go' });
    expect(runTurn.mock.calls[0][0].watchdog).toBe(watchdog);
    await run.dispose();
  });

  test('hands the prompt access to the runner as a permission mode', async () => {
    const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Go', access: { state: { kind: 'level', level: 'auto' }, picked: false } });
    expect(runTurn.mock.calls[0][0]).toMatchObject({ permissionMode: 'auto' });
    await run.dispose();
  });

  describe('forks and side chats', () => {
    const idleRun = () => vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const forkable: HarnessStatus = { ...available, capabilities: { ...available.capabilities, fork: true } };
    const bypass = { state: { kind: 'level' as const, level: 'bypassPermissions' }, picked: true };
    const READ_ONLY_OPTIONS = { tools: [...CLAUDE_READ_ONLY_TOOLS], disallowedTools: ['mcp__*'], mcpServers: {}, strictMcpConfig: true, permissionPrompts: 'none' };
    const quiet = { ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } };

    test('forks the session at the end of the turn and returns the new session', async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-fork-'));
      try {
        const project = path.join(directory, 'project'); await mkdir(project);
        const records = [
          { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'claude-session-1', cwd: '/canonical/fractal', message: { role: 'user', content: 'first' } },
          { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'claude-session-1', cwd: '/canonical/fractal', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
          { type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'claude-session-1', cwd: '/canonical/fractal', message: { role: 'user', content: 'second' } },
        ];
        await writeFile(path.join(project, 'claude-session-1.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
        const forkSession = vi.fn(async () => ({ sessionId: 'forked-session' }));
        const adapter = new ClaudeAdapter(directory, { realpath, probe: async () => forkable, forkSession });
        await adapter.probe();
        const forked = await adapter.forkConversation(ref, 'u1', { readOnly: true, note: 'n', title: 'T (side chat)' });
        expect(forkSession).toHaveBeenCalledWith('claude-session-1', { dir: '/canonical/fractal', upToMessageId: 'a1', title: 'T (side chat)' });
        expect(forked).toEqual({ provider: 'claude', nativeSessionId: 'forked-session', projectPath: '/canonical/fractal' });
      } finally { await rm(directory, { recursive: true, force: true }); }
    });

    test('refuses to fork when the capability is missing', async () => {
      const forkSession = vi.fn(async () => ({ sessionId: 'forked-session' }));
      const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, forkSession });
      await adapter.probe();
      await expect(adapter.forkConversation(ref, 'user-1', { readOnly: false, title: 'T' })).rejects.toThrow('Claude conversation forking is not available');
      expect(forkSession).not.toHaveBeenCalled();
    });

    test('runs a side chat with only read tools, no MCP, no prompts and no permission mode, whatever access was picked', async () => {
      const runTurn = idleRun();
      const adapter = new ClaudeAdapter(root, { realpath, probe: async () => quiet, runtime: async () => 'idle', runTurn });
      const run = await adapter.continueConversation(ref, { text: 'Go', access: bypass, branch: { readOnly: true, note: 'n' } });
      const options = runTurn.mock.calls[0][0];
      expect(options).toMatchObject({ ...READ_ONLY_OPTIONS, appendSystemPrompt: 'n' });
      expect(options).not.toHaveProperty('permissionMode');
      expect(options).not.toHaveProperty('canUseTool');
      await run.dispose();
    });

    test('keeps a side chat read-only even with approvals available and no branch on the prompt', async () => {
      const runTurn = idleRun();
      const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, isReadOnlySession: (id) => id === ref.nativeSessionId });
      const run = await adapter.continueConversation(ref, { text: 'Go', access: bypass });
      const options = runTurn.mock.calls[0][0];
      expect(options).toMatchObject(READ_ONLY_OPTIONS);
      expect(options).not.toHaveProperty('permissionMode');
      expect(options).not.toHaveProperty('canUseTool');
      expect(options).not.toHaveProperty('appendSystemPrompt');
      await run.dispose();
    });

    test('a fork keeps its normal access and permissions and only gains the note', async () => {
      const runTurn = idleRun();
      const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn });
      const run = await adapter.continueConversation(ref, { text: 'Go', access: bypass, branch: { readOnly: false, note: 'n' } });
      const options = runTurn.mock.calls[0][0];
      expect(options).toMatchObject({ permissionMode: 'bypassPermissions', appendSystemPrompt: 'n' });
      expect(options.canUseTool).toBeTypeOf('function');
      for (const key of ['tools', 'disallowedTools', 'permissionPrompts', 'mcpServers', 'strictMcpConfig']) expect(options).not.toHaveProperty(key);
      await run.dispose();
    });
  });

  test('reads the recorded access back from the transcript', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-access-'));
    const source = await readFile(path.join(root, 'claude-session-1.jsonl'), 'utf8');
    const file = path.join(directory, 'claude-session-1.jsonl');
    const adapter = new ClaudeAdapter(directory, { realpath });
    await writeFile(file, source);
    await expect(adapter.readAccess(ref)).resolves.toBeUndefined();
    const turn = { type: 'user', permissionMode: 'bypassPermissions', sessionId: 'claude-session-1', cwd: '/work/fractal', uuid: 'user-last', parentUuid: null as string | null, timestamp: '2026-09-30T00:00:00.000Z', message: { role: 'user', content: 'Go' } };
    await writeFile(file, `${source.trimEnd()}\n${JSON.stringify(turn)}\n`);
    await expect(adapter.readAccess(ref)).resolves.toEqual({ kind: 'level', level: 'bypassPermissions' });
    await writeFile(file, `${source.trimEnd()}\n${JSON.stringify({ ...turn, permissionMode: '--weird mode' })}\n`);
    await expect(adapter.readAccess(ref)).resolves.toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });

  test('lists models through its catalog dependency and reads the last run from the transcript', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-models-'));
    const source = await readFile(path.join(root, 'claude-session-1.jsonl'), 'utf8');
    const last = { type: 'assistant', sessionId: 'claude-session-1', cwd: '/work/fractal', uuid: 'assistant-last', parentUuid: null as string | null, timestamp: '2026-09-30T00:00:00.000Z', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done' }] } };
    await writeFile(path.join(directory, 'claude-session-1.jsonl'), `${source.trimEnd()}\n${JSON.stringify(last)}\n`);
    const models = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
    const adapter = new ClaudeAdapter(directory, { realpath, listModels: async () => models });
    await expect(adapter.listModels()).resolves.toEqual(models);
    await expect(adapter.readLastRun(ref)).resolves.toEqual({ model: 'claude-opus-5', effort: 'high' });
    await rm(directory, { recursive: true, force: true });
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

  test('reports probed approval and question capabilities independently', async () => {
    const probe = vi.fn(async () => ({ ...available, capabilities: { ...available.capabilities, questions: false } }));
    const adapter = new ClaudeAdapter(root, { realpath, probe });
    expect(await adapter.probe()).toMatchObject({ capabilities: { approvals: true, questions: false } });
    expect(adapter.capabilities()).toMatchObject({ approvals: true, questions: false });
  });

  test('renames by appending a custom-title record, and refuses a file mid-write or a subagent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-adapter-rename-'));
    const file = path.join(directory, 'project', 'session-1.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"type":"user","uuid":"a","sessionId":"session-1","cwd":"/work/fractal","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"Original"}}\n');
    await mkdir(path.join(directory, 'project', 'session-1', 'subagents'), { recursive: true });
    await writeFile(path.join(directory, 'project', 'session-1', 'subagents', 'agent-a1.jsonl'), '{"type":"user","uuid":"c","isSidechain":true,"sessionId":"session-1","cwd":"/work/fractal","message":{"role":"user","content":"Child"}}\n');
    const adapter = new ClaudeAdapter(directory, { realpath });
    const session = { ...ref, nativeSessionId: 'session-1' };

    await adapter.renameConversation(session, 'Renamed chat');
    expect((await readFile(file, 'utf8')).trimEnd().split('\n').at(-1)).toBe('{"type":"custom-title","customTitle":"Renamed chat","sessionId":"session-1"}');
    // The untimestamped rename record must not count as activity.
    expect((await adapter.listConversations()).find((item) => item.ref.nativeSessionId === 'session-1')).toMatchObject({ title: 'Renamed chat', updatedAt: Date.parse('2026-09-01T10:00:00.000Z') });

    await appendFile(file, '{"type":"assistant","partial":');
    await expect(adapter.renameConversation(session, 'Again')).rejects.toThrow('being written');
    await expect(adapter.renameConversation({ ...ref, nativeSessionId: 'session-1/agent-a1' }, 'Child')).rejects.toThrow('Subagent conversations are read-only');
    await rm(directory, { recursive: true, force: true });
  });

  test('loads a subagent transcript but refuses to continue it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-adapter-subagent-'));
    await mkdir(path.join(directory, 'project', 'parent', 'subagents'), { recursive: true });
    await writeFile(path.join(directory, 'project', 'parent', 'subagents', 'agent-a1.jsonl'), '{"type":"user","uuid":"c","isSidechain":true,"sessionId":"parent","cwd":"/work/fractal","message":{"role":"user","content":"Child"}}\n');
    const runTurn = vi.fn();
    const adapter = new ClaudeAdapter(directory, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn });
    const child = { ...ref, nativeSessionId: 'parent/agent-a1' };
    expect((await adapter.loadConversation(child)).summary.parentId).toBe('parent');
    await expect(adapter.continueConversation(child, { text: 'continue' })).rejects.toThrow('Subagent conversations are read-only');
    expect(runTurn).not.toHaveBeenCalled();
    await rm(directory, { recursive: true, force: true });
  });

  test.each(['active-externally', 'unknown'] as const)('refuses continuation when runtime is %s', async (runtime) => {
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => runtime });
    await expect(adapter.continueConversation(ref, { text: 'continue' })).rejects.toThrow('Conversation is not idle');
  });

  test('routes each permission prompt exactly once and keeps resolved decisions in the event stream', async () => {
    const held = heldRunner();
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn: held.runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    const iterator = run.events[Symbol.asyncIterator]();
    const opened = iterator.next();
    const decision = held.canUseTool()('Bash', { command: 'pnpm test' }, toolCall('approval-1'));
    await expect(opened).resolves.toMatchObject({ value: { payload: { kind: 'request-opened' } } });
    await run.resolveRequest('approval-1', { kind: 'allow-once' });
    await expect(decision).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pnpm test' } });
    await expect(run.resolveRequest('approval-1', { kind: 'deny' })).rejects.toThrow('no longer available');
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-resolved' } } });
    held.finish(); await run.dispose();
  });

  test('gives the runner no canUseTool when the probe offers neither approvals nor questions', async () => {
    const held = heldRunner();
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn: held.runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    expect(held.runTurn.mock.calls[0][0]).not.toHaveProperty('canUseTool');
    held.finish(); await run.dispose();
  });

  test('composes the attachment block and reads images into the runner prompt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-attach-'));
    const image = path.join(directory, 'shot.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Compare', attachments: [{ path: '/repo/a.ts' }, { path: image, image: 'image/png' }] });
    expect(runTurn.mock.calls[0][0].prompt).toEqual({
      text: 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>',
      images: [{ mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
    });
    await run.dispose(); await rm(directory, { recursive: true, force: true });
  });

  test('denies and audits an open permission prompt before closing a naturally ended turn', async () => {
    const held = heldRunner();
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn: held.runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    const decision = held.canUseTool()('Bash', { command: 'pnpm test' }, toolCall('pending'));
    held.finish();
    const events = await collect(run.events);
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'Claude turn ended' });
    expect(events.map((event) => event.payload.kind)).toEqual(['request-opened', 'request-resolved']);
    expect(events[1]?.payload).toMatchObject({ decision: { kind: 'deny', reason: 'Claude turn ended' } });
  });

  test('tracks owned processes before spawn and clears ownership on success and failure', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    let finish!: () => void;
    const runTurn = vi.fn((): ClaudeTurnRun => {
      expect(ownedProcesses.has(ref)).toBe(true);
      return {
        events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
        completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined),
      };
    });
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, ownedProcesses });
    const successful = await adapter.continueConversation(ref, { text: 'continue' });
    expect(ownedProcesses.has(ref)).toBe(true); finish(); await collect(successful.events);
    expect(ownedProcesses.has(ref)).toBe(false);

    runTurn.mockImplementationOnce((): ClaudeTurnRun => {
      expect(ownedProcesses.has(ref)).toBe(true);
      return { events: (async function* () { yield* [] as NativeEvent[]; throw new Error('stream failed'); })(), completion: Promise.resolve({ exitCode: 1, signal: null }), interrupt: vi.fn(async () => undefined) };
    });
    const failed = await adapter.continueConversation(ref, { text: 'again' });
    await expect(collect(failed.events)).rejects.toThrow('stream failed');
    expect(ownedProcesses.has(ref)).toBe(false);
  });

  test('propagates a failed runner completion even when its event stream closes cleanly', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    let fail!: (error: Error) => void;
    const completion = new Promise<never>((_resolve, reject) => { fail = reject; });
    const runTurn = (): ClaudeTurnRun => ({
      events: (async function* () { yield { provider: 'claude', nativeId: 'native-user', nativeType: 'user', observedAt: 1, payload: { kind: 'turn-started', turnId: 'native-user', userMessageId: 'native-user', text: 'go' } } as NativeEvent; })(),
      completion, interrupt: vi.fn(async () => undefined),
    });
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, ownedProcesses });
    const run = await adapter.continueConversation(ref, { text: 'go' });
    const observed: NativeEvent[] = [];
    const reading = (async () => { for await (const event of run.events) observed.push(event); })();
    fail(new Error('Claude process exited with code 1'));
    await expect(reading).rejects.toThrow('Claude process exited with code 1');
    expect(observed.map((event) => event.nativeId)).toEqual(['native-user']);
    expect(ownedProcesses.has(ref)).toBe(false);
  });

  test('closes the event stream cleanly for an interrupted turn that exited nonzero, and fails the same exit when not interrupted', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    const finishedWith = async (completion: Awaited<ClaudeTurnRun['completion']>) => {
      const runTurn = (): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve(completion), interrupt: vi.fn(async () => undefined) });
      const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, ownedProcesses });
      return collect((await adapter.continueConversation(ref, { text: 'stop' })).events);
    };
    await expect(finishedWith({ exitCode: 130, signal: null, interrupted: true })).resolves.toEqual([]);
    expect(ownedProcesses.has(ref)).toBe(false);
    await expect(finishedWith({ exitCode: 130, signal: null })).rejects.toThrow('Claude process exited with code 130');
    expect(ownedProcesses.has(ref)).toBe(false);
  });

  test('retains ownership after interrupt and during disposal until the process stream settles', async () => {
    const ownedProcesses = new ClaudeOwnedProcessRegistry();
    let finish!: () => void;
    const interrupt = vi.fn(async () => undefined);
    const runTurn = vi.fn((): ClaudeTurnRun => ({
      events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
      completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt,
    }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn, ownedProcesses });
    const run = await adapter.continueConversation(ref, { text: 'continue' });

    await run.interrupt();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(ownedProcesses.has(ref)).toBe(true);

    let disposed = false;
    const disposal = run.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(ownedProcesses.has(ref)).toBe(true);

    finish();
    await disposal;
    expect(ownedProcesses.has(ref)).toBe(false);
  });

  test('creates UUID drafts in memory, uses session-id once, and later resumes the exact native session', async () => {
    const draftId = '123e4567-e89b-42d3-a456-426614174000';
    const calls: Array<{ newSession?: boolean }> = [];
    const runTurn = vi.fn((options): ClaudeTurnRun => {
      calls.push({ newSession: options.newSession });
      return { events: (async function* () { await options.rereadNative(); yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) };
    });
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', randomUUID: () => draftId, runTurn, rereadNative: async () => [] });
    const draft = await adapter.createConversation('/work/fractal');
    expect(draft).toEqual({ provider: 'claude', nativeSessionId: draftId, projectPath: '/canonical/fractal' });
    const first = await adapter.continueConversation(draft, { text: 'begin' }); await collect(first.events); await first.dispose();
    expect(calls[0]).toEqual({ newSession: true });
    expect(runTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ ref: draft, newSession: true }));
    await adapter.continueConversation(draft, { text: 'again' });
    expect(calls[1]).toEqual({ newSession: undefined });
  });
});

async function collect(iterable: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> { const values: NativeEvent[] = []; for await (const value of iterable) values.push(value); return values; }
