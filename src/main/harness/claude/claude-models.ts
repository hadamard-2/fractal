import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';
import type { AgentModel } from '@/shared/conversation-contract';

export interface ClaudeModelsProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stdin: { write(chunk: string): unknown; on(event: 'error', listener: (error: Error) => void): unknown };
  once(event: 'error', listener: (error: Error) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}
export type SpawnClaudeModelsProcess = (file: string, args: readonly string[]) => ClaudeModelsProcess;

const REQUEST_ID = 'fractal-models';
const TIMEOUT_MS = 10_000;

/**
 * Stream-json mode answers an `initialize` control request with the models
 * Claude Code's own picker offers. Hooks are disabled so listing models does
 * not run the user's SessionStart hooks. This control protocol is not a
 * documented CLI contract, so every failure reads as "no models".
 */
export const CLAUDE_MODELS_ARGS: readonly string[] = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}'];

export async function listClaudeModels(options: { executable?: string; spawnProcess?: SpawnClaudeModelsProcess; timeoutMs?: number } = {}): Promise<AgentModel[]> {
  let child: ClaudeModelsProcess;
  try { child = (options.spawnProcess ?? spawnModelsProcess)(options.executable ?? 'claude', CLAUDE_MODELS_ARGS); } catch { return []; }
  child.stdin.on('error', () => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<AgentModel[]>((resolve) => { timer = setTimeout(() => resolve([]), options.timeoutMs ?? TIMEOUT_MS); });
  const failed = new Promise<AgentModel[]>((resolve) => { child.once('error', () => resolve([])); });
  try {
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
    return await Promise.race([readModels(child.stdout), timedOut, failed]);
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
  }
}

export function parseClaudeModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AgentModel[] => {
    const model = objectValue(entry);
    // `default` defers to Claude's configured model, which is what Fractal's own "no choice" already sends.
    if (!model || typeof model.value !== 'string' || !model.value || model.value === 'default') return [];
    const efforts = model.supportsEffort === true && Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && level.length > 0)
      : [];
    const name = typeof model.displayName === 'string' && model.displayName ? model.displayName : model.value;
    const description = typeof model.description === 'string' && model.description ? model.description : undefined;
    return [{ id: model.value, label: versionedLabel(name, description), ...(description ? { description } : {}), efforts }];
  });
}

/**
 * Claude's display name is the bare family ("Opus"); the version lives at the
 * head of the description ("Opus 5.5 · Best for…"). That head is used only
 * when it starts with the name, so any other description shape keeps the
 * plain name rather than putting a blurb in the picker.
 */
function versionedLabel(name: string, description: string | undefined): string {
  const head = description?.split(' · ')[0].trim();
  return head && head !== name && head.startsWith(`${name} `) ? head : name;
}

async function readModels(stdout: AsyncIterable<Uint8Array | string>): Promise<AgentModel[]> {
  const decoder = new NdjsonDecoder<unknown>();
  try {
    for await (const chunk of stdout) {
      for (const line of decoder.push(chunk)) {
        if (!line.ok) continue;
        const record = objectValue(line.value);
        const response = objectValue(record?.response);
        if (record?.type !== 'control_response' || response?.request_id !== REQUEST_ID) continue;
        return parseClaudeModels(objectValue(response.response)?.models);
      }
    }
  } catch { /* A broken pipe is the same as no answer. */ }
  return [];
}

function spawnModelsProcess(file: string, args: readonly string[]): ClaudeModelsProcess {
  return spawn(file, [...args], { cwd: homedir(), shell: false, stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as ClaudeModelsProcess;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
