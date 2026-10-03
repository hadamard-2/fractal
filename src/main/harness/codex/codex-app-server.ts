import { spawn } from 'node:child_process';
import { executableNotFoundMessage } from '@/main/harness/executable';
import { app } from 'electron';
import type { InitializeParams, InitializeResponse, ServerNotification, ServerRequest } from '@/main/harness/codex/generated';
import type { ThreadListParams } from '@/main/harness/codex/generated/v2/ThreadListParams';
import type { ThreadListResponse } from '@/main/harness/codex/generated/v2/ThreadListResponse';
import type { ThreadReadParams } from '@/main/harness/codex/generated/v2/ThreadReadParams';
import type { ThreadReadResponse } from '@/main/harness/codex/generated/v2/ThreadReadResponse';
import type { ThreadSetNameParams } from '@/main/harness/codex/generated/v2/ThreadSetNameParams';
import type { ThreadSetNameResponse } from '@/main/harness/codex/generated/v2/ThreadSetNameResponse';
import type { ThreadResumeParams } from '@/main/harness/codex/generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from '@/main/harness/codex/generated/v2/ThreadResumeResponse';
import type { ModelListParams } from '@/main/harness/codex/generated/v2/ModelListParams';
import type { ModelListResponse } from '@/main/harness/codex/generated/v2/ModelListResponse';
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
  'model/list': { params: ModelListParams; result: ModelListResponse };
  'thread/name/set': { params: ThreadSetNameParams; result: ThreadSetNameResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export interface CodexAppServerStatus {
  availability: 'available' | 'unavailable';
  message?: string;
}

const STARTUP_CANCELLED = 'Codex App Server startup cancelled';

/** Owns one initialized Codex App Server process and its stdio protocol peer. */
export class CodexAppServer {
  private peer: JsonRpcPeer | undefined;
  private process: CodexProcess | undefined;
  private restarting: Promise<void> | undefined;
  private disposed = false;
  private readonly notificationListeners = new Set<(notification: ServerNotification) => void>();
  private readonly serverRequestListeners = new Set<(request: ServerRequest) => void>();
  private readonly statusListeners = new Set<(status: CodexAppServerStatus) => void>();
  status: CodexAppServerStatus = { availability: 'unavailable', message: 'Codex App Server has not started' };

  private constructor(private readonly spawnProcess: () => CodexProcess) {}

  static async start(spawnProcess: () => CodexProcess = codexSpawner('codex'), signal?: AbortSignal): Promise<CodexAppServer> {
    if (signal?.aborted) throw new Error(STARTUP_CANCELLED);
    const server = new CodexAppServer(spawnProcess);
    if (!signal) { await server.connect(); return server; }
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const abort = () => {
      server.disposed = true;
      try { server.stop(STARTUP_CANCELLED); }
      catch { /* Cancellation never exposes a process-termination error. */ }
      rejectCancelled(new Error(STARTUP_CANCELLED));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Closing the peer rejects initialize, but a held readiness write may
      // never call back. Cancellation must also settle the public startup.
      await Promise.race([server.connect(), cancelled]);
      if (signal.aborted) throw new Error(STARTUP_CANCELLED);
      return server;
    } finally {
      signal.removeEventListener('abort', abort);
    }
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

  onStatus(listener: (status: CodexAppServerStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
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
      this.process = process;
      // A spawn implementation can trigger cancellation before returning.
      if (this.disposed) { this.stop(STARTUP_CANCELLED); return; }
      const peer = new JsonRpcPeer(process);
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
      this.setStatus({ availability: 'available' });
    } catch (error) {
      this.stop(unavailableMessage(error));
      this.setStatus({ availability: 'unavailable', message: unavailableMessage(error) });
    }
  }

  private stop(message: string): void {
    const peer = this.peer;
    const process = this.process;
    this.peer = undefined;
    this.process = undefined;
    peer?.close(new Error(message));
    if (process) terminateProcess(process);
    this.setStatus({ availability: 'unavailable', message });
  }

  private markClosed(peer: JsonRpcPeer, error: Error): void {
    if (this.peer !== peer) return;
    this.peer = undefined;
    const process = this.process;
    this.process = undefined;
    const exited = error.message.startsWith('Codex App Server exited');
    if (process && !exited) terminateProcess(process);
    this.setStatus({ availability: 'unavailable', message: exited ? error.message : unavailableMessage(error) });
    // A missing executable won't appear within the retry window; retrying
    // would only replace the status that names it with a generic one.
    if (!this.disposed && !this.restarting && !isMissingExecutable(error)) {
      this.restarting = this.reconnectAfterExit().finally(() => { this.restarting = undefined; });
    }
  }

  private async reconnectAfterExit(): Promise<void> {
    for (const delay of [250, 1_000, 3_000]) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (this.disposed) return;
      await this.connect();
      if (this.status.availability === 'available') return;
    }
    this.setStatus({ availability: 'unavailable', message: 'Codex App Server reconnect failed after 3 attempts' });
  }

  private setStatus(status: CodexAppServerStatus): void {
    if (this.status.availability === status.availability && this.status.message === status.message) return;
    this.status = status;
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* Status observers are isolated. */ }
    }
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

function terminateProcess(process: CodexProcess): void {
  // spawn errors can arrive after cancellation has detached the protocol
  // peer. Retain a terminal error guard until error/exit finishes the child.
  const release = () => {
    process.removeListener('error', release);
    process.removeListener('exit', release);
  };
  process.once('error', release);
  process.once('exit', release);
  try { process.kill(); } catch (error) { release(); throw error; }
}

/** Launches `executable app-server --stdio`; the executable is a bare name looked up on PATH or a path. */
export function codexSpawner(executable: string): () => CodexProcess {
  return () => {
    const process = spawn(executable, ['app-server', '--stdio'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!process.stdin || !process.stdout || !process.stderr) {
      process.kill();
      throw new Error('Codex App Server did not provide piped stdio');
    }
    return process as CodexProcess;
  };
}

function isMissingExecutable(error: unknown): boolean {
  return /ENOENT|not found/i.test(error instanceof Error ? error.message : String(error));
}

function unavailableMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (!isMissingExecutable(error)) return `Codex App Server initialization failed: ${detail}`;
  // Node's spawn errors carry the executable they tried as `path`.
  const attempted = (error as { path?: unknown }).path;
  return executableNotFoundMessage(typeof attempted === 'string' ? attempted : 'codex');
}
