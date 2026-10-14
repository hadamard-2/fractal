import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { query as sdkQuery, type CanUseTool, type Options, type SDKUserMessage, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeNormalizationContext, normalizeClaudeRecord, normalizeClaudeStreamRecord } from '@/main/harness/claude/claude-normalizer';
import { nativeEventKey, type NativeEvent } from '@/main/harness/reconciler';
import type { ProcessWatchdog } from '@/main/process-watchdog';
import type { ConversationImage, ConversationRef } from '@/shared/conversation-contract';

/** The claude process for one turn: what the SDK drives, plus the pid and stderr Fractal reads itself. */
export type ClaudeChildProcess = SpawnedProcess & {
  readonly pid?: number;
  readonly stderr: AsyncIterable<Uint8Array | string>;
};

export interface ClaudeSpawnOptions { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; shell: false; stdio: ['pipe', 'pipe', 'pipe'] }
export type SpawnClaudeProcess = (command: string, args: string[], options: ClaudeSpawnOptions) => ClaudeChildProcess;

/** The SDK's query(), narrowed to what the runner uses, so tests can stand in for it. */
export type ClaudeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown> & { interrupt(): Promise<unknown> };

export interface ClaudeRunCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Fractal asked the turn to stop and claude ended it by exiting, whatever the exit code. */
  interrupted?: boolean;
  diagnostic?: string;
}
export interface ClaudeTurnRun {
  events: AsyncIterable<NativeEvent>;
  completion: Promise<ClaudeRunCompletion>;
  interrupt(): Promise<void>;
}

export interface RunClaudeTurnOptions {
  ref: ConversationRef;
  /** text is the composed prompt (user text plus any attachment block). */
  prompt: { text: string; images?: ConversationImage[] };
  /** The prompt record's uuid, which Claude also uses as the turn's id; generated when absent. */
  turnId?: string;
  /** The user's own claude: a path, or a bare name looked up on PATH. The SDK never runs its own binary. */
  executable: string;
  query?: ClaudeQuery;
  spawnProcess?: SpawnClaudeProcess;
  /** Answers the prompts and questions Claude's own rules would put to the user. */
  canUseTool?: CanUseTool;
  newSession?: boolean;
  /** Absent leaves Claude on its configured default. */
  model?: string;
  /** Only meaningful with a model that takes effort. */
  effort?: string;
  /** Absent leaves Claude on its configured default. */
  permissionMode?: string;
  /** Interrupts claude if Fractal dies mid-turn; claude ends the commands it started when interrupted. */
  watchdog?: Pick<ProcessWatchdog, 'watch' | 'unwatch'>;
  rereadNative(): Promise<NativeEvent[] | AsyncIterable<NativeEvent>>;
}

/**
 * Runs one Claude turn through the Agent SDK. One claude process per turn,
 * resumed by session id; Fractal spawns it through the SDK's hook so it keeps
 * the process for the watchdog, its exit code and its stderr.
 */
