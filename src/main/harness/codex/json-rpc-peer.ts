import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';

export interface CodexProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

export interface JsonRpcNotification { method: string; params?: unknown; }
export interface JsonRpcServerRequest extends JsonRpcNotification { id: number | string; }
export type Unsubscribe = () => void;
interface PendingRequest { resolve: (result: unknown) => void; reject: (error: Error) => void; }
interface JsonRpcErrorPayload { code: number; message: string; data?: unknown; }

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
  private readonly closeListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private closed = false;
  private readonly onStdoutData = (chunk: Uint8Array): void => this.read(chunk);
  private readonly onStdoutFailure = (): void => this.failTransport();
  private readonly onStdinFailure = (): void => this.failTransport();
  private readonly onStderrFailure = (): void => this.failTransport();
  private readonly onProcessExit = (code: number | null): void => this.close(new Error(`Codex App Server exited${code === null ? '' : ` (code ${code})`}`));
  private readonly onProcessFailure = (): void => this.failTransport();

  constructor(private readonly process: CodexProcess) {
    process.stdout.on('data', this.onStdoutData);
    process.stdout.once('error', this.onStdoutFailure);
    process.stdout.once('end', this.onStdoutFailure);
    process.stdout.once('close', this.onStdoutFailure);
    process.stdin.once('error', this.onStdinFailure);
    process.stderr.once('error', this.onStderrFailure);
    process.stderr.resume();
    process.once('exit', this.onProcessExit);
    process.once('error', this.onProcessFailure);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex App Server is unavailable'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new Error('Codex App Server is unavailable');
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void { this.requireOpen(); this.write({ id, result }); }
  respondError(id: number | string, code: number, message: string): void { this.requireOpen(); this.write({ id, error: { code, message } }); }

  onNotification(listener: (notification: JsonRpcNotification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(listener: (request: JsonRpcServerRequest) => void): Unsubscribe {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(error = new Error('Codex App Server is unavailable')): void {
    if (this.closed) return;
    this.closed = true;
    this.detachListeners();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emitListeners(this.closeListeners, error);
    this.closeListeners.clear();
    this.notificationListeners.clear();
    this.serverRequestListeners.clear();
  }

  private read(chunk: Uint8Array): void {
    if (this.closed) return;
    for (const decoded of this.decoder.push(chunk)) {
      if (!decoded.ok) return this.failProtocol();
      this.route(decoded.value);
      if (this.closed) return;
    }
  }

  private route(message: unknown): void {
    if (!isRecord(message)) return this.failProtocol();
    if (typeof message.method === 'string') {
      if (hasOwn(message, 'id')) {
        if (typeof message.id !== 'number' && typeof message.id !== 'string') return this.failProtocol();
        this.emitListeners(this.serverRequestListeners, { id: message.id, method: message.method, ...(hasOwn(message, 'params') ? { params: message.params } : {}) });
        return;
      }
      this.emitListeners(this.notificationListeners, { method: message.method, ...(hasOwn(message, 'params') ? { params: message.params } : {}) });
      return;
    }
    this.routeResponse(message);
  }

  private routeResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return this.failProtocol();
    const hasResult = hasOwn(message, 'result');
    const hasError = hasOwn(message, 'error');
    if (hasResult === hasError || (hasError && !isJsonRpcError(message.error))) return this.failProtocol();
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (hasError) {
      const error = message.error as JsonRpcErrorPayload;
      pending.reject(new JsonRpcError(error.code, error.message, error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private write(message: object): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error || this.closed) return;
        const ignoreLateWriteError = (): void => undefined;
        this.process.stdin.once('error', ignoreLateWriteError);
        setImmediate(() => this.process.stdin.removeListener('error', ignoreLateWriteError));
        this.failTransport();
      });
    } catch {
      this.failTransport();
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Codex App Server is unavailable');
  }

  private failTransport(): void { this.close(new Error('Codex App Server transport failed')); }
  private failProtocol(): void { this.close(new Error('Codex App Server protocol failure')); }

  private detachListeners(): void {
    this.process.stdout.removeListener('data', this.onStdoutData);
    this.process.stdout.removeListener('error', this.onStdoutFailure);
    this.process.stdout.removeListener('end', this.onStdoutFailure);
    this.process.stdout.removeListener('close', this.onStdoutFailure);
    this.process.stdin.removeListener('error', this.onStdinFailure);
    this.process.stderr.removeListener('error', this.onStderrFailure);
    this.process.removeListener('exit', this.onProcessExit);
    this.process.removeListener('error', this.onProcessFailure);
  }

  private emitListeners<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try { listener(value); } catch { /* subscriber failures must not interrupt transport routing */ }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function isJsonRpcError(value: unknown): value is JsonRpcErrorPayload { return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string'; }
