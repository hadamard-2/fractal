// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ExecuteMode, ProviderNotices } from './execute-mode';
import type { ShellContext } from '@/components/app-shell';
import type { ConversationRef, HarnessStatus, ProjectConversationGroup } from '@/shared/conversation-contract';

// The panel's own behavior is covered in conversation-panel.test.tsx; here only what ExecuteMode hands it.
vi.mock('@/components/conversation-panel', () => ({
  ConversationPanel: ({ active, readOnly }: { active?: boolean; readOnly?: boolean }) => <output data-testid="panel">{`active=${String(active)} readOnly=${String(readOnly)}`}</output>,
}));

afterEach(() => { cleanup(); });

const capabilities: HarnessStatus['capabilities'] = {
  create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false,
};

test('tells the user about a working agent whose version is older than Fractal is tested with', () => {
  const warning = 'Codex 0.160.0 is older than 0.162.1, the oldest version Fractal is tested with. Update it if something misbehaves.';
  render(<ProviderNotices providers={[{ provider: 'codex', availability: 'available', warning, capabilities }]} />);
  expect(screen.getByRole('status').textContent).toBe(warning);
});

test('shows nothing for a working agent with nothing to report', () => {
  render(<ProviderNotices providers={[{ provider: 'claude', availability: 'available', capabilities }]} />);
  expect(screen.queryByRole('status')).toBeNull();
});

const parent: ConversationRef = { provider: 'claude', nativeSessionId: 'parent', projectPath: '/work' };
const subagent: ConversationRef = { provider: 'claude', nativeSessionId: 'subagent', projectPath: '/work' };
const projects: ProjectConversationGroup[] = [{
  projectPath: '/work', displayName: 'work',
  conversations: [
    { ref: parent, title: 'Parent', updatedAt: 2, runtime: 'idle', captureCompleteness: 'complete' },
    { ref: subagent, title: 'Helper', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete', parentId: 'parent' },
  ],
}];

function shell(selectedRef: ConversationRef): ShellContext {
  return {
    selectedRef,
    history: { projects, providers: [], loaded: true, error: null } as unknown as ShellContext['history'],
    actions: { newConversation: vi.fn(), search: vi.fn(), addProject: vi.fn(), canStart: true },
    onRuntimeChange: vi.fn(),
    refreshSignal: 0,
  };
}

test('hands the panel whether Execute is on screen, and read-only for a subagent conversation', () => {
  const { rerender } = render(<ExecuteMode {...shell(parent)} />);
  expect(screen.getByTestId('panel').textContent).toBe('active=true readOnly=false');
  rerender(<ExecuteMode {...shell(subagent)} />);
  expect(screen.getByTestId('panel').textContent).toBe('active=true readOnly=true');
  rerender(<ExecuteMode {...shell(parent)} active={false} />);
  expect(screen.getByTestId('panel').textContent).toBe('active=false readOnly=false');
});