export function runClaudeTurn(options: RunClaudeTurnOptions): ClaudeTurnRun {
  const turnId = options.turnId ?? randomUUID();
  const input = new TurnInput(sdkUserMessage(options.prompt, turnId));
  const diagnostic = new DiagnosticBuffer();
  type Terminal = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
  let terminalValue: Terminal | undefined;
  let resolveTerminal!: (result: Terminal) => void;
  const terminal = new Promise<Terminal>((resolve) => { resolveTerminal = resolve; });
  let child: ClaudeChildProcess | undefined;
  let watchedPid: number | undefined;
  let stderrDrain: Promise<void> = Promise.resolve();
  const settleTerminal = (value: Terminal): void => {
    if (terminalValue) return;
    terminalValue = value;
    if (watchedPid !== undefined) options.watchdog?.unwatch(watchedPid);
    resolveTerminal(value);
  };

  const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const spawned = (options.spawnProcess ?? spawnClaude)(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd ?? options.ref.projectPath, env: spawnOptions.env,
      ...(spawnOptions.signal ? { signal: spawnOptions.signal } : {}), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;
    if (options.watchdog && spawned.pid) {
      watchedPid = spawned.pid;
      options.watchdog.watch(watchedPid, 'SIGINT');
    }
    spawned.once('exit', (code, signal) => settleTerminal({ code, signal }));
    spawned.once('error', (error) => settleTerminal({ code: null, signal: null, error }));
    stderrDrain = drainStderr(spawned.stderr, diagnostic).catch((): void => undefined);
    return spawned;
  };

  const sdkOptions: Options = {
    pathToClaudeCodeExecutable: options.executable,
    cwd: options.ref.projectPath,
    // Without this the SDK sends an empty system prompt, and the turn runs without Claude Code's own instructions and context.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    ...(options.newSession ? { sessionId: options.ref.nativeSessionId } : { resume: options.ref.nativeSessionId }),
    ...(options.model ? { model: options.model } : {}),
    // Fractal passes the user's choice through unchanged.
    ...(options.effort ? { effort: options.effort as Options['effort'] } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode as Options['permissionMode'] } : {}),
    includePartialMessages: true,
    ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
    spawnClaudeCodeProcess,
  };
  // The SDK spawns claude inside this call, through spawnClaudeCodeProcess.
  const turn = keepingSdkVersionOut(() => (options.query ?? sdkQuery)({ prompt: input.messages(), options: sdkOptions }));

  /** SIGINT, then SIGTERM two seconds later if claude is still running: for a turn whose stream broke. */
  let stopping: Promise<void> | undefined;
  const stopOwned = (): Promise<void> => stopping ??= (async () => {
    if (terminalValue || !child) return;
    child.kill('SIGINT');
    await Promise.race([terminal, delay(2_000)]);
    if (!terminalValue) child.kill('SIGTERM');
  })();

  let interruptRequested = false;
  let interrupting: Promise<void> | undefined;
  const interrupt = (): Promise<void> => interrupting ??= (async () => {
    if (terminalValue) return;
    interruptRequested = true;
    void turn.interrupt().catch((): void => undefined);
    await Promise.race([terminal, delay(2_000)]);
    if (!terminalValue) child?.kill('SIGTERM');
  })();

  const eventBuffer = new ReplayEventBuffer();
  let streamError: Error | undefined;
  const streamed = drainRecords(turn, eventBuffer, options.rereadNative, turnId, options.ref.nativeSessionId, () => input.close(), () => interruptRequested)
    .catch((error: unknown) => { streamError = sanitizedError(error); })
    .finally(() => input.close());

  const completion = (async (): Promise<ClaudeRunCompletion> => {
    await streamed;
    if (streamError && !interruptRequested) {
      await Promise.race([terminal, delay(0)]);
      // The SDK reports claude's nonzero exit or signal by throwing from the stream. That is the exit path's to report,
      // with claude's stderr and the final re-read, so only a break claude did not cause stops here.
      const exited = terminalValue && !terminalValue.error && (terminalValue.signal !== null || terminalValue.code !== 0);
      const launchFailed = terminalValue?.error && isLaunchError(terminalValue.error);
      if (!exited && !launchFailed) {
        await stopOwned();
        throw streamError;
      }
    }
    const result = terminalValue ?? await terminal;
    if (result.error) throw sanitizedError(result.error);
    await stderrDrain;
    for await (const event of asAsync(await options.rereadNative())) eventBuffer.publish(event);
    const combinedDiagnostic = diagnostic.value();
    // A stop Fractal asked for ends with claude exiting, whatever its code, and the SDK throws for it; only a signal (the runner's own SIGTERM) is a failure.
    const interrupted = interruptRequested && !result.signal;
    if (result.signal || (result.code !== 0 && !interrupted)) throw new Error(`Claude process ${result.signal ? `terminated by ${result.signal}` : `exited with code ${result.code}`}${combinedDiagnostic ? `: ${combinedDiagnostic}` : ''}`);
    eventBuffer.close();
    return { exitCode: result.code, signal: result.signal, ...(interrupted ? { interrupted: true } : {}), ...(combinedDiagnostic ? { diagnostic: combinedDiagnostic } : {}) };
  })().catch((error: unknown) => {
    const safeError = sanitizedError(error);
    eventBuffer.fail(safeError);
    throw safeError;
  });
  void completion.catch((): void => undefined);

  const eventStream: AsyncIterable<NativeEvent> = {
    async *[Symbol.asyncIterator](): AsyncGenerator<NativeEvent> {
      yield* eventBuffer.iterate(terminalValue !== undefined);
    },
  };

  return { events: eventStream, completion, interrupt };
}

