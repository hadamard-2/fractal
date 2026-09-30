// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ConversationApi,
  ConversationStreamEvent,
  HarnessStatus,
  ProjectConversationGroup,
} from '@/shared/conversation-contract';
import { useConversationHistory } from './use-conversation-history';

type History = Awaited<ReturnType<ConversationApi['list']>>;

const projects: ProjectConversationGroup[] = [
  {
    projectPath: '/work/fractal',
    displayName: 'Fractal',
    conversations: [
      {
        ref: {
          provider: 'claude',
          nativeSessionId: 'claude-session-1',
          projectPath: '/work/fractal',
        },
        title: 'Fix parser',
        updatedAt: 1,
        runtime: 'idle',
        captureCompleteness: 'complete',
      },
    ],
  },
];

const providers: HarnessStatus[] = [
  {
    provider: 'claude',
    availability: 'available',
    capabilities: {
      create: false,
      partialStreaming: false,
      approvals: false,
      questions: false,
      interrupt: false,
      steerWhileRunning: false,
      fork: false,
    },
  },
];

const refreshedProjects: ProjectConversationGroup[] = [{
  ...projects[0],
  conversations: [{ ...projects[0].conversations[0], title: 'Fix parser again' }],
}];

function summaryUpdated(): ConversationStreamEvent {
  return {
    loadId: '00000000-0000-4000-8000-000000000000',
    seq: 1,
    ref: projects[0].conversations[0].ref,
    type: 'summary.updated',
    summary: projects[0].conversations[0],
  };
}

function installConversations(
  list: ConversationApi['list'],
  onEvent = vi.fn<ConversationApi['onEvent']>(() => vi.fn())
) {
  Object.defineProperty(window, 'fractal', {
    configurable: true,
    value: { conversations: { list, onEvent } },
  });
  return onEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'fractal');
});

describe('useConversationHistory', () => {
  test('loads the project groups and provider statuses exposed by the native bridge', async () => {
    installConversations(vi.fn().mockResolvedValue({ projects, providers }));

    const { result, unmount } = renderHook(() => useConversationHistory());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects).toEqual(projects);
    expect(result.current.providers).toEqual(providers);
    expect(result.current.error).toBeNull();
    unmount();
  });

  test('unsubscribes and ignores a list completion after unmount', async () => {
    let resolveList: ((value: History) => void) | undefined;
    const unsubscribe = vi.fn();
    const onEvent = vi.fn<ConversationApi['onEvent']>(() => unsubscribe);
    installConversations(vi.fn<ConversationApi['list']>(() => new Promise<History>((resolve) => { resolveList = resolve; })), onEvent);

    const { result, unmount } = renderHook(() => useConversationHistory());
    unmount();
    if (!resolveList) throw new Error('List request did not start');
    await act(async () => resolveList({ projects, providers }));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.projects).toEqual([]);
  });

  test('ignores out-of-order successful and failed refreshes', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    let resolveInitial: ((value: History) => void) | undefined;
    let rejectSecond: ((reason: Error) => void) | undefined;
    const list = vi.fn<ConversationApi['list']>()
      .mockImplementationOnce(() => new Promise<History>((resolve) => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectSecond = reject; }))
      .mockResolvedValueOnce({ projects: refreshedProjects, providers });
    installConversations(list, vi.fn((nextListener) => {
      listener = nextListener;
      return vi.fn();
    }));

    const { result, unmount } = renderHook(() => useConversationHistory());
    act(() => listener?.(summaryUpdated()));
    act(() => listener?.(summaryUpdated()));
    await waitFor(() => expect(result.current.projects).toEqual(refreshedProjects));

    if (!resolveInitial || !rejectSecond) throw new Error('Refresh requests did not start');
    await act(async () => resolveInitial({ projects, providers }));
    await act(async () => rejectSecond(new Error('Stale failure')));

    expect(result.current.projects).toEqual(refreshedProjects);
    expect(result.current.error).toBeNull();
    unmount();
  });

  test('retains the last successful groups through refresh failure and recovers loading and error state', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const list = vi.fn<ConversationApi['list']>()
      .mockResolvedValueOnce({ projects, providers })
      .mockRejectedValueOnce(new Error('Native history unavailable'))
      .mockResolvedValueOnce({ projects: refreshedProjects, providers });
    installConversations(list, vi.fn((nextListener) => {
      listener = nextListener;
      return vi.fn();
    }));

    const { result, unmount } = renderHook(() => useConversationHistory());
    await waitFor(() => expect(result.current.projects).toEqual(projects));
    act(() => listener?.(summaryUpdated()));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.error?.message).toBe('Native history unavailable'));
    expect(result.current.projects).toEqual(projects);

    await act(async () => result.current.refresh());
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.projects).toEqual(refreshedProjects);
    unmount();
  });

  test('reports loaded once the first list settles and keeps it through later refreshes', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    let resolveFirst!: (history: History) => void;
    const list = vi.fn<ConversationApi['list']>()
      .mockReturnValueOnce(new Promise<History>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<History>(() => undefined));
    installConversations(list, vi.fn((nextListener) => {
      listener = nextListener;
      return vi.fn();
    }));

    const { result, unmount } = renderHook(() => useConversationHistory());
    expect(result.current.loaded).toBe(false);
    await act(async () => resolveFirst({ projects, providers }));
    expect(result.current.loaded).toBe(true);
    act(() => listener?.(summaryUpdated()));
    expect(result.current.loading).toBe(true);
    expect(result.current.loaded).toBe(true);
    unmount();
  });

  test('counts a failed first list as loaded, so waiting UI gives way to the error', async () => {
    installConversations(vi.fn<ConversationApi['list']>().mockRejectedValueOnce(new Error('down')), vi.fn(() => vi.fn()));
    const { result, unmount } = renderHook(() => useConversationHistory());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error?.message).toBe('down');
    unmount();
  });
});
