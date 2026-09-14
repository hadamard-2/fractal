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

function installConversations(
  list: ConversationApi['list'],
  onEvent = vi.fn<ConversationApi['onEvent']>()
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

    const { result } = renderHook(() => useConversationHistory());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects).toEqual(projects);
    expect(result.current.providers).toEqual(providers);
    expect(result.current.error).toBeNull();
  });

  test('refreshes on a summary update and retains prior history if that refresh fails', async () => {
    let listener: ((event: ConversationStreamEvent) => void) | undefined;
    const list = vi
      .fn<ConversationApi['list']>()
      .mockResolvedValueOnce({ projects, providers })
      .mockRejectedValueOnce(new Error('Native history unavailable'));
    installConversations(list, vi.fn((nextListener) => {
      listener = nextListener;
      return vi.fn();
    }));

    const { result } = renderHook(() => useConversationHistory());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => listener?.({
      loadId: '00000000-0000-4000-8000-000000000000',
      seq: 1,
      ref: projects[0].conversations[0].ref,
      type: 'summary.updated',
      summary: projects[0].conversations[0],
    }));

    await waitFor(() => expect(result.current.error?.message).toBe('Native history unavailable'));
    expect(result.current.projects).toEqual(projects);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