/** The turn's prompt: the text block (omitted when empty), then base64 image blocks. Claude saves it under `turnId` as its uuid, which is how the runner finds this turn in the transcript. */
export function sdkUserMessage(prompt: RunClaudeTurnOptions['prompt'], turnId: string): SDKUserMessage {
  const content = [
    ...(prompt.text ? [{ type: 'text' as const, text: prompt.text }] : []),
    ...(prompt.images ?? []).map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } })),
  ];
  return { type: 'user', uuid: turnId as SDKUserMessage['uuid'], message: { role: 'user', content }, parent_tool_use_id: null };
}

/**
 * The prompt as the SDK's input stream: one message, then held open until
 * close(). Permission answers and interrupts travel over the same pipe, so
 * closing it before the turn's result would cut them off.
 */
class TurnInput {
  private closed = false;
  private release: (() => void) | undefined;
  constructor(private readonly message: SDKUserMessage) {}

  async *messages(): AsyncGenerator<SDKUserMessage> {
    yield this.message;
    if (!this.closed) await new Promise<void>((resolve) => { this.release = resolve; });
  }

  close(): void {
    this.closed = true;
    this.release?.();
    this.release = undefined;
  }
}

function spawnClaude(command: string, args: string[], options: ClaudeSpawnOptions): ClaudeChildProcess {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

const SDK_VERSION_VARIABLE = 'CLAUDE_AGENT_SDK_VERSION';

/**
 * query() sets CLAUDE_AGENT_SDK_VERSION on the process it runs in. The claude it
 * spawns has its own copy of the environment by the time it returns; Fractal's
 * other children, such as terminals, copy process.env and must not inherit it.
 */
function keepingSdkVersionOut<T>(run: () => T): T {
  const before = process.env[SDK_VERSION_VARIABLE];
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env[SDK_VERSION_VARIABLE];
    else process.env[SDK_VERSION_VARIABLE] = before;
  }
}

async function drainRecords(records: AsyncIterable<unknown>, events: ReplayEventBuffer, rereadNative: RunClaudeTurnOptions['rereadNative'], turnId: string, sessionId: string, onResult: () => void, stopRequested: () => boolean): Promise<void> {
  const context = createClaudeNormalizationContext();
  let ordinal = 0;
  let anchoredTurnId: string | undefined;
  // Events with no turn of their own, from records claude sends before this turn's prompt is anchored. Published then,
  // they would land on whichever turn the conversation last had open, so they wait and take this turn's id.
  const held: NativeEvent[] = [];
  const release = (): void => {
    for (const event of held.splice(0)) events.publish(anchoredTurnId ? withTurnId(event, anchoredTurnId) : event);
  };
  const anchor = async (): Promise<void> => {
    try {
      for await (const event of asAsync(await rereadNative())) {
        if (event.payload.kind === 'turn-started' && event.payload.turnId === turnId) {
          anchoredTurnId = event.payload.turnId;
          events.publish(event);
        }
      }
    } catch { /* The native user record may not be persisted yet. */ }
    if (anchoredTurnId) release();
  };
  try {
    for await (const value of records) {
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      if (typeof record?.session_id === 'string' && record.session_id !== sessionId) { ordinal += 1; continue; }
      if (record?.type === 'system' && record.subtype === 'init') { ordinal += 1; continue; }
      if (record?.type === 'result') onResult();
      if (record?.type === 'stream_event' || record?.type === 'assistant' || record?.type === 'result') {
        if (!anchoredTurnId) await anchor();
        // Claude ends a stopped turn with an error result, which says nothing of the stop; only Fractal knows it asked.
        // A turn that finished before the stop took effect keeps its own result.
        const stopped = record.type === 'result' && stopRequested() && record.subtype !== 'success';
        const normalized = record.type === 'stream_event'
          ? normalizeClaudeStreamRecord(record, ordinal++, context, anchoredTurnId ?? '')
          : normalizeClaudeRecord({ ...record, ...(stopped ? { subtype: 'interrupted' } : {}), parentUuid: anchoredTurnId }, ordinal++, context);
        if (anchoredTurnId) for (const event of normalized) events.publish(event);
        continue;
      }
      // The SDK's user messages, such as tool results, carry no parentUuid, so once anchored they join the turn like its assistant messages.
      const input = anchoredTurnId && record?.type === 'user' && record.parentUuid === undefined ? { ...record, parentUuid: anchoredTurnId } : value;
      for (const event of normalizeClaudeRecord(input, ordinal++, context)) {
        if (event.payload.kind === 'turn-started' && event.payload.turnId === turnId) {
          anchoredTurnId = turnId;
          events.publish(event);
          release();
        } else if (event.payload.turnId !== undefined) events.publish(event);
        else if (anchoredTurnId) events.publish(withTurnId(event, anchoredTurnId));
        else held.push(event);
      }
    }
  } finally {
    // A turn that never anchored in the stream may still have its prompt in the transcript.
    if (held.length > 0 && !anchoredTurnId) await anchor();
    release();
  }
}

