export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
export const CONTENT_MIN_WIDTH = 420;

/*
  The mode toggle floats just below the app bar, in the content area's
  top-right corner, this far in from the content's right edge — clear of the
  transcript's 10px scrollbar. Closed, that edge is the window's; open, it is
  the panel's outer edge, so the toggle moves left by the panel's width.
*/
export const MODE_TOGGLE_INSET = 12;

// The panel toggle's reach in from the window controls: App's 16px gap
// before them, plus its own 28px.
const PANEL_TOGGLE_RIGHT = 16 + 28;

// Space kept between the panel toggle and a title that ellipsizes before it.
const TITLE_CLEARANCE = 8;

export const clampPanelWidth = (value: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, value));

export const defaultPanelWidth = (containerWidth: number, leftInset: number): number =>
  clampPanelWidth((containerWidth - leftInset) * 0.4);

export type PanelLayout = {
  // The panel sits beside the content instead of over it.
  split: boolean;
  // The widest a resize may go without breaking the split.
  maxWidth: number;
  // How much of the app bar's header, from its right edge, the panel toggle
  // and the window controls cover, as a CSS length.
  headerReserve: string;
};

export function panelLayout({ open, width, containerWidth, leftInset }: {
  open: boolean;
  width: number;
  containerWidth: number;
  leftInset: number;
}): PanelLayout {
  const available = containerWidth - leftInset;
  const split = open && available >= width + CONTENT_MIN_WIDTH;
  const maxWidth = split ? clampPanelWidth(available - CONTENT_MIN_WIDTH) : PANEL_MAX_WIDTH;
  // Split, the header ends at the panel's edge, short of the panel toggle and
  // the window controls above the panel. Otherwise it runs under both.
  const headerReserve = split ? '1rem' : `calc(var(--window-controls-inset) + ${PANEL_TOGGLE_RIGHT + TITLE_CLEARANCE}px)`;
  return { split, maxWidth, headerReserve };
}

// How far left of its closed position the mode toggle moves: to the panel's
// edge while open.
export const modeToggleShift = (open: boolean, width: number): number =>
  open ? width : 0;

/** From this panel width a Files tab's tree sits beside the viewer; narrower, it opens over it. A starting value, tuned by feel. */
export const FILES_TREE_DOCK_MIN_WIDTH = 560;
export const FILES_TREE_WIDTH = 240;

export const filesTreeDocked = (panelWidth: number): boolean => panelWidth >= FILES_TREE_DOCK_MIN_WIDTH;
