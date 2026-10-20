// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { MapNodeData, SideChatDraft } from '@/renderer/map/map-graph';
import { ComposerEnvironmentContext, ComposerNode, type ComposerEnvironment } from './composer-node';

const draft: SideChatDraft = { id: 'd1', parent: { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' }, afterTurnId: 't1', text: '' };
const NODE_TYPES = { composer: ComposerNode };

function renderComposer(environment: Partial<ComposerEnvironment> = {}, text = '', measured?: { width: number; height: number }) {
  const env: ComposerEnvironment = { submit: vi.fn(async () => undefined), remove: vi.fn(), ...environment };
  const nodes: Node<MapNodeData>[] = [{ id: 'composer|d1', type: 'composer', position: { x: 0, y: 0 }, data: { kind: 'composer', draft: { ...draft, text } }, ...(measured ? { measured } : {}) }];
  render(
    <ReactFlowProvider>
      <ComposerEnvironmentContext.Provider value={env}>
        <div style={{ width: 800, height: 600 }}><ReactFlow nodeTypes={NODE_TYPES} nodes={nodes} /></div>
      </ComposerEnvironmentContext.Provider>
    </ReactFlowProvider>,
  );
  return { env, textarea: screen.getByPlaceholderText('Ask a side question') as HTMLTextAreaElement };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('shows the placeholder and the send hint, and keeps canvas gestures off the textarea', () => {
  const { textarea } = renderComposer();
  expect(screen.getByText('Ctrl+Enter to send')).toBeTruthy();
  for (const name of ['nodrag', 'nowheel', 'nopan']) expect(textarea.classList.contains(name)).toBe(true);
});

test('starts from the draft\'s text', () => {
  const { textarea } = renderComposer({}, '> quoted\n\n');
  expect(textarea.value).toBe('> quoted\n\n');
});

test('once shown, it takes focus with the caret after a prefilled quote, so the question goes below it', async () => {
  const user = userEvent.setup();
  const { env, textarea } = renderComposer({}, '> quoted\n\n', { width: 320, height: 120 });
  await waitFor(() => expect(document.activeElement).toBe(textarea));
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([10, 10]);
  await user.keyboard('Why?{Control>}{Enter}{/Control}');
  expect(env.submit).toHaveBeenCalledWith(expect.anything(), '> quoted\n\nWhy?');
});

test('Enter adds a newline, and Ctrl+Enter or Cmd+Enter submits', async () => {
  const user = userEvent.setup();
  const { env, textarea } = renderComposer();
  await user.click(textarea);
  await user.keyboard('Why{Enter}now');
  expect(textarea.value).toBe('Why\nnow');
  expect(env.submit).not.toHaveBeenCalled();

  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(env.submit).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), 'Why\nnow');
  await waitFor(() => expect(textarea.disabled).toBe(false));
  await user.keyboard('{Meta>}{Enter}{/Meta}');
  expect(env.submit).toHaveBeenCalledTimes(2);
});

test('an empty draft sends nothing', async () => {
  const user = userEvent.setup();
  const { env, textarea } = renderComposer();
  await user.click(textarea);
  await user.keyboard('  {Control>}{Enter}{/Control}');
  expect(env.submit).not.toHaveBeenCalled();
});

test('Escape removes an empty draft and leaves one with text alone', async () => {
  const user = userEvent.setup();
  const { env, textarea } = renderComposer();
  await user.click(textarea);
  await user.keyboard('Why');
  await user.keyboard('{Escape}');
  expect(env.remove).not.toHaveBeenCalled();
  expect(textarea.value).toBe('Why');

  await user.clear(textarea);
  await user.keyboard('{Escape}');
  expect(env.remove).toHaveBeenCalledWith('d1');
});

test('the textarea is disabled while sending', async () => {
  let finish: () => void = () => undefined;
  const user = userEvent.setup();
  const { textarea } = renderComposer({ submit: () => new Promise<void>((resolve) => { finish = resolve; }) });
  await user.click(textarea);
  await user.keyboard('Why{Control>}{Enter}{/Control}');
  expect(textarea.disabled).toBe(true);
  finish();
  await waitFor(() => expect(textarea.disabled).toBe(false));
});

test('a failed send shows its copy and keeps the text', async () => {
  const user = userEvent.setup();
  const { textarea } = renderComposer({ submit: vi.fn(async () => { throw new Error("Couldn't start the side chat."); }) });
  await user.click(textarea);
  await user.keyboard('Why{Control>}{Enter}{/Control}');
  // React Flow keeps a node hidden until it's measured, which jsdom never does, so the role query can't see it.
  expect((await screen.findByText("Couldn't start the side chat.")).getAttribute('role')).toBe('alert');
  expect(textarea.value).toBe('Why');
  expect(textarea.disabled).toBe(false);
});