/** Gives an event that names no turn the live turn's id; one that names a turn keeps it. */
function withTurnId(event: NativeEvent, turnId: string): NativeEvent {
  return event.payload.turnId === undefined ? { ...event, payload: { ...event.payload, turnId } } : event;
}

async function drainStderr(stream: AsyncIterable<Uint8Array | string>, diagnostic: DiagnosticBuffer): Promise<void> {
  for await (const chunk of stream) diagnostic.append(chunk);
}

type Subscriber = { queue: NativeEvent[]; wake?: () => void };

class ReplayEventBuffer {
  private readonly logical: NativeEvent[] = [];
  private readonly slots = new Map<string, number>();
  private readonly subscribers = new Set<Subscriber>();
  private closed = false;
  private failure?: Error;
  private settleDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.settleDone = resolve; });

  publish(event: NativeEvent): void {
    if (this.closed) return;
    const key = nativeEventKey(event);
    const slot = this.slots.get(key);
    if (slot === undefined) {
      this.slots.set(key, this.logical.length);
      this.logical.push(event);
    } else {
      if (isDeepStrictEqual(this.logical[slot], event)) return;
      this.logical[slot] = event;
    }
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(event);
      subscriber.wake?.();
      subscriber.wake = undefined;
    }
  }

  close(): void { this.finish(); }
  fail(error: Error): void { this.failure = error; this.finish(); }

  async *iterate(waitForFinal: boolean): AsyncGenerator<NativeEvent> {
    if (waitForFinal) {
      await this.done;
      yield* this.logical;
      if (this.failure) throw this.failure;
      return;
    }
    const subscriber: Subscriber = { queue: [...this.logical] };
    this.subscribers.add(subscriber);
    try {
      while (true) {
        const next = subscriber.queue.shift();
        if (next) { yield next; continue; }
        if (this.closed) {
          if (this.failure) throw this.failure;
          return;
        }
        await new Promise<void>((resolve) => { subscriber.wake = resolve; });
      }
    } finally {
      this.subscribers.delete(subscriber);
      subscriber.wake = undefined;
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.settleDone();
    for (const subscriber of this.subscribers) subscriber.wake?.();
  }
}

class DiagnosticBuffer {
  private text = '';
  append(chunk: Uint8Array | string): void {
    if (this.text.length >= 4_096) return;
    this.text += Buffer.from(chunk).toString('utf8').slice(0, 4_096 - this.text.length);
  }
  value(extra?: string): string {
    const joined = extra ? `${this.text}\n${extra}`.slice(0, 4_096) : this.text;
    return sanitize(joined);
  }
}

function sanitize(value: string): string {
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127 ? '' : character;
  }).join('');
  return printable
    .replace(/\b(bearer|token|api[-_ ]?key|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .trim();
}

function sanitizedError(error: unknown): Error {
  return new Error(sanitize(error instanceof Error ? error.message : String(error)) || 'Claude process stream failed');
}

function isLaunchError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC';
}

async function* asAsync(events: NativeEvent[] | AsyncIterable<NativeEvent>): AsyncGenerator<NativeEvent> {
  if (Symbol.asyncIterator in Object(events)) { for await (const event of events as AsyncIterable<NativeEvent>) yield event; return; }
  yield* events as NativeEvent[];
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
