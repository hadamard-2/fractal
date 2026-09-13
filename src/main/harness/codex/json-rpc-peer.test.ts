import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { JsonRpcPeer, type CodexProcess } from '@/main/harness/codex/json-rpc-peer';

class FakeCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  private nextWriteError: Error | undefined;
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.written.push(chunk.toString());
      const error = this.nextWriteError;
      this.nextWriteError = undefined;
      if (error) {
        queueMicrotask(() => callback(error));
        return;
      }
      callback();
    },
  });

  kill(): boolean {
    return true;
  }

  emitStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  exit(code: number | null): void {
    this.emit('exit', code);
  }

  failNextWrite(error = new Error('EPIPE')): void {
    this.nextWriteError = error;
  }
}

async function settledMessage(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error)),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
  ]);
}

describe('JsonRpcPeer', () => {
  test('correlates fragmented out-of-order responses and forwards notifications', async () => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    const notice = vi.fn();
    peer.onNotification(notice);

    const first = peer.request('thread/read', { threadId: 'one', includeTurns: true });
    const second = peer.request('thread/read', { threadId: 'two', includeTurns: true });
    process.emitStdout('{"id":2,"result":{"thread":{"id":"two"}}}\n{"method":"thread/status/changed",');
    process.emitStdout('"params":{"threadId":"one","status":{"type":"idle"}}}\n{"id":1,"result":{"thread":{"id":"one"}}}\n');

    await expect(first).resolves.toMatchObject({ thread: { id: 'one' } });
    await expect(second).resolves.toMatchObject({ thread: { id: 'two' } });
    expect(notice).toHaveBeenCalledOnce();
    expect(process.written).toEqual([
      '{"id":1,"method":"thread/read","params":{"threadId":"one","includeTurns":true}}\n',
      '{"id":2,"method":"thread/read","params":{"threadId":"two","includeTurns":true}}\n',
    ]);
  });

  test('keeps server requests separate, surfaces JSON-RPC errors, and rejects pending calls on exit', async () => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    const requests: unknown[] = [];
    const notices: unknown[] = [];
    peer.onServerRequest((request) => requests.push(request));
    peer.onNotification((notification) => notices.push(notification));

    process.emitStdout('{"id":90,"method":"item/commandExecution/requestApproval","params":{"threadId":"one"}}\n{"method":"thread/status/changed","params":{}}\n');
    expect(requests).toEqual([{ id: 90, method: 'item/commandExecution/requestApproval', params: { threadId: 'one' } }]);
    expect(notices).toEqual([{ method: 'thread/status/changed', params: {} }]);

    const rejected = peer.request('thread/list', {});
    process.emitStdout('{"id":1,"error":{"code":-32000,"message":"not ready"}}\n');
    await expect(rejected).rejects.toThrow('not ready');

    const pending = peer.request('thread/list', {});
    process.exit(1);
    await expect(pending).rejects.toThrow('Codex App Server exited');
  });

  test('fails pending requests when an asynchronous stdin write fails without an uncaught stream error', async () => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    process.failNextWrite();

    const pending = peer.request('thread/list', {});

    await expect(pending).rejects.toThrow('Codex App Server transport failed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.stdin.listenerCount('error')).toBe(0);
  });

  test('fails pending requests when stdout errors or terminates', async () => {
    const erroredProcess = new FakeCodexProcess();
    const erroredPeer = new JsonRpcPeer(erroredProcess);
    const errored = erroredPeer.request('thread/list', {});
    expect(() => erroredProcess.stdout.emit('error', new Error('broken pipe'))).not.toThrow();
    await expect(errored).rejects.toThrow('Codex App Server transport failed');

    const endedProcess = new FakeCodexProcess();
    const endedPeer = new JsonRpcPeer(endedProcess);
    const ended = endedPeer.request('thread/list', {});
    endedProcess.stdout.end();
    await expect(ended).rejects.toThrow('Codex App Server transport failed');
  });

  test('drains stderr without logging or retaining its contents', () => {
    const process = new FakeCodexProcess();
    new JsonRpcPeer(process);

    for (let index = 0; index < 20; index += 1) process.stderr.write(Buffer.alloc(512));

    expect(process.stderr.readableFlowing).toBe(true);
  });

  test.each([
    ['a response missing both result and error', '{"id":1}\n'],
    ['a response with a malformed JSON-RPC error', '{"id":1,"error":{"code":"bad","message":3}}\n'],
    ['an invalid JSON response', '{not json}\n'],
  ])('rejects every pending call on %s', async (_label, payload) => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    const first = peer.request('thread/list', {});
    const second = peer.request('thread/read', { threadId: 'one' });

    process.emitStdout(payload);

    await expect(settledMessage(first)).resolves.toBe('Codex App Server protocol failure');
    await expect(settledMessage(second)).resolves.toBe('Codex App Server protocol failure');
  });

  test('isolates throwing subscribers so later messages in the same batch still route', async () => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    peer.onNotification(() => {
      throw new Error('listener failed');
    });
    peer.onServerRequest(() => {
      throw new Error('listener failed');
    });
    const pending = peer.request('thread/list', {});

    expect(() => process.emitStdout('{"method":"thread/status/changed","params":{}}\n{"id":90,"method":"item/commandExecution/requestApproval","params":{}}\n{"id":1,"result":{"data":[]}}\n')).not.toThrow();
    await expect(pending).resolves.toEqual({ data: [] });
  });

  test('detaches every owned listener when closed', async () => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);

    peer.close();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(process.stdout.listenerCount('data')).toBe(0);
    expect(process.stdout.listenerCount('error')).toBe(0);
    expect(process.stdout.listenerCount('end')).toBe(0);
    expect(process.stdout.listenerCount('close')).toBe(0);
    expect(process.stdin.listenerCount('error')).toBe(0);
    expect(process.stderr.listenerCount('error')).toBe(0);
    expect(process.listenerCount('exit')).toBe(0);
    expect(process.listenerCount('error')).toBe(0);
  });

  test('keeps stdin failure handling alive until a late outstanding write settles', async () => {
    const process = new FakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    process.failNextWrite();
    const pending = peer.request('thread/list', {});
    const rejected = expect(pending).rejects.toThrow('Codex App Server is unavailable');

    peer.close();

    expect(process.stdin.listenerCount('error')).toBe(1);
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.stdin.listenerCount('error')).toBe(0);
  });
});
