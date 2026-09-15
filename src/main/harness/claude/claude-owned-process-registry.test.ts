import { describe, expect, test } from 'vitest';
import { ClaudeOwnedProcessRegistry } from './claude-owned-process-registry';

const ref = { provider: 'claude' as const, nativeSessionId: 'session-1', projectPath: '/work/fractal' };

describe('ClaudeOwnedProcessRegistry', () => {
  test('tracks the exact native conversation until its final owner releases it', () => {
    const registry = new ClaudeOwnedProcessRegistry();
    const first = registry.claim(ref);
    const second = registry.claim(ref);
    expect(registry.has(ref)).toBe(true);
    expect(registry.has({ ...ref, projectPath: '/work/other' })).toBe(false);
    first(); expect(registry.has(ref)).toBe(true);
    first(); expect(registry.has(ref)).toBe(true);
    second(); expect(registry.has(ref)).toBe(false);
  });
});
