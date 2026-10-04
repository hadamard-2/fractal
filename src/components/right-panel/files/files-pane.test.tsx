// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { FilePanelTab } from '@/renderer/panel-tabs';
import { FilesPane } from './files-pane';

vi.mock('./file-tree', () => ({
  FileTree: ({ root, onOpen }: { root: string; onOpen: (path: string, options: { pinned: boolean }) => void }) => (
    <button onClick={() => onOpen('src/b.ts', { pinned: false })} type="button">Tree of {root}</button>
  ),
}));
vi.mock('./file-viewer', () => ({ FileViewer: ({ path }: { path: string }) => <p>Viewing {path}</p> }));

afterEach(cleanup);

const a: FilePanelTab = { kind: 'file', id: 'a', projectPath: '/repo', path: 'src/a.ts', preview: true };
const empty: FilePanelTab = { kind: 'file', id: 'e', projectPath: '/other', path: null, preview: true };
const props = { tabs: [a, empty], docked: true, dockedTreeOpen: true, overlayOpen: false, onOpenFile: vi.fn(), onCloseOverlay: vi.fn() };
const visible = (text: string) => !screen.getByText(text).closest('[hidden]');

test('docked, shows the selected project\'s tree beside its file, and an empty tab asks for a file', () => {
  const { rerender } = render(<FilesPane {...props} selected={a} />);
  expect(visible('Tree of /repo')).toBe(true);
  expect(visible('Tree of /other')).toBe(false);
  expect(visible('Viewing src/a.ts')).toBe(true);
  rerender(<FilesPane {...props} dockedTreeOpen={false} selected={empty} />);
  expect(screen.getByText('Select a file')).toBeTruthy();
  expect(visible('Tree of /other')).toBe(false);
});

test('narrow, opens the tree over the viewer on request or for an empty tab, and closes it once a file is chosen', async () => {
  const onOpenFile = vi.fn();
  const onCloseOverlay = vi.fn();
  const { rerender } = render(<FilesPane {...props} docked={false} onCloseOverlay={onCloseOverlay} onOpenFile={onOpenFile} selected={a} />);
  expect(visible('Tree of /repo')).toBe(false);
  rerender(<FilesPane {...props} docked={false} onCloseOverlay={onCloseOverlay} onOpenFile={onOpenFile} overlayOpen selected={a} />);
  expect(visible('Tree of /repo')).toBe(true);
  await userEvent.setup().click(screen.getByText('Tree of /repo'));
  expect(onOpenFile).toHaveBeenCalledWith('/repo', 'src/b.ts', false);
  expect(onCloseOverlay).toHaveBeenCalled();
  rerender(<FilesPane {...props} docked={false} onCloseOverlay={onCloseOverlay} onOpenFile={onOpenFile} selected={empty} />);
  expect(visible('Tree of /other')).toBe(true);
});
