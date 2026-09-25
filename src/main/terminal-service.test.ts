import { describe, expect, test, vi } from 'vitest';
import { TerminalService, selectShell, type PtyLike } from './terminal-service';
import type { TerminalEvent } from '@/shared/terminal-contract';

function fixture() {
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number }) => void) | undefined;
  const pty: PtyLike = {
    onData: (listener) => { dataListener = listener; return { dispose: () => { dataListener = undefined; } }; },
    onExit: (listener) => { exitListener = listener; return { dispose: () => { exitListener = undefined; } }; },
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  };
  const factory = vi.fn(() => pty);
  const events: TerminalEvent[] = [];
  return { pty, factory, events, emitData: (text: string) => dataListener?.(text), emitExit: (code: number) => exitListener?.({ exitCode: code }) };
}

describe('TerminalService', () => {
  test('routes input and output only to the owner and closes idempotently', () => {
    const f = fixture();
    const service = new TerminalService(f.factory);
    const owner = {}, stranger = {};
    service.create(owner, { id: 'one', cols: 80, rows: 24 }, '/repo', (event) => f.events.push(event));
    expect(f.factory).toHaveBeenCalledWith(expect.any(String), '/repo', 80, 24);
    expect(() => service.write(stranger, 'one', 'pwd\r')).toThrow();
    expect(() => service.close(stranger, 'one')).toThrow();
    service.write(owner, 'one', 'pwd\r');
    service.resize(owner, 'one', 100, 30);
    f.emitData('hello');
    expect(f.pty.write).toHaveBeenCalledWith('pwd\r');
    expect(f.pty.resize).toHaveBeenCalledWith(100, 30);
    expect(f.events).toEqual([{ type: 'data', id: 'one', data: 'hello' }]);
    service.close(owner, 'one'); service.close(owner, 'one');
    expect(f.pty.kill).toHaveBeenCalledTimes(1);
    expect(() => service.write(owner, 'one', 'later')).toThrow();
  });

  test('removes a naturally exited shell without duplicate exit or kill', () => {
    const f = fixture();
    const service = new TerminalService(f.factory);
    const owner = {};
    service.create(owner, { id: 'one', cols: 80, rows: 24 }, '/repo', (event) => f.events.push(event));
    f.emitExit(130);
    service.close(owner, 'one');
    f.emitExit(130);
    expect(f.events).toEqual([{ type: 'exit', id: 'one', exitCode: 130 }]);
    expect(f.pty.kill).not.toHaveBeenCalled();
  });

  test('rejects duplicate IDs and ends every process for a released owner', () => {
    const f = fixture();
    const service = new TerminalService(f.factory);
    const owner = {};
    service.create(owner, { id: 'one', cols: 80, rows: 24 }, '/repo', () => undefined);
    expect(() => service.create(owner, { id: 'one', cols: 80, rows: 24 }, '/repo', () => undefined)).toThrow();
    service.closeOwner(owner);
    expect(f.pty.kill).toHaveBeenCalledTimes(1);
  });

  test('uses platform shell defaults when environment has no shell', () => {
    expect(selectShell('win32', {})).toBe('cmd.exe');
    expect(selectShell('linux', {})).toBe('/bin/sh');
    expect(selectShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});
