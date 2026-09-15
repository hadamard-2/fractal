import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ClaudePermissionBridge, type ClaudePermissionToolInput } from './claude-permission-bridge';
import type { BlockingRequest, UserDecision } from '@/shared/conversation-contract';

const command: ClaudePermissionToolInput = {
  tool_name: 'Bash',
  tool_use_id: 'tool-1',
  input: { command: 'pnpm test' },
};
let tempDir: string;
beforeEach(async () => { tempDir = await mkdtemp(path.join(tmpdir(), 'fractal-claude-bridge-test-')); });
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

describe('ClaudePermissionBridge', () => {
  test('writes a private config and rejects wrong hosts, bearer secrets, and browser origins', async () => {
    const bridge = await ClaudePermissionBridge.start({ tempDir, onRequest: vi.fn() });
    try {
      expect((await stat(bridge.configPath)).mode & 0o777).toBe(0o600);
      const config = JSON.parse(await readFile(bridge.configPath, 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(config)).toContain(`127.0.0.1:${bridge.port}`);
      expect(JSON.stringify(config)).toContain(bridge.token);
      expect(Buffer.from(bridge.token, 'hex')).toHaveLength(32);

      await expect(call(bridge, command, { host: 'attacker.example' })).resolves.toMatchObject({ status: 403 });
      await expect(call(bridge, command, { host: `127.0.0.1:${bridge.port + 1}` })).resolves.toMatchObject({ status: 403 });
      await expect(call(bridge, command, { token: 'wrong' })).resolves.toMatchObject({ status: 401 });
      await expect(call(bridge, command, { origin: 'http://127.0.0.1' })).resolves.toMatchObject({ status: 403 });
    } finally {
      await bridge.dispose();
    }
    await expect(stat(bridge.configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('routes an approval once and returns only its explicit decision', async () => {
    const onRequest = vi.fn(async () => ({ kind: 'deny', reason: 'Not allowed' } as const));
    const bridge = await ClaudePermissionBridge.start({ tempDir, onRequest });
    try {
      const response = await callTool(bridge, command);
      expect(response).toEqual({ behavior: 'deny', message: 'Not allowed' });
      expect(onRequest).toHaveBeenCalledOnce();
      expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({
        id: 'tool-1', kind: 'approval', operation: 'pnpm test', provider: 'claude', status: 'open',
      }), expect.any(AbortSignal));
    } finally {
      await bridge.dispose();
    }
  });

  test('routes AskUserQuestion separately and returns renderer answers as updated input', async () => {
    const onRequest = vi.fn(async () => ({ kind: 'answer', answers: { deploy: 'Production' } } as const));
    const bridge = await ClaudePermissionBridge.start({ tempDir, onRequest });
    try {
      const input: ClaudePermissionToolInput = {
        tool_name: 'AskUserQuestion', tool_use_id: 'question-1',
        input: { questions: [{ question: 'Where?', header: 'deploy', options: [{ label: 'Production', description: 'Live' }], multiSelect: false }] },
      };
      await expect(callTool(bridge, input)).resolves.toEqual({
        behavior: 'allow', updatedInput: { ...input.input, answers: { deploy: 'Production' } },
      });
      expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question', fieldId: 'deploy', prompt: 'Where?' }), expect.any(AbortSignal));
    } finally {
      await bridge.dispose();
    }
  });

  test('denies malformed, oversized, timed-out, disconnected, and disposed work', async () => {
    const onRequest = vi.fn((_request: BlockingRequest, signal: AbortSignal): Promise<UserDecision> => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ kind: 'deny' }), { once: true })));
    const bridge = await ClaudePermissionBridge.start({ tempDir, onRequest, timeoutMs: 10 });
    try {
      await expect(callTool(bridge, command)).resolves.toEqual({ behavior: 'deny', message: 'Permission request timed out' });
      await expect(callTool(bridge, { tool_name: 'Bash' } as unknown as ClaudePermissionToolInput)).resolves.toEqual({ behavior: 'deny', message: 'Invalid permission request' });
      await expect(callTool(bridge, { ...command, input: { command: 42 } } as unknown as ClaudePermissionToolInput)).resolves.toEqual({ behavior: 'deny', message: 'Invalid permission request' });
      await expect(callRaw(bridge, 'x'.repeat(65 * 1024))).resolves.toMatchObject({ status: 413 });

    } finally {
      await bridge.dispose();
    }

    const disposalBridge = await ClaudePermissionBridge.start({ tempDir, onRequest, timeoutMs: 10_000 });
    const pending = callTool(disposalBridge, { ...command, tool_use_id: 'tool-disposed' });
    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2), { interval: 1, timeout: 1_000 });
    await disposalBridge.dispose();
    await expect(pending).resolves.toEqual({ behavior: 'deny', message: 'Permission bridge closed' });
  });

  test('cancels renderer routing when the MCP client disconnects', async () => {
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
    const onRequest = vi.fn((_request: BlockingRequest, signal: AbortSignal): Promise<UserDecision> => new Promise((resolve) => {
      signal.addEventListener('abort', () => { observedAbort(); resolve({ kind: 'deny', reason: 'disconnected' }); }, { once: true });
    }));
    const bridge = await ClaudePermissionBridge.start({ tempDir, onRequest, timeoutMs: 10_000 });
    try {
      const controller = new AbortController();
      const pending = callTool(bridge, { ...command, tool_use_id: 'disconnect' }, controller.signal);
      await vi.waitFor(() => expect(onRequest).toHaveBeenCalledOnce(), { interval: 1, timeout: 1_000 });
      controller.abort();
      await expect(pending).rejects.toThrow();
      await expect(aborted).resolves.toBeUndefined();
    } finally { await bridge.dispose(); }
  });
});

async function callTool(bridge: ClaudePermissionBridge, input: ClaudePermissionToolInput, signal?: AbortSignal): Promise<unknown> {
  const initialize = await rpc(bridge, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  expect(initialize.status).toBe(200);
  const response = await rpc(bridge, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: bridge.mcpToolName, arguments: input } }, {}, signal);
  const document = await rpcDocument(response) as { result?: { content?: Array<{ text?: string }> } };
  return JSON.parse(document.result?.content?.[0]?.text ?? 'null');
}

async function call(bridge: ClaudePermissionBridge, input: ClaudePermissionToolInput, headers: { host?: string; token?: string; origin?: string }): Promise<Response> {
  void input;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: bridge.port, path: '/mcp', method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', host: headers.host ?? `127.0.0.1:${bridge.port}`,
      authorization: `Bearer ${headers.token ?? bridge.token}`, 'content-length': Buffer.byteLength(body),
      ...(headers.origin ? { origin: headers.origin } : {}),
    } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as Record<string, string> })));
    });
    request.once('error', reject); request.end(body);
  });
}

async function rpcDocument(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6) ?? text;
  return JSON.parse(data);
}

async function rpc(bridge: ClaudePermissionBridge, body: unknown, headers: { host?: string; token?: string; origin?: string } = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(bridge.url, {
    method: 'POST', body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', host: headers.host ?? `127.0.0.1:${bridge.port}`,
      authorization: `Bearer ${headers.token ?? bridge.token}`,
      ...(headers.origin ? { origin: headers.origin } : {}),
    }, signal,
  });
}

async function callRaw(bridge: ClaudePermissionBridge, body: string): Promise<Response> {
  return fetch(bridge.url, { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: `127.0.0.1:${bridge.port}`, authorization: `Bearer ${bridge.token}` } });
}
