import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';

export interface CodexProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number | string;
}

export type Unsubscribe = () => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

/** A compact NDJSON JSON-RPC peer for the Codex App Server stdio protocol. */
export class JsonRpcPeer {
  private readonly decoder = new NdjsonDecoder<unknown>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly serverRequestListeners = new Set<(request: JsonRpcServerRequest) => void>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly process: CodexProcess) {
    process.stdout.on('data', (chunk: Uint8Array) => this.read(chunk));
    process.once('exit', (code) => this.close(new Error(`Codex App Server exited${code === null ? '' : ` (code ${code})`}`)));
    process.once('error', (error) => this.close(error));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex App Server is unavailable'));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new Error('Codex App Server is unavailable');
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    if (this.closed) throw new Error('Codex App Server is unavailable');
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) throw new Error('Codex App Server is unavailable');
    this.write({ id, error: { code, message } });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: JsonRpcServerRequest) => void): Unsubscribe {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  close(error = new Error('Codex App Server is unavailable')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private read(chunk: Uint8Array): void {
    for (const decoded of this.decoder.push(chunk)) {
      if (decoded.ok) this.route(decoded.value);
    }
  }

  private route(message: unknown): void {
    if (!isRecord(message) || typeof message.method !== 'string') {
      this.routeResponse(message);
      return;
    }

    if (typeof message.id === 'number' || typeof message.id === 'string') {
      const request: JsonRpcServerRequest = { id: message.id, method: message.method, ...(hasOwn(message, 'params') ? { params: message.params } : {}) };
      for (const listener of this.serverRequestListeners) listener(request);
      return;
    }

    const notification: JsonRpcNotification = { method: message.method, ...(hasOwn(message, 'params') ? { params: message.params } : {}) };
    for (const listener of this.notificationListeners) listener(notification);
  }

  private routeResponse(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (isJsonRpcError(message.error)) {
      pending.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private write(message: object): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonRpcError(value: unknown): value is JsonRpcErrorPayload {
  return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
