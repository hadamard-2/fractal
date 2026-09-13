import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { CodexAppServer, type CodexProcess } from '@/main/harness/codex/codex-app-server';

vi.mock('electron', () => ({ app: { getVersion: () => '1.2.3' } }));

class FakeCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killCalls = 0;
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.written.push(chunk.toString());
      callback();
    },
  });

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  exit(code: number | null): void {
    this.emit('exit', code);
  }
}

function initialize(process: FakeCodexProcess): void {
  expect(process.written).toEqual([
    '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"fractal","title":"Fractal","version":"1.2.3"},"capabilities":null}}\n',
  ]);
  process.respond(1, { userAgent: 'codex' });
}

describe('CodexAppServer', () => {
  test('initializes before notifying readiness and forwards typed traffic', async () => {
    const process = new FakeCodexProcess();
    const starting = CodexAppServer.start(() => process);
    initialize(process);
    const server = await starting;

    expect(process.written).toEqual([
      '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"fractal","title":"Fractal","version":"1.2.3"},"capabilities":null}}\n',
      '{"method":"initialized"}\n',
    ]);
    const notification = vi.fn();
    const serverRequest = vi.fn();
    server.onNotification(notification);
    server.onServerRequest(serverRequest);
    process.stdout.write('{"method":"thread/status/changed","params":{"threadId":"one"}}\n{"id":8,"method":"item/commandExecution/requestApproval","params":{"threadId":"one"}}\n');
    expect(notification).toHaveBeenCalledWith({ method: 'thread/status/changed', params: { threadId: 'one' } });
    expect(serverRequest).toHaveBeenCalledWith({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'one' } });

    const reading = server.request('thread/read', { threadId: 'one', includeTurns: true });
    process.respond(2, { thread: { id: 'one' } });
    await expect(reading).resolves.toMatchObject({ thread: { id: 'one' } });
  });

  test('serializes restarts, disposes once, and makes new requests unavailable', async () => {
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const starting = CodexAppServer.start(spawn);
    initialize(first);
    const server = await starting;

    const restartA = server.restart();
    const restartB = server.restart();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(first.killCalls).toBe(1);
    initialize(second);
    await Promise.all([restartA, restartB]);

    await server.dispose();
    await server.dispose();
    expect(second.killCalls).toBe(1);
    await expect(server.request('thread/list', {})).rejects.toThrow('unavailable');
  });

  test('reports an unavailable executable without throwing away the status', async () => {
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const server = await CodexAppServer.start(() => {
      throw missing;
    });

    expect(server.status).toMatchObject({ availability: 'unavailable', message: expect.stringContaining('Codex executable') });
  });

  test('becomes unavailable when an initialized process exits', async () => {
    const process = new FakeCodexProcess();
    const starting = CodexAppServer.start(() => process);
    initialize(process);
    const server = await starting;

    process.exit(1);

    expect(server.status).toMatchObject({ availability: 'unavailable', message: expect.stringContaining('exited') });
    await expect(server.request('thread/list', {})).rejects.toThrow('unavailable');
  });
});
