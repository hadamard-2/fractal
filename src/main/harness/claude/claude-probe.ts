import { execFile } from 'node:child_process';
import type { ConversationRef, ConversationRuntime, HarnessStatus } from '@/shared/conversation-contract';

export interface ClaudeExecResult { exitCode: number; stdout?: string; stderr?: string }
export type ClaudeExec = (file: string, args: string[], options: { timeoutMs: number }) => Promise<ClaudeExecResult>;

export interface ClaudeCapabilityEvidence {
  resume: boolean;
  sessionId: boolean;
  streamJson: boolean;
  partialMessages: boolean;
  mcpConfig: boolean;
  permissionPromptTool: boolean;
  permissionPrompts: boolean;
  askUserQuestion: boolean;
  authenticated: boolean;
}

export type ClaudeProbeStatus = HarnessStatus & { evidence: ClaudeCapabilityEvidence };

const TIMEOUT_MS = 5_000;
const NO_CAPABILITIES = {
  create: false, partialStreaming: false, approvals: false, questions: false,
  interrupt: false, steerWhileRunning: false, fork: false,
} as const;

export async function probeClaude(exec: ClaudeExec = directExec, executable = 'claude'): Promise<ClaudeProbeStatus> {
  const [version, help, agents] = await Promise.all([
    safeExec(exec, executable, ['--version']),
    safeExec(exec, executable, ['--help']),
    safeExec(exec, executable, ['agents', '--json']),
  ]);
  const helpText = help.stdout ?? '';
  const agentsDocument = agents.exitCode === 0 ? parseObject(agents.stdout) : undefined;
  const authenticated = agentsDocument?.authenticated === true;
  const evidence: ClaudeCapabilityEvidence = {
    resume: hasFlag(helpText, '--resume'),
    sessionId: hasFlag(helpText, '--session-id'),
    streamJson: hasFlag(helpText, '--output-format') && /stream-json/.test(helpText),
    partialMessages: hasFlag(helpText, '--include-partial-messages'),
    mcpConfig: hasFlag(helpText, '--mcp-config'),
    permissionPromptTool: hasFlag(helpText, '--permission-prompt-tool'),
    permissionPrompts: hasFlag(helpText, '--permission-mode'),
    askUserQuestion: /\bAskUserQuestion\b/.test(helpText),
    authenticated,
  };
  const capabilities = {
    ...NO_CAPABILITIES,
    create: evidence.sessionId && evidence.streamJson,
    partialStreaming: evidence.streamJson && evidence.partialMessages,
    approvals: evidence.mcpConfig && evidence.permissionPromptTool && evidence.permissionPrompts,
    questions: evidence.mcpConfig && evidence.permissionPromptTool && evidence.askUserQuestion,
    interrupt: evidence.streamJson,
  };
  if (version.exitCode !== 0) return { provider: 'claude', availability: 'unavailable', message: 'Claude executable is unavailable.', capabilities, evidence };
  const versionText = firstLine(version.stdout);
  if (!authenticated) return { provider: 'claude', availability: 'unauthenticated', ...(versionText ? { version: versionText } : {}), message: 'Claude authentication was not confirmed noninteractively.', capabilities, evidence };
  return { provider: 'claude', availability: 'available', ...(versionText ? { version: versionText } : {}), capabilities, evidence };
}

export interface ClaudeRuntimeDependencies {
  hasOwnedProcess(ref: ConversationRef): boolean;
  exec: ClaudeExec;
  executable?: string;
  transcriptGrew?(ref: ConversationRef): Promise<boolean>;
}

export async function detectClaudeRuntime(ref: ConversationRef, dependencies: ClaudeRuntimeDependencies): Promise<ConversationRuntime> {
  if (dependencies.hasOwnedProcess(ref)) return 'active-in-fractal';
  const result = await safeExec(dependencies.exec, dependencies.executable ?? 'claude', ['agents', '--json']);
  const document = result.exitCode === 0 ? parseObject(result.stdout) : undefined;
  const agents = Array.isArray(document?.agents) ? document.agents : undefined;
  const matchingActiveAgent = agents?.some((value) => {
    const agent = objectValue(value);
    return agent?.sessionId === ref.nativeSessionId && agent.cwd === ref.projectPath && agent.status !== 'idle' && agent.status !== 'stopped';
  }) ?? false;
  if (matchingActiveAgent) return 'active-externally';
  if (await dependencies.transcriptGrew?.(ref)) return 'active-externally';
  return agents ? 'idle' : 'unknown';
}

async function safeExec(exec: ClaudeExec, executable: string, args: string[]): Promise<ClaudeExecResult> {
  try { return await exec(executable, args, { timeoutMs: TIMEOUT_MS }); }
  catch { return { exitCode: 127, stdout: '', stderr: '' }; }
}

function directExec(file: string, args: string[], options: { timeoutMs: number }): Promise<ClaudeExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === 'number'
        ? (error as unknown as { code: number }).code : error ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function hasFlag(help: string, flag: string): boolean { return new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|,|$)`, 'm').test(help); }
function firstLine(value?: string): string | undefined { return value?.split(/\r?\n/, 1)[0]?.trim() || undefined; }
function parseObject(value?: string): Record<string, unknown> | undefined { try { return objectValue(JSON.parse(value ?? '')); } catch { return undefined; } }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
