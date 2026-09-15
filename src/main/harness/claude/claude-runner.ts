import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';
import { createClaudeNormalizationContext, normalizeClaudeRecord } from '@/main/harness/claude/claude-normalizer';
import type { NativeEvent } from '@/main/harness/reconciler';
import type { ConversationRef } from '@/shared/conversation-contract';

export interface ClaudeChildProcess {
  readonly pid?: number;
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
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
  let exited = false;
  let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = resolve; });
  child.once('close', (code, signal) => { exited = true; resolveExit({ code, signal }); });

  let resolveCompletion!: (value: ClaudeRunCompletion) => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const completion = new Promise<ClaudeRunCompletion>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });

  async function* eventStream(): AsyncGenerator<NativeEvent> {
    const decoder = new NdjsonDecoder<unknown>();
    const context = createClaudeNormalizationContext();
    let ordinal = 0;
    const stderr = collectDiagnostic(child.stderr);
    try {
      for await (const chunk of child.stdout) {
        for (const line of decoder.push(chunk)) {
          if (!line.ok) continue;
          for (const event of normalizeClaudeRecord(line.value, ordinal++, context)) yield event;
        }
      }
      decoder.finish();
      const result = await exit;
      const diagnostic = await stderr;
      const reread = await options.rereadNative();
      for await (const event of asAsync(reread)) yield event;
      resolveCompletion({ exitCode: result.code, signal: result.signal, ...(diagnostic ? { diagnostic } : {}) });
    } catch (error) {
      rejectCompletion(error);
      throw error;
    }
  }

  return {
    events: eventStream(), completion,
    async interrupt(): Promise<void> {
      if (exited) return;
      child.kill('SIGINT');
      await Promise.race([exit, delay(2_000)]);
      if (!exited) child.kill('SIGTERM');
      await exit;
    },
  };
}

function spawnClaude(file: string, args: string[], options: ClaudeSpawnOptions): ClaudeChildProcess {
  return spawn(file, args, options) as ChildProcessWithoutNullStreams;
}

async function collectDiagnostic(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  let value = '';
  for await (const chunk of stream) {
    if (value.length >= 4_096) continue;
    value += Buffer.from(chunk).toString('utf8').slice(0, 4_096 - value.length);
  }
  return sanitize(value);
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

async function* asAsync(events: NativeEvent[] | AsyncIterable<NativeEvent>): AsyncGenerator<NativeEvent> {
  if (Symbol.asyncIterator in Object(events)) { for await (const event of events as AsyncIterable<NativeEvent>) yield event; return; }
  yield* events as NativeEvent[];
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
