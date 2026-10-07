import { describe, expect, test } from 'vitest';
import { parseChangesRequest } from './changes-contract';

describe('changes IPC contract', () => {
  test('accepts valid read requests', () => {
    expect(parseChangesRequest({ method: 'read', root: '/repo' })).toEqual({ method: 'read', root: '/repo' });
    expect(parseChangesRequest({ method: 'read', root: '/repo', fingerprint: 'abc' })).toEqual({
      method: 'read',
      root: '/repo',
      fingerprint: 'abc',
    });
  });

  test.each([
    { method: 'read', root: 'relative' },
    { method: 'read' },
    { method: 'unknown', root: '/repo' },
    { method: 'read', root: '/repo', extra: true },
    { method: 'read', root: '/repo', fingerprint: 7 },
    { method: 'read', root: '/repo', fingerprint: '' },
    { method: 'read', root: '/repo', fingerprint: 'x'.repeat(129) },
    [],
    Object.create({ method: 'read', root: '/repo' }) as unknown,
  ])('rejects malformed read request %#', (request) => {
    expect(() => parseChangesRequest(request)).toThrow('Invalid changes request');
  });
});
