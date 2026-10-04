// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { RightWorkspace } from './right-workspace';

vi.mock('./terminal-view', () => ({
  TerminalView: ({ cwd, focusToken }: { cwd: string | null; focusToken?: number }) => (
    <div data-slot="terminal"><textarea aria-label="Terminal input" data-cwd={cwd ?? ''} data-focus-token={focusToken ?? 0} /></div>
  ),
}));

vi.mock('./right-panel/files/files-pane', () => ({
  FilesPane: ({ selected, docked, dockedTreeOpen, onOpenFile }: {
    selected?: { projectPath: string; path: string | null }; docked: boolean; dockedTreeOpen: boolean;
    onOpenFile: (projectPath: string, path: string, pinned: boolean) => void;
  }) => (
    <div data-docked={docked} data-testid="files-pane" data-tree-open={dockedTreeOpen}>
      {selected && (
        <>
          <button onClick={() => onOpenFile(selected.projectPath, 'src/a.ts', false)} type="button">Click a.ts</button>
          <button onClick={() => onOpenFile(selected.projectPath, 'src/b.ts', false)} type="button">Click b.ts</button>
        </>
      )}
    </div>
  ),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const box = (left: number, width: number) => ({ left, width, x: left, y: 0, top: 0, right: left + width, bottom: 800, height: 800, toJSON: (): void => undefined });

function Harness({ withInset = false, onResizingChange = () => undefined, projectPath = '/repo' as string | null }: { withInset?: boolean; onResizingChange?: (resizing: boolean) => void; projectPath?: string | null }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <button onClick={() => setOpen(!open)} type="button">{open ? 'Close panel' : 'Open panel'}</button>
      <RightWorkspace leftInsetRef={withInset ? insetRef : undefined} onOpenChange={setOpen} onResizingChange={onResizingChange} onWidthChange={setWidth} open={open} projectPath={projectPath} width={width}>
        <div data-inset={withInset || undefined} ref={insetRef}>Content</div>
      </RightWorkspace>
    </>
  );
}

// getByRole's `hidden: true` bypasses the isInaccessible filter but not
// accessible-name computation: with @testing-library/dom 10.4.1 +
// dom-accessibility-api 0.5.16, an aria-hidden element's own name computes to
// "" per the accname spec regardless of aria-label, so a name-based role
// query can never match it. The DOM contract's stable selector does.
const panel = () => document.querySelector('aside[data-slot="right-panel"]') as HTMLElement;
const pressToggle = (target: Element) => fireEvent.keyDown(target, { key: '`', code: 'Backquote', ctrlKey: true });

test('opens empty, creates and closes tabs, and returns to the tool list', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(panel().hasAttribute('inert')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Add tool' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
  expect(screen.getByLabelText('Terminal input').getAttribute('data-cwd')).toBe('/repo');
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  expect(screen.getByRole('menuitem', { name: 'Side chat' }).getAttribute('aria-disabled')).toBe('true');
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
  await user.click(screen.getByRole('button', { name: 'Close Terminal' }));
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.getByRole('menu', { name: 'Add a tool' })).toBeTruthy();
});

test('hiding the panel keeps its tabs', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Close panel' }));
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
});

test('fixes the default width on first open and resizes by keyboard', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().style.width).toBe('320px');
  screen.getByRole('separator', { name: 'Resize right panel' }).focus();
  await user.keyboard('{ArrowLeft}');
  expect(panel().style.width).toBe('336px');
});

test('splits beside content right of the left inset and reserves header space', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.inset ? box(300, 1300) : box(0, 1600);
  });
  const user = userEvent.setup();
  render(<Harness withInset />);
  const content = screen.getByText('Content').parentElement as HTMLElement;
  const gap = document.querySelector('[data-slot="right-panel-gap"]') as HTMLElement;
  expect(content.style.getPropertyValue('--app-bar-reserve')).toBe('184px');
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().style.width).toBe('520px');
  expect(gap.style.width).toBe('520px');
  expect(content.style.getPropertyValue('--app-bar-reserve')).toBe('136px');
});

test('Ctrl+` opens and creates, focuses from elsewhere, and closes from inside a terminal', async () => {
  render(<Harness />);
  expect(pressToggle(document.body)).toBe(false);
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  const input = screen.getByLabelText('Terminal input');
  expect(input.getAttribute('data-focus-token')).toBe('1');

  const elsewhere = screen.getByRole('button', { name: 'Close panel' });
  elsewhere.focus();
  pressToggle(elsewhere);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(input.getAttribute('data-focus-token')).toBe('2');

  input.focus();
  expect(pressToggle(input)).toBe(false);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByRole('button', { name: 'Open panel' })).toBeTruthy();
});

test('ignores other modifier combinations', () => {
  render(<Harness />);
  fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(document.body, { key: '`', code: 'Backquote' });
  expect(panel().getAttribute('aria-hidden')).toBe('true');
});

const pressFiles = (target: Element) => fireEvent.keyDown(target, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true });

test('Ctrl+Shift+F opens the panel on Files and reuses the Files tab', () => {
  render(<Harness />);
  pressFiles(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.getByRole('tab', { name: 'Files (preview)' })).toBeTruthy();
  expect(pressFiles(document.body)).toBe(false);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
});

test('Ctrl+Shift+F does nothing without a project', () => {
  render(<Harness projectPath={null} />);
  pressFiles(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
});

test('Files is unavailable without a project', async () => {
  const user = userEvent.setup();
  render(<Harness projectPath={null} />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(screen.getByRole('menuitem', { name: 'Files' }).hasAttribute('disabled')).toBe(true);
});

test('opens Files, fills and replaces the preview tab, pins it, and reuses the most recent file tab', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(screen.getByRole('tab', { name: 'Files (preview)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click b.ts' }));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  await user.dblClick(screen.getByRole('tab', { name: 'b.ts (preview)' }));
  expect(screen.getByRole('tab', { name: 'b.ts' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['b.ts', 'a.ts (preview)']);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' }).getAttribute('aria-selected')).toBe('true');
});

test('shows the tree toggle only on file tabs, and Ctrl+` returns to the last terminal', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.queryByRole('button', { name: /file tree/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  // Narrow, a tab with no file yet always shows the tree.
  expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  const toggle = screen.getByRole('button', { name: 'Show file tree' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');
  pressToggle(document.body);
  expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
});

test('another project starts with its own tree state', async () => {
  const user = userEvent.setup();
  const view = render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  await user.click(screen.getByRole('button', { name: 'Show file tree' }));
  expect(screen.getByRole('button', { name: 'Hide file tree' })).toBeTruthy();
  view.rerender(<Harness projectPath="/other" />);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getByRole('button', { name: 'Show file tree' })).toBeTruthy();
});
