import { nextTerminalNumber, type TerminalTab } from '@/components/right-panel/terminal-tabs';

export type TerminalPanelTab = TerminalTab & { kind: 'terminal' };

export type FilePanelTab = {
  kind: 'file';
  id: string;
  /** Fixed when the tab is created, like a terminal's directory. */
  projectPath: string;
  /** Relative to the project and '/'-separated; null until a file is chosen. */
  path: string | null;
  /** Shows whichever file was clicked last in its project. At most one per project. */
  preview: boolean;
};

export type PanelTab = TerminalPanelTab | FilePanelTab;

export interface PanelTabsState {
  tabs: PanelTab[];
  selectedId: string | null;
  /** Tab ids, most recently selected first. */
  recent: string[];
}

export const emptyPanelTabs: PanelTabsState = { tabs: [], selectedId: null, recent: [] };

const touch = (recent: string[], id: string) => [id, ...recent.filter((other) => other !== id)];
const append = (state: PanelTabsState, tab: PanelTab): PanelTabsState =>
  ({ tabs: [...state.tabs, tab], selectedId: tab.id, recent: touch(state.recent, tab.id) });
const projectFileTabs = (state: PanelTabsState, projectPath: string) =>
  state.tabs.filter((tab): tab is FilePanelTab => tab.kind === 'file' && tab.projectPath === projectPath);

export function selectTab(state: PanelTabsState, id: string): PanelTabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, selectedId: id, recent: touch(state.recent, id) } : state;
}

export function addTerminalTab(state: PanelTabsState, id: string, cwd: string | null, paste?: string): PanelTabsState {
  const terminals = state.tabs.filter((tab): tab is TerminalPanelTab => tab.kind === 'terminal');
  return append(state, { kind: 'terminal', id, cwd, number: nextTerminalNumber(terminals), ...(paste ? { paste } : {}) });
}

export function updateTerminalTab(state: PanelTabsState, id: string, patch: Partial<Omit<TerminalTab, 'id'>>): PanelTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.kind === 'terminal' && tab.id === id ? { ...tab, ...patch } : tab)) };
}

/** Closes a tab; closing the selected one selects its neighbour, as the terminal tabs always have. */
export function closeTab(state: PanelTabsState, id: string): PanelTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const recent = state.recent.filter((other) => other !== id);
  if (state.selectedId !== id) return { ...state, tabs, recent };
  const selectedId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
  return { tabs, selectedId, recent: selectedId ? touch(recent, selectedId) : recent };
}

/** The terminal Ctrl+` acts on: the selected tab if it is a terminal, otherwise the terminal used most recently. */
export function activeTerminalId(state: PanelTabsState): string | undefined {
  const terminals = new Set(state.tabs.filter((tab) => tab.kind === 'terminal').map((tab) => tab.id));
  if (state.selectedId !== null && terminals.has(state.selectedId)) return state.selectedId;
  return state.recent.find((id) => terminals.has(id));
}

/** Files from the tool list: the project's most recently used file tab, or a new tab with no file yet. */
export function openFilesTool(state: PanelTabsState, projectPath: string, newId: string): PanelTabsState {
  const ids = new Set(projectFileTabs(state, projectPath).map((tab) => tab.id));
  const recentId = state.recent.find((id) => ids.has(id));
  if (recentId) return selectTab(state, recentId);
  return append(state, { kind: 'file', id: newId, projectPath, path: null, preview: true });
}

/**
 * Opens a file by VS Code's preview rules. A file that is already open has
 * its tab selected. Otherwise the project's preview tab shows it, or a new
 * preview tab opens. `pinned` opens it in a permanent tab instead, except
 * that a tab with no file yet is filled rather than left empty beside it.
 */
export function openFile(state: PanelTabsState, projectPath: string, path: string, pinned: boolean, newId: string): PanelTabsState {
  const tabs = projectFileTabs(state, projectPath);
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) return selectTab(pinned ? pinTab(state, existing.id) : state, existing.id);
  const reusable = tabs.find((tab) => tab.preview && (!pinned || tab.path === null));
  if (reusable) {
    const filled = { ...state, tabs: state.tabs.map((tab) => (tab.id === reusable.id ? { ...reusable, path, preview: !pinned } : tab)) };
    return selectTab(filled, reusable.id);
  }
  return append(state, { kind: 'file', id: newId, projectPath, path, preview: !pinned });
}

/** Makes a file tab permanent. A tab with no file stays a preview, so the next file still fills it. */
export function pinTab(state: PanelTabsState, id: string): PanelTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.kind === 'file' && tab.id === id && tab.path !== null ? { ...tab, preview: false } : tab)) };
}
