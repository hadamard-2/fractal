import { MODE_TOGGLE_WIDTH } from '@/components/mode-toggle';

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
export const CONTENT_MIN_WIDTH = 420;

/*
  Where the mode toggle's right edge sits while the panel is closed, measured
  from the window controls' left edge (the window's right edge when there are
  none). App's corner strip lays out [mode toggle][4px gap][28px panel toggle]
  with a 16px inset from the controls. Change those and this together.
*/
export const CLOSED_MODE_TOGGLE_RIGHT = 16 + 28 + 4;

// The OS window controls' reach in from the window's right edge. Only CSS can
// read the overlay's geometry, so whatever depends on it is a CSS length.
const WINDOW_CONTROLS = 'var(--window-controls-inset)';

// Space kept between the mode toggle and a title that ellipsizes before it.
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
  // How much of the content's header, from its right edge, the toggles cover,
  // as a CSS length.
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
  // Open, the toggle's right edge meets the panel's outer edge; closed, it
  // sits beside the panel toggle, left of the window controls. The content's
  // own right edge is the panel's edge only when split — in overlay the
  // content runs under the panel.
  const contentRight = split ? width : 0;
  const reserve = MODE_TOGGLE_WIDTH + TITLE_CLEARANCE - contentRight;
  return {
    split,
    maxWidth,
    headerReserve: open ? `${width + reserve}px` : `calc(${WINDOW_CONTROLS} + ${CLOSED_MODE_TOGGLE_RIGHT + reserve}px)`,
  };
}

// The mode toggle's translation from its closed position, as a CSS length:
// leftward to the panel's edge while open, so negative.
export const modeToggleShift = (open: boolean, width: number): string =>
  open ? `calc(${WINDOW_CONTROLS} - ${width - CLOSED_MODE_TOGGLE_RIGHT}px)` : '0px';

/** From this panel width a Files tab's tree sits beside the viewer; narrower, it opens over it. A starting value, tuned by feel. */
export const FILES_TREE_DOCK_MIN_WIDTH = 560;
export const FILES_TREE_WIDTH = 240;

export const filesTreeDocked = (panelWidth: number): boolean => panelWidth >= FILES_TREE_DOCK_MIN_WIDTH;
