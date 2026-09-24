// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useSidebarOrder } from './use-sidebar-order';
import type { ProjectConversationGroup } from '@/shared/conversation-contract';
import type { FractalSettings } from '@/shared/settings-contract';

const group = (projectPath: string, ids: string[]): ProjectConversationGroup => ({
  projectPath,
  displayName: projectPath,
  conversations: ids.map((nativeSessionId, index) => ({
    ref: { provider: 'codex', nativeSessionId, projectPath },
    title: nativeSessionId,
    updatedAt: ids.length - index,
    runtime: 'idle',
    captureCompleteness: 'complete',
  })),
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('persists drag order and keeps new native items ahead of that order on refresh', async () => {
  const settings: FractalSettings = { theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: { projects: [], chatsByProject: {} } };
  const set = vi.fn(async (patch: Partial<FractalSettings>) => ({ ...settings, ...patch }));
  Object.defineProperty(window, 'fractal', { configurable: true, value: { settings: { get: async () => settings, set } } });
  const initial = [group('/a', ['newer', 'older']), group('/b', ['other'])];
  const { result, rerender } = renderHook(({ projects }) => useSidebarOrder(projects), { initialProps: { projects: initial } });
  await waitFor(() => expect(result.current.ready).toBe(true));

  act(() => result.current.moveProject('/b', '/a'));
  act(() => result.current.moveChat('/a', 'codex:older', 'codex:newer'));
  await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
  expect(set.mock.calls[1][0].sidebarOrder).toEqual({ projects: ['/b', '/a'], chatsByProject: { '/a': ['codex:older', 'codex:newer'] } });

  rerender({ projects: [group('/fresh', ['first']), group('/a', ['brand-new', 'newer', 'older']), group('/b', ['other'])] });
  expect(result.current.orderedProjects.map((item) => item.projectPath)).toEqual(['/fresh', '/b', '/a']);
  expect(result.current.orderedProjects[2].conversations.map((item) => item.title)).toEqual(['brand-new', 'older', 'newer']);
});
