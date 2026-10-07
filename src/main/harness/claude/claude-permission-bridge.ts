import { createHash, randomBytes } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { BlockingRequest, UserDecision } from '@/shared/conversation-contract';

const TOOL_INPUT = z.object({
  tool_name: z.string().min(1).max(256),
  tool_use_id: z.string().min(1).max(512),
  input: z.record(z.string(), z.unknown()),
}).strict();

const QUESTION_INPUT = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().min(1),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() }).strict()).optional(),
    multiSelect: z.boolean().optional(),
  }).strict()).min(1),
}).passthrough();

const COMMAND_INPUT = z.object({ command: z.string().min(1) }).passthrough();

export type ClaudePermissionToolInput = z.infer<typeof TOOL_INPUT>;
export type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

interface StartOptions {
  tempDir: string;
  onRequest(request: BlockingRequest, signal: AbortSignal): Promise<UserDecision>;
  timeoutMs?: number;
  approvals?: boolean;
  questions?: boolean;
}

export class ClaudePermissionBridge {
  readonly token: string;
  readonly port: number;
  readonly url: string;
  readonly configPath: string;
  readonly mcpToolName: string;
  readonly toolName: string;
  private disposed = false;
  private readonly pending = new Set<AbortController>();

  private constructor(
    private readonly httpServer: Server,
    private readonly closeMcp: () => Promise<void>,
    private readonly timeoutMs: number,
    private readonly onRequest: StartOptions['onRequest'],
    private readonly capabilities: { approvals: boolean; questions: boolean },
    values: { token: string; port: number; configPath: string; mcpToolName: string; toolName: string },
  ) {
    this.token = values.token;
    this.port = values.port;
    this.url = `http://127.0.0.1:${values.port}/mcp`;
    this.configPath = values.configPath;
    this.mcpToolName = values.mcpToolName;
    this.toolName = values.toolName;
  }

  static async start(options: StartOptions): Promise<ClaudePermissionBridge> {
    const token = randomBytes(32).toString('hex');
    const suffix = randomBytes(12).toString('hex');
    const serverName = `fractal_permission_${suffix}`;
    const mcpToolName = `request_${suffix}`;
    const bridgeRef: { current?: ClaudePermissionBridge } = {};
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: serverName, version: '1.0.0' });
      // The SDK still validates the MCP argument as an object. Shape validation
      // stays inside `route` so malformed provider calls receive a provider-valid
      // denial instead of an MCP protocol error that Claude cannot interpret.
      server.registerTool(mcpToolName, { inputSchema: z.object({}).passthrough() }, async (input, context) => ({
        content: [{ type: 'text', text: JSON.stringify(await bridgeRef.current?.route(input, context.mcpReq.signal) ?? denial('Permission bridge closed')) }],
      }));
      return server;
    });
    const app = createMcpExpressApp({ host: '127.0.0.1', allowedOrigins: [], jsonLimit: '64kb' });
    app.use((request: Request, response: Response, next: NextFunction) => {
      const expected = `127.0.0.1:${bridgeRef.current?.port ?? addressPort(httpServer)}`;
      const localhost = `localhost:${bridgeRef.current?.port ?? addressPort(httpServer)}`;
      if (request.headers.host !== expected && request.headers.host !== localhost) {
        response.status(403).json({ error: 'Forbidden' }); return;
      }
      const supplied = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!supplied || !safeTokenEqual(token, supplied)) {
        response.status(401).json({ error: 'Unauthorized' }); return;
      }
      next();
    });
    app.all('/mcp', (request, response) => { void toNodeHandler(handler)(request, response, request.body); });
    const httpServer = createServer(app);
    httpServer.keepAliveTimeout = 1;
    await listen(httpServer);
    const port = addressPort(httpServer);
    const configPath = path.join(options.tempDir, `fractal-claude-mcp-${suffix}.json`);
    const toolName = `mcp__${serverName}__${mcpToolName}`;
    const config = {
      mcpServers: { [serverName]: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
    };
    try {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await handler.close();
      await closeServer(httpServer);
      throw error;
    }
    const bridge = new ClaudePermissionBridge(httpServer, () => handler.close(), options.timeoutMs ?? 10 * 60 * 1_000, options.onRequest, {
      approvals: options.approvals ?? true, questions: options.questions ?? true,
    }, {
      token, port, configPath, mcpToolName, toolName,
    });
    bridgeRef.current = bridge;
    return bridge;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.pending) controller.abort('Permission bridge closed');
    this.pending.clear();
    await Promise.allSettled([this.closeMcp(), closeServer(this.httpServer), unlink(this.configPath)]);
  }

  private async route(value: unknown, clientSignal?: AbortSignal): Promise<ClaudePermissionResult> {
    const parsed = TOOL_INPUT.safeParse(value);
    if (!parsed.success || this.disposed) return denial(this.disposed ? 'Permission bridge closed' : 'Invalid permission request');
    if (parsed.data.tool_name === 'AskUserQuestion') {
      if (!this.capabilities.questions) return denial('Question routing is unavailable');
      const questions = QUESTION_INPUT.safeParse(parsed.data.input);
      if (questions.success && questions.data.questions.length !== 1) return denial('Multiple questions are not supported');
    } else if (!this.capabilities.approvals) return denial('Approval routing is unavailable');
    const request = blockingRequest(parsed.data);
    if (!request) return denial('Invalid permission request');
    const controller = new AbortController();
    const onClientAbort = (): void => controller.abort('Permission client disconnected');
    clientSignal?.addEventListener('abort', onClientAbort, { once: true });
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort('Permission request timed out'), this.timeoutMs);
    try {
      const decision = await Promise.race([
        this.onRequest(request, controller.signal),
        aborted(controller.signal),
      ]);
      if (controller.signal.aborted) return denial(abortReason(controller.signal));
      if (decision.kind === 'allow-once' && request.kind === 'approval') return { behavior: 'allow', updatedInput: parsed.data.input };
      if (decision.kind === 'answer' && request.kind === 'question') return { behavior: 'allow', updatedInput: { ...parsed.data.input, answers: decision.answers } };
      if (decision.kind === 'deny') return denial(decision.reason ?? 'Permission denied');
      return denial('Unsupported permission decision');
    } catch {
      return denial(abortReason(controller.signal));
    } finally {
      clearTimeout(timer);
      clientSignal?.removeEventListener('abort', onClientAbort);
      this.pending.delete(controller);
    }
  }
}

