// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BlockingRequest as BlockingRequestData } from '@/shared/conversation-contract';
import { BlockingRequest } from './blocking-request';

afterEach(cleanup);

const approvalRequest: Extract<BlockingRequestData, { kind: 'approval' }> = {
  id: 'request-1', kind: 'approval', provider: 'codex', title: 'Run lint',
  operation: 'pnpm lint', rememberScope: 'project:/work/fractal', status: 'open',
};

const questionRequest: Extract<BlockingRequestData, { kind: 'question' }> = {
  id: 'question-1', kind: 'question', provider: 'claude', prompt: 'Choose an approach',
  fieldId: 'answer', choices: [{ value: 'option-a', label: 'Use option A' }, { value: 'option-b', label: 'Use option B' }],
  allowFreeText: true, status: 'open',
};

describe('BlockingRequest', () => {
  test('approval decisions stay explicit and one-shot', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={approvalRequest} onResolve={resolve} />);

    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'allow-once' });
    expect(screen.getByRole('button', { name: 'Allow and remember' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('approval preserves provider remember scope and includes an optional denial reason', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    const { rerender } = render(<BlockingRequest request={approvalRequest} onResolve={resolve} />);

    await user.click(screen.getByRole('button', { name: 'Allow and remember' }));
    expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'allow-and-remember', scope: 'project:/work/fractal' });

    rerender(<BlockingRequest request={{ ...approvalRequest, id: 'request-2', rememberScope: undefined }} onResolve={resolve} />);
    expect(screen.queryByRole('button', { name: 'Allow and remember' })).toBeNull();
    await user.type(screen.getByLabelText('Denial reason'), 'Tests are running');
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(resolve).toHaveBeenLastCalledWith('request-2', { kind: 'deny', reason: 'Tests are running' });
  });

  test('questions return the provider-supplied choice by field ID', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={questionRequest} onResolve={resolve} />);

    await user.click(screen.getByRole('button', { name: 'Use option B' }));

    expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { answer: 'option-b' } });
  });

  test('submits free text only when the provider permits it and waits for native resolution', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = render(<BlockingRequest request={questionRequest} onResolve={resolve} />);

    await user.type(screen.getByLabelText('Other answer'), 'Use a hybrid');
    await user.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { answer: 'Use a hybrid' } });
    expect(screen.getByRole('button', { name: 'Use option A' }).hasAttribute('disabled')).toBe(true);

    rerender(<BlockingRequest request={{ ...questionRequest, status: 'resolved' }} onResolve={resolve} />);
    expect(screen.queryByRole('button', { name: 'Use option A' })).toBeNull();

    rerender(<BlockingRequest request={{ ...questionRequest, id: 'question-2', allowFreeText: false }} onResolve={resolve} />);
    expect(screen.queryByLabelText('Other answer')).toBeNull();
  });
});
