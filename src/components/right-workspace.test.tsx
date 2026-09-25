// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { RightWorkspace } from './right-workspace';

vi.mock('./terminal-view', () => ({ TerminalView: (): null => null }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Harness({ active = true, projectPath = '/repo' }: { active?: boolean; projectPath?: string | null }) {
  const [open, setOpen] = useState(false);
  return <RightWorkspace active={active} open={open} onOpenChange={setOpen} projectPath={projectPath}><div>Conversation</div></RightWorkspace>;
}

test('opens empty, creates and closes tabs, and leaves future tools disabled', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.queryByRole('menuitem', { name: 'Terminal' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Open right panel' }));
  expect(screen.getByRole('menuitem', { name: 'Review' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('menuitem', { name: 'Browser' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('menuitem', { name: 'Files' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByText('Side chat')).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(2);
  await user.click(screen.getAllByRole('button', { name: /Close Terminal/ })[1]);
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: /Close Terminal/ }));
  expect(screen.queryByRole('tab', { name: /Terminal/ })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Terminal' })).toBeTruthy();
});

test('hiding and inactivating the workspace keeps its tab state', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Harness active />);
  await user.click(screen.getByRole('button', { name: 'Open right panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Close right panel' }));
  rerender(<Harness active={false} />);
  rerender(<Harness active />);
  await user.click(screen.getByRole('button', { name: 'Open right panel' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
});

test('keyboard resize changes the panel width', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open right panel' }));
  const panel = screen.getByRole('complementary', { name: 'Right workspace' });
  const before = panel.style.width;
  screen.getByRole('separator', { name: 'Resize right panel' }).focus();
  await user.keyboard('{ArrowLeft}');
  expect(panel.style.width).not.toBe(before);
});