function blockingRequest(input: ClaudePermissionToolInput): BlockingRequest | undefined {
  if (input.tool_name === 'AskUserQuestion') {
    const question = QUESTION_INPUT.safeParse(input.input);
    if (!question.success) return undefined;
    const first = question.data.questions[0];
    return {
      id: input.tool_use_id, kind: 'question', provider: 'claude', prompt: first.question, fieldId: first.header,
      ...(first.options ? { choices: first.options.map((option) => ({ value: option.label, label: option.label })) } : {}),
      allowFreeText: !first.options?.length, status: 'open',
    };
  }
  if (input.tool_name === 'ExitPlanMode') {
    // Claude Code reads the plan file into the input; it is missing when the file wasn't written yet.
    const plan = typeof input.input.plan === 'string' ? input.input.plan : '';
    const filePath = typeof input.input.planFilePath === 'string' && input.input.planFilePath.trim() ? input.input.planFilePath : 'ExitPlanMode';
    return { id: input.tool_use_id, kind: 'approval', provider: 'claude', title: 'Review plan', operation: filePath, plan, status: 'open' };
  }
  const command = input.tool_name === 'Bash' ? COMMAND_INPUT.safeParse(input.input) : undefined;
  if (command && !command.success) return undefined;
  const operation = command?.success ? command.data.command : summarizeOperation(input.tool_name, input.input);
  if (!operation) return undefined;
  return { id: input.tool_use_id, kind: 'approval', provider: 'claude', title: `Allow ${input.tool_name}`, operation, status: 'open' };
}

function summarizeOperation(toolName: string, input: Record<string, unknown>): string | undefined {
  const likely = input.command ?? input.file_path ?? input.path ?? input.query;
  return typeof likely === 'string' && likely.trim() ? `${toolName}: ${likely}` : toolName;
}

function denial(message: string): ClaudePermissionResult { return { behavior: 'deny', message }; }
function abortReason(signal: AbortSignal): string { return typeof signal.reason === 'string' ? signal.reason : 'Permission bridge closed'; }
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error(abortReason(signal)));
    else signal.addEventListener('abort', () => reject(new Error(abortReason(signal))), { once: true });
  });
}
function safeTokenEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  return expectedDigest.equals(suppliedDigest);
}
function listen(server: Server): Promise<void> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
function addressPort(server: Server): number { const address = server.address(); if (!address || typeof address === 'string') throw new Error('Permission bridge did not bind'); return address.port; }
function closeServer(server: Server): Promise<void> { return new Promise((resolve) => { if (!server.listening) { resolve(); return; } server.close(() => resolve()); server.closeIdleConnections(); }); }
