import { describe, expect, test } from 'vitest';
import { parseTerminalEvent, parseTerminalRequest } from './terminal-contract';

describe('terminal IPC contract', () => {
  test('accepts a valid create request and strips extra event fields', () => {
    expect(parseTerminalRequest({ method: 'create', id: 'one', cwd: '/repo', cols: 80, rows: 24 })).toEqual({ method: 'create', id: 'one', cwd: '/repo', cols: 80, rows: 24 });
    expect(parseTerminalEvent({ type: 'data', id: 'one', data: 'ready', privateField: 'secret' })).toEqual({ type: 'data', id: 'one', data: 'ready' });
  });

  test.each([
    { method: 'create', id: '', cwd: '/repo', cols: 80, rows: 24 },
    { method: 'create', id: 'one', cols: 80, rows: 24 },
    { method: 'create', id: 'one', cwd: 'relative', cols: 80, rows: 24 },
    { method: 'create', id: 'one', cwd: '/repo', cols: 0, rows: 24 },
    { method: 'create', id: 'one', cwd: '/repo', cols: NaN, rows: 24 },
    { method: 'create', id: 'one', cwd: '/repo', cols: 501, rows: 24 },
    { method: 'create', id: 'one', cwd: '/repo', cols: 80, rows: 301 },
    { method: 'create', id: 'one', cwd: '/repo', cols: 80, rows: 24, extra: true },
    { method: 'write', id: 'one', data: 'x'.repeat(1_048_577) },
    { method: 'unknown', id: 'one' },
  ])('rejects malformed request %#', (request) => {
    expect(() => parseTerminalRequest(request)).toThrow('Invalid terminal request');
  });

  test('rejects malformed events and preserves exit codes', () => {
    expect(() => parseTerminalEvent({ type: 'data', id: 'one', data: 42 })).toThrow('Invalid terminal event');
    expect(parseTerminalEvent({ type: 'exit', id: 'one', exitCode: 130 })).toEqual({ type: 'exit', id: 'one', exitCode: 130 });
  });
});
