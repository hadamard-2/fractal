import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { JsonRpcPeer, type CodexProcess } from '@/main/harness/codex/json-rpc-peer';

class FakeCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.written.push(chunk.toString());
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
});
