import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { InitializeParams, InitializeResponse, ServerNotification, ServerRequest } from '@/main/harness/codex/generated';
import type { ThreadListParams } from '@/main/harness/codex/generated/v2/ThreadListParams';
import type { ThreadListResponse } from '@/main/harness/codex/generated/v2/ThreadListResponse';
import type { ThreadReadParams } from '@/main/harness/codex/generated/v2/ThreadReadParams';
import type { ThreadReadResponse } from '@/main/harness/codex/generated/v2/ThreadReadResponse';
import type { ThreadResumeParams } from '@/main/harness/codex/generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from '@/main/harness/codex/generated/v2/ThreadResumeResponse';
import type { ThreadStartParams } from '@/main/harness/codex/generated/v2/ThreadStartParams';
import type { ThreadStartResponse } from '@/main/harness/codex/generated/v2/ThreadStartResponse';
import type { TurnInterruptParams } from '@/main/harness/codex/generated/v2/TurnInterruptParams';
import type { TurnInterruptResponse } from '@/main/harness/codex/generated/v2/TurnInterruptResponse';
import type { TurnStartParams } from '@/main/harness/codex/generated/v2/TurnStartParams';
import type { TurnStartResponse } from '@/main/harness/codex/generated/v2/TurnStartResponse';
import { JsonRpcPeer, type CodexProcess, type JsonRpcNotification, type JsonRpcServerRequest, type Unsubscribe } from '@/main/harness/codex/json-rpc-peer';

export type { CodexProcess } from '@/main/harness/codex/json-rpc-peer';

export interface CodexRequestMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'thread/list': { params: ThreadListParams; result: ThreadListResponse };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export interface CodexAppServerStatus {
  availability: 'available' | 'unavailable';
  message?: string;
}

/** Owns one initialized Codex App Server process and its stdio protocol peer. */
export class CodexAppServer {
  private peer: JsonRpcPeer | undefined;
  private process: CodexProcess | undefined;
  private restarting: Promise<void> | undefined;
  private disposed = false;
  private readonly notificationListeners = new Set<(notification: ServerNotification) => void>();
  private readonly serverRequestListeners = new Set<(request: ServerRequest) => void>();
  status: CodexAppServerStatus = { availability: 'unavailable', message: 'Codex App Server has not started' };

  private constructor(private readonly spawnProcess: () => CodexProcess) {}

  static async start(spawnProcess: () => CodexProcess = spawnCodexProcess): Promise<CodexAppServer> {
    const server = new CodexAppServer(spawnProcess);
    await server.connect();
    return server;
  }

  request<M extends keyof CodexRequestMap>(method: M, params: CodexRequestMap[M]['params']): Promise<CodexRequestMap[M]['result']> {
    if (!this.peer || this.status.availability !== 'available') return Promise.reject(new Error('Codex App Server is unavailable'));
    return this.peer.request<CodexRequestMap[M]['result']>(method, params);
  }

  onNotification(listener: (notification: ServerNotification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: ServerRequest) => void): Unsubscribe {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  respond(id: number | string, result: unknown): void {
    this.requirePeer().respond(id, result);
  }

  respondError(id: number | string, code: number, message: string): void {
    this.requirePeer().respondError(id, code, message);
  }

  restart(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.restarting) {
      this.restarting = this.restartInternal().finally(() => {
        this.restarting = undefined;
      });
    }
    return this.restarting;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop('Codex App Server has been disposed');
  }

  private async restartInternal(): Promise<void> {
    this.stop('Codex App Server is restarting');
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    try {
      const process = this.spawnProcess();
      const peer = new JsonRpcPeer(process);
      this.process = process;
      this.peer = peer;
      peer.onClose((error) => this.markClosed(peer, error));
      peer.onNotification((notification) => {
        if (this.peer === peer && !this.disposed) this.forwardNotification(notification);
      });
      peer.onServerRequest((request) => {
        if (this.peer === peer && !this.disposed) this.forwardServerRequest(request);
      });

      await peer.request<InitializeResponse>('initialize', {
        clientInfo: { name: 'fractal', title: 'Fractal', version: app.getVersion() },
        capabilities: null,
      });
      if (this.disposed) {
        this.stop('Codex App Server has been disposed');
        return;
      }
      await peer.notify('initialized');
      if (!peer.isOpen || this.peer !== peer) throw new Error('Codex App Server transport failed');
      this.status = { availability: 'available' };
    } catch (error) {
      this.stop(unavailableMessage(error));
      this.status = { availability: 'unavailable', message: unavailableMessage(error) };
    }
  }

  private stop(message: string): void {
    const peer = this.peer;
    const process = this.process;
    this.peer = undefined;
    this.process = undefined;
    peer?.close(new Error(message));
    if (process) process.kill();
    this.status = { availability: 'unavailable', message };
  }

  private markClosed(peer: JsonRpcPeer, error: Error): void {
    if (this.peer !== peer) return;
    this.peer = undefined;
    const process = this.process;
    const exited = error.message.startsWith('Codex App Server exited');
    if (process && !exited) process.kill();
    if (this.process === process) this.process = undefined;
    this.status = { availability: 'unavailable', message: exited ? error.message : unavailableMessage(error) };
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer || this.status.availability !== 'available') throw new Error('Codex App Server is unavailable');
    return this.peer;
  }

  private forwardNotification(notification: JsonRpcNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(notification as ServerNotification);
      } catch {
        // A renderer subscriber must not interrupt native transport routing.
      }
    }
  }

  private forwardServerRequest(request: JsonRpcServerRequest): void {
    for (const listener of this.serverRequestListeners) {
      try {
        listener(request as ServerRequest);
      } catch {
        // A renderer subscriber must not interrupt native transport routing.
      }
    }
  }
}

function spawnCodexProcess(): CodexProcess {
  const process = spawn('codex', ['app-server', '--stdio'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  if (!process.stdin || !process.stdout || !process.stderr) {
    process.kill();
    throw new Error('Codex App Server did not provide piped stdio');
  }
  return process as CodexProcess;
}

function unavailableMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found/i.test(detail) ? 'Codex executable is unavailable' : `Codex App Server initialization failed: ${detail}`;
}
