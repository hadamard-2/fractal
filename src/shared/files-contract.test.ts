import { describe, expect, test } from 'vitest';
import { parseFilesEvent, parseFilesRequest } from './files-contract';

describe('files IPC contract', () => {
  test('accepts each valid request', () => {
    expect(parseFilesRequest({ method: 'listDirectory', root: '/repo', path: '' })).toEqual({ method: 'listDirectory', root: '/repo', path: '' });
    expect(parseFilesRequest({ method: 'readFile', root: '/repo', path: 'src/a.ts' })).toEqual({ method: 'readFile', root: '/repo', path: 'src/a.ts' });
    expect(parseFilesRequest({ method: 'listFiles', root: '/repo' })).toEqual({ method: 'listFiles', root: '/repo' });
    expect(parseFilesRequest({ method: 'watch', watchId: 'w1', root: '/repo', path: 'src' })).toEqual({ method: 'watch', watchId: 'w1', root: '/repo', path: 'src' });
    expect(parseFilesRequest({ method: 'unwatch', watchId: 'w1' })).toEqual({ method: 'unwatch', watchId: 'w1' });
    expect(parseFilesRequest({ method: 'editors' })).toEqual({ method: 'editors' });
    expect(parseFilesRequest({ method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 12 })).toEqual({ method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 12 });
    expect(parseFilesRequest({ method: 'open', action: 'reveal', root: '/repo', path: 'a.ts', line: undefined })).toEqual({ method: 'open', action: 'reveal', root: '/repo', path: 'a.ts' });
  });

  test.each([
    { method: 'listDirectory', root: 'relative', path: '' },
    { method: 'listDirectory', root: '/repo', path: '/etc' },
    { method: 'listDirectory', root: '/repo', path: '\\\\server\\share' },
    { method: 'listDirectory', root: '/repo', path: 'C:\\x' },
    { method: 'listDirectory', root: '/repo', path: 'a\0b' },
    { method: 'listDirectory', root: '/repo', path: 'x'.repeat(4097) },
    { method: 'readFile', root: '/repo', path: '' },
    { method: 'readFile', root: '/repo', path: 'a.ts', extra: true },
    { method: 'watch', watchId: '', root: '/repo', path: '' },
    { method: 'unwatch', watchId: 'x'.repeat(129) },
    { method: 'open', action: 'emacs', root: '/repo', path: 'a.ts' },
    { method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 0 },
    { method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 1.5 },
    { method: 'unknown' },
    null,
    [],
  ])('rejects malformed request %#', (request) => {
    expect(() => parseFilesRequest(request)).toThrow('Invalid files request');
  });

  test('parses change events, strips extra fields, and rejects anything else', () => {
    expect(parseFilesEvent({ type: 'changed', watchId: 'w1', extra: 1 })).toEqual({ type: 'changed', watchId: 'w1' });
    expect(() => parseFilesEvent({ type: 'changed', watchId: 7 })).toThrow('Invalid files event');
    expect(() => parseFilesEvent({ type: 'other', watchId: 'w1' })).toThrow('Invalid files event');
  });
});
