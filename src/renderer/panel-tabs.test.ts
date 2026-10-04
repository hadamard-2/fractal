import { describe, expect, test } from 'vitest';
import { activeTerminalId, addTerminalTab, closeTab, emptyPanelTabs, openFile, openFilesTool, pinTab, selectTab, updateTerminalTab, type FilePanelTab, type PanelTabsState } from './panel-tabs';

const fileTabs = (state: PanelTabsState) => state.tabs.filter((tab): tab is FilePanelTab => tab.kind === 'file');
const selected = (state: PanelTabsState) => state.tabs.find((tab) => tab.id === state.selectedId);

describe('terminal tabs', () => {
  test('numbers and selects new terminals, and selects a neighbour when the selected one closes', () => {
    let state = addTerminalTab(emptyPanelTabs, 't1', '/repo');
    state = addTerminalTab(state, 't2', '/repo');
    expect(state.tabs).toMatchObject([{ kind: 'terminal', id: 't1', number: 1 }, { kind: 'terminal', id: 't2', number: 2 }]);
    expect(state.selectedId).toBe('t2');
    state = updateTerminalTab(state, 't1', { shell: 'zsh', exited: true });
    expect(state.tabs[0]).toMatchObject({ shell: 'zsh', exited: true });
    state = closeTab(state, 't2');
    expect(state.selectedId).toBe('t1');
    expect(closeTab(state, 't1')).toMatchObject({ tabs: [], selectedId: null });
  });

  test('Ctrl+` acts on the selected terminal, or else the one used most recently', () => {
    let state = addTerminalTab(emptyPanelTabs, 't1', '/repo');
    state = addTerminalTab(state, 't2', '/repo');
    state = selectTab(state, 't1');
    expect(activeTerminalId(state)).toBe('t1');
    state = openFilesTool(state, '/repo', 'f1');
    expect(activeTerminalId(state)).toBe('t1');
    expect(activeTerminalId(emptyPanelTabs)).toBeUndefined();
  });
});

describe('file tabs', () => {
  test('Files opens an empty preview tab, then reselects the project\'s most recent file tab', () => {
    let state = openFilesTool(emptyPanelTabs, '/repo', 'f1');
    expect(selected(state)).toEqual({ kind: 'file', id: 'f1', projectPath: '/repo', path: null, preview: true });
    state = openFile(state, '/repo', 'a.ts', true, 'f2');
    state = openFile(state, '/repo', 'b.ts', true, 'f3');
    state = selectTab(state, 'f2');
    state = addTerminalTab(state, 't1', '/repo');
    state = openFilesTool(state, '/repo', 'unused');
    expect(state.selectedId).toBe('f2');
    expect(fileTabs(state)).toHaveLength(2);
    state = openFilesTool(state, '/other', 'f4');
    expect(selected(state)).toMatchObject({ projectPath: '/other', path: null });
  });

  test('a click fills the empty Files tab, then replaces the preview tab\'s file', () => {
    let state = openFilesTool(emptyPanelTabs, '/repo', 'f1');
    state = openFile(state, '/repo', 'a.ts', false, 'unused');
    expect(fileTabs(state)).toEqual([{ kind: 'file', id: 'f1', projectPath: '/repo', path: 'a.ts', preview: true }]);
    state = openFile(state, '/repo', 'b.ts', false, 'unused');
    expect(fileTabs(state)).toEqual([{ kind: 'file', id: 'f1', projectPath: '/repo', path: 'b.ts', preview: true }]);
  });

  test('an open file is selected rather than opened again, and pinning keeps it', () => {
    let state = openFile(emptyPanelTabs, '/repo', 'a.ts', true, 'f1');
    state = openFile(state, '/repo', 'b.ts', false, 'f2');
    state = openFile(state, '/repo', 'a.ts', false, 'unused');
    expect(state.selectedId).toBe('f1');
    state = openFile(state, '/repo', 'b.ts', true, 'unused');
    expect(fileTabs(state)).toMatchObject([{ id: 'f1', preview: false }, { id: 'f2', path: 'b.ts', preview: false }]);
  });

  test('a pinned open leaves the preview tab alone, but fills an empty Files tab', () => {
    let state = openFile(emptyPanelTabs, '/repo', 'a.ts', false, 'f1');
    state = openFile(state, '/repo', 'b.ts', true, 'f2');
    expect(fileTabs(state)).toMatchObject([{ id: 'f1', path: 'a.ts', preview: true }, { id: 'f2', path: 'b.ts', preview: false }]);
    let empty = openFilesTool(emptyPanelTabs, '/repo', 'e1');
    empty = openFile(empty, '/repo', 'c.ts', true, 'unused');
    expect(fileTabs(empty)).toEqual([{ kind: 'file', id: 'e1', projectPath: '/repo', path: 'c.ts', preview: false }]);
  });

  test('pinning a preview tab means the next click opens a new preview', () => {
    let state = openFile(emptyPanelTabs, '/repo', 'a.ts', false, 'f1');
    state = pinTab(state, 'f1');
    state = openFile(state, '/repo', 'b.ts', false, 'f2');
    expect(fileTabs(state)).toMatchObject([{ id: 'f1', path: 'a.ts', preview: false }, { id: 'f2', path: 'b.ts', preview: true }]);
  });

  test('an empty Files tab cannot be made permanent', () => {
    const state = pinTab(openFilesTool(emptyPanelTabs, '/repo', 'f1'), 'f1');
    expect(fileTabs(state)[0].preview).toBe(true);
  });

  test('each project has its own preview tab', () => {
    let state = openFile(emptyPanelTabs, '/a', 'x.ts', false, 'f1');
    state = openFile(state, '/b', 'y.ts', false, 'f2');
    expect(fileTabs(state)).toMatchObject([{ projectPath: '/a', path: 'x.ts', preview: true }, { projectPath: '/b', path: 'y.ts', preview: true }]);
  });
});
