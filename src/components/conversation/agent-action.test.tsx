// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentAction } from '@/shared/conversation-contract';
import { AgentAction as AgentActionView } from './agent-action';

afterEach(cleanup);

describe('AgentAction', () => {
  test('preserves provider-supplied multiline commands in bounded preformatted text', () => {
    const action: AgentAction = {
      id: 'command-1', nativeId: 'command-1', provider: 'codex', kind: 'command',
      status: 'running', captureCompleteness: 'complete', command: 'pnpm test\n  -- --runInBand',
    };
    render(<ol><AgentActionView action={action} /></ol>);

    const command = screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === 'pnpm test\n  -- --runInBand');
    expect(command.className).toContain('whitespace-pre-wrap');
    expect(command.className).toContain('overflow');
  });
});
