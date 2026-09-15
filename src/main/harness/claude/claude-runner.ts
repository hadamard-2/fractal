import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';
import { createClaudeNormalizationContext, normalizeClaudeRecord } from '@/main/harness/claude/claude-normalizer';
import { nativeEventKey, type NativeEvent } from '@/main/harness/reconciler';
import type { ConversationRef } from '@/shared/conversation-contract';

export interface ClaudeChildProcess {
  readonly pid?: number;
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface ClaudeSpawnOptions { cwd: string; shell: false; stdio: ['ignore', 'pipe', 'pipe'] }
export type SpawnClaudeProcess = (file: string, args: string[], options: ClaudeSpawnOptions) => ClaudeChildProcess;

export interface ClaudeRunCompletion { exitCode: number | null; signal: NodeJS.Signals | null; diagnostic?: string }
export interface ClaudeTurnRun {
  events: AsyncIterable<NativeEvent>;
  completion: Promise<ClaudeRunCompletion>;
  interrupt(): Promise<void>;
}

export interface RunClaudeTurnOptions {
  ref: ConversationRef;
  prompt: { text: string };
  executable: string;
  spawnProcess?: SpawnClaudeProcess;
  permissionBridge: { configPath: string; toolName: string };
  newSession?: boolean;
  rereadNative(): Promise<NativeEvent[] | AsyncIterable<NativeEvent>>;
}

export function runClaudeTurn(options: RunClaudeTurnOptions): ClaudeTurnRun {
  const sessionArguments = options.newSession
    ? ['--session-id', options.ref.nativeSessionId]
    : ['--resume', options.ref.nativeSessionId];
  const args = [
    ...sessionArguments, '--print', options.prompt.text, '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--mcp-config', options.permissionBridge.configPath,
    '--permission-prompt-tool', options.permissionBridge.toolName,
  ];
  const child = (options.spawnProcess ?? spawnClaude)(options.executable, args, {
    cwd: options.ref.projectPath, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  type Terminal = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
  let terminalValue: Terminal | undefined;
  let resolveTerminal!: (result: Terminal) => void;
  const terminal = new Promise<Terminal>((resolve) => { resolveTerminal = resolve; });
  const settleTerminal = (value: Terminal): void => {
    if (terminalValue) return;
    terminalValue = value;
    resolveTerminal(value);
  };
  child.once('close', (code, signal) => settleTerminal({ code, signal }));
  child.once('error', (error) => settleTerminal({ code: null, signal: null, error }));

  const eventBuffer = new ReplayEventBuffer();
  const diagnostic = new DiagnosticBuffer();
  const stdoutDrain = drainStdout(child.stdout, eventBuffer);
  const stderrDrain = drainStderr(child.stderr, diagnostic);
  const completion = (async (): Promise<ClaudeRunCompletion> => {
    const result = await terminal;
    if (result.error && isLaunchError(result.error)) {
      void stdoutDrain.catch((): void => undefined);
      void stderrDrain.catch((): void => undefined);
    } else {
      if (result.error) throw sanitizedError(result.error);
      const drains = await Promise.allSettled([stdoutDrain, stderrDrain]);
      const failedDrain = drains.find((drain): drain is PromiseRejectedResult => drain.status === 'rejected');
      if (failedDrain) throw sanitizedError(failedDrain.reason);
    }
    for await (const event of asAsync(await options.rereadNative())) eventBuffer.publish(event);
    eventBuffer.close();
    const combinedDiagnostic = diagnostic.value(result.error?.message);
    return { exitCode: result.code, signal: result.signal, ...(combinedDiagnostic ? { diagnostic: combinedDiagnostic } : {}) };
  })().catch((error: unknown) => {
    const safeError = sanitizedError(error);
    eventBuffer.fail(safeError);
    throw safeError;
  });

  const eventStream: AsyncIterable<NativeEvent> = {
    async *[Symbol.asyncIterator](): AsyncGenerator<NativeEvent> {
      yield* eventBuffer.iterate(terminalValue !== undefined);
    },
  };

  return {
    events: eventStream, completion,
    async interrupt(): Promise<void> {
      if (terminalValue) return;
      child.kill('SIGINT');
      await Promise.race([terminal, delay(2_000)]);
      if (!terminalValue) child.kill('SIGTERM');
      await terminal;
    },
  };
}

function spawnClaude(file: string, args: string[], options: ClaudeSpawnOptions): ClaudeChildProcess {
  return spawn(file, args, options) as ChildProcessWithoutNullStreams;
}

async function drainStdout(stream: AsyncIterable<Uint8Array | string>, events: ReplayEventBuffer): Promise<void> {
  const decoder = new NdjsonDecoder<unknown>();
  const context = createClaudeNormalizationContext();
  let ordinal = 0;
  for await (const chunk of stream) {
    for (const line of decoder.push(chunk)) {
      if (!line.ok) continue;
      for (const event of normalizeClaudeRecord(line.value, ordinal++, context)) events.publish(event);
    }
  }
  decoder.finish();
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
      if (this.failure) throw this.failure;
      yield* this.logical;
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
