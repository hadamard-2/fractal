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
  id: 'question-1', kind: 'question', provider: 'claude', status: 'open',
  questions: [{
    fieldId: 'answer', prompt: 'Choose an approach', allowFreeText: true,
    choices: [{ value: 'option-a', label: 'Use option A', description: 'The quick one' }, { value: 'option-b', label: 'Use option B' }],
  }],
};

const twoQuestions: Extract<BlockingRequestData, { kind: 'question' }> = {
  id: 'question-2', kind: 'question', provider: 'claude', status: 'open',
  questions: [
    { fieldId: 'focus', prompt: 'What should we work on?', allowFreeText: true, choices: [{ value: 'Benchmark', label: 'Benchmark' }, { value: 'Cleanup', label: 'Cleanup' }] },
    { fieldId: 'checks', prompt: 'Which checks?', allowFreeText: true, multiSelect: true, choices: [{ value: 'Lint', label: 'Lint' }, { value: 'Tests', label: 'Tests' }] },
  ],
};

describe('BlockingRequest', () => {
  test('a plan approval shows the plan and asks for changes in words', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    const plan: BlockingRequestData = { id: 'plan-1', kind: 'approval', provider: 'claude', title: 'Review plan', operation: '/plans/x.md', plan: 'Add farewell', status: 'open' };
    render(<BlockingRequest request={plan} onResolve={resolve} />);

    expect(screen.getByRole('region', { name: 'Plan review' }).textContent).toContain('Add farewell');
    const requestChanges = screen.getByRole('button', { name: 'Request changes' });
    expect(requestChanges.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'What should change?' }), 'Add JSDoc');
    await user.click(requestChanges);
    expect(resolve).toHaveBeenCalledWith('plan-1', { kind: 'deny', reason: 'Add JSDoc' });
  });

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

  test('a question shows each choice with its description and number, and answers with the chosen value', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={questionRequest} onResolve={resolve} />);

    const optionA = screen.getByRole('radio', { name: /Use option A/ });
    expect(optionA.textContent).toContain('The quick one');
    expect(optionA.textContent).toContain('1');
    expect(screen.queryByText('1/1')).toBeNull();
    const submit = screen.getByRole('button', { name: /Submit/ });
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('radio', { name: /Use option B/ }));
    expect(screen.getByRole('radio', { name: /Use option B/ }).getAttribute('aria-checked')).toBe('true');
    expect(resolve).not.toHaveBeenCalled();
    await user.click(submit);
    expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { answer: 'option-b' } });
  });

  test('number keys pick a choice and Ctrl+Enter submits', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={questionRequest} onResolve={resolve} />);

    await user.keyboard('2');
    expect(screen.getByRole('radio', { name: /Use option B/ }).getAttribute('aria-checked')).toBe('true');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { answer: 'option-b' } });
  });

  test('typing in Other picks it, and its text is the answer', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn(() => new Promise<void>(() => undefined));
    const { rerender } = render(<BlockingRequest request={questionRequest} onResolve={resolve} />);

    await user.click(screen.getByRole('radio', { name: /Use option A/ }));
    await user.type(screen.getByLabelText('Other answer'), 'Use a hybrid');
    expect(screen.getByRole('radio', { name: /Other/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Use option A/ }).getAttribute('aria-checked')).toBe('false');
    await user.keyboard('{Enter}');
    expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { answer: 'Use a hybrid' } });
    expect(screen.getByRole('radio', { name: /Use option A/ }).hasAttribute('disabled')).toBe(true);

    rerender(<BlockingRequest request={{ ...questionRequest, id: 'question-3', questions: [{ ...questionRequest.questions[0], allowFreeText: false }] }} onResolve={resolve} />);
    expect(screen.queryByLabelText('Other answer')).toBeNull();
    expect(screen.queryByRole('radio', { name: /Other/ })).toBeNull();
  });

  test('a question without choices takes a typed answer', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={{ ...questionRequest, questions: [{ fieldId: 'why', prompt: 'Why?', allowFreeText: true }] }} onResolve={resolve} />);

    await user.type(screen.getByLabelText('Answer'), 'Release day');
    await user.click(screen.getByRole('button', { name: /Submit/ }));
    expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { why: 'Release day' } });
  });

  test('steps through several questions with Next and Back, keeping each answer', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={twoQuestions} onResolve={resolve} />);

    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: /Cleanup/ }));
    await user.click(screen.getByRole('button', { name: /Next/ }));

    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.getByText('Which checks?')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: /Lint/ }));
    await user.click(screen.getByRole('checkbox', { name: /Tests/ }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('radio', { name: /Cleanup/ }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('checkbox', { name: /Tests/ }).getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('button', { name: /Submit/ }));
    expect(resolve).toHaveBeenCalledWith('question-2', { kind: 'answer', answers: { focus: 'Cleanup', checks: 'Lint, Tests' } });
  });

  test('Skip leaves a question unanswered, and skipping every question declines them', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    const { rerender } = render(<BlockingRequest request={twoQuestions} onResolve={resolve} />);

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(screen.getByRole('checkbox', { name: /Tests/ }));
    await user.click(screen.getByRole('button', { name: /Submit/ }));
    expect(resolve).toHaveBeenLastCalledWith('question-2', { kind: 'answer', answers: { checks: 'Tests' } });

    rerender(<BlockingRequest request={{ ...twoQuestions, id: 'question-4' }} onResolve={resolve} />);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(resolve).toHaveBeenLastCalledWith('question-4', { kind: 'deny', reason: 'The user skipped the questions' });
  });

  test('dismissing declines the questions, and collapsing hides them without answering', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<BlockingRequest request={twoQuestions} onResolve={resolve} />);

    await user.click(screen.getByRole('button', { name: 'Collapse question' }));
    expect(screen.queryByRole('radio', { name: /Cleanup/ })).toBeNull();
    expect(screen.getByText('What should we work on?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Expand question' }));
    expect(screen.getByRole('radio', { name: /Cleanup/ })).toBeTruthy();
    expect(resolve).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Dismiss question' }));
    expect(resolve).toHaveBeenCalledWith('question-2', { kind: 'deny', reason: 'The user dismissed the question' });
  });

  test('scopes drafts and submission state to the current request ID', async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    const { rerender } = render(<BlockingRequest request={approvalRequest} onResolve={resolve} />);

    await user.type(screen.getByLabelText('Denial reason'), 'First reason');
    rerender(<BlockingRequest request={{ ...approvalRequest, id: 'request-2' }} onResolve={resolve} />);
    expect((screen.getByLabelText('Denial reason') as HTMLTextAreaElement).value).toBe('');
    await user.type(screen.getByLabelText('Denial reason'), 'Second reason');
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(resolve).toHaveBeenLastCalledWith('request-2', { kind: 'deny', reason: 'Second reason' });
    expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true);

    rerender(<BlockingRequest request={{ ...questionRequest, id: 'question-2' }} onResolve={resolve} />);
    await user.type(screen.getByLabelText('Other answer'), 'First answer');
    rerender(<BlockingRequest request={{ ...questionRequest, id: 'question-3' }} onResolve={resolve} />);
    expect((screen.getByLabelText('Other answer') as HTMLInputElement).value).toBe('');
  });

  test('retains native request audit data after resolution and preserves operation whitespace', () => {
    const { rerender } = render(<BlockingRequest request={{ ...approvalRequest, operation: 'pnpm test\n  -- --runInBand', status: 'resolved', decision: { kind: 'allow-and-remember', scope: 'project:/work/fractal' } }} onResolve={vi.fn()} />);

    const operation = screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === 'pnpm test\n  -- --runInBand');
    expect(operation.tagName).toBe('PRE');
    expect(operation.className).toContain('whitespace-pre-wrap');
    expect(screen.getByText('allow-and-remember')).toBeTruthy();
    expect(screen.getByText('project:/work/fractal')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();

    rerender(<BlockingRequest request={{ ...twoQuestions, status: 'resolved', decision: { kind: 'answer', answers: { checks: 'Lint, Tests' } } }} onResolve={vi.fn()} />);
    expect(screen.getByText('What should we work on?')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
    expect(screen.getByText('Which checks?')).toBeTruthy();
    expect(screen.getByText('Lint, Tests')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Lint/ })).toBeNull();
  });

  test('contains synchronous and rejected request-resolution failures while remaining one-shot', async () => {
    const user = userEvent.setup();
    const synchronous = vi.fn(() => { throw new Error('bridge unavailable'); });
    const { rerender } = render(<BlockingRequest request={approvalRequest} onResolve={synchronous} />);

    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(synchronous).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(true);

    const rejected = vi.fn(() => Promise.reject(new Error('bridge unavailable')));
    rerender(<BlockingRequest request={{ ...approvalRequest, id: 'request-2' }} onResolve={rejected} />);
    await user.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(true);
  });
});
