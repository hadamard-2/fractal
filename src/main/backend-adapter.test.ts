import { describe, expect, test } from 'vitest';
import { createEchoAdapter, type AdapterStep } from '@/main/backend-adapter';

describe('echo adapter', () => {
  test('emits text deltas then a completed file-read work part', async () => {
    const steps: AdapterStep[] = [];
    const adapter = createEchoAdapter();
    await adapter.run({
      text: 'hello',
      emit: (s) => steps.push(s),
      requestPermission: () => Promise.resolve({ outcome: 'allow' }),
      signal: new AbortController().signal,
    });
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('work-start');
    expect(kinds).toContain('work-end');
    const start = steps.find((s) => s.kind === 'work-start');
    expect(start && start.kind === 'work-start' && start.part.kind).toBe('file-read');
  });

  test('stops early when the signal is already aborted', async () => {
    const steps: AdapterStep[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    await createEchoAdapter().run({
      text: 'x',
      emit: (s) => steps.push(s),
      requestPermission: () => Promise.resolve({ outcome: 'allow' }),
      signal: ctrl.signal,
    });
    expect(steps).toHaveLength(0);
  });
});
