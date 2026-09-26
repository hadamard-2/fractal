import { MODE_TOGGLE_WIDTH } from '@/components/mode-toggle';

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
export const CONTENT_MIN_WIDTH = 420;

/*
  Where the mode toggle's right edge sits, measured from the window's right
  edge, while the panel is closed. App's corner strip lays out
  [mode toggle][4px gap][32px panel toggle] with a 12px inset — that is
  (--app-bar-height 56px − 32px) / 2, so the panel toggle is as far from the
  window edge as from the band's top and bottom. Change those and this
  together.
*/
export const CLOSED_MODE_TOGGLE_RIGHT = 12 + 32 + 4;

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
  // How much of the content's header, from its right edge, the toggles cover.
  headerReserve: number;
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
  // sits beside the panel toggle. The content's own right edge is the panel's
  // edge only when split — in overlay the content runs under the panel.
  const toggleRight = open ? width : CLOSED_MODE_TOGGLE_RIGHT;
  const contentRight = split ? width : 0;
  return { split, maxWidth, headerReserve: toggleRight + MODE_TOGGLE_WIDTH + TITLE_CLEARANCE - contentRight };
}

// How far left of its closed position the mode toggle moves.
export const modeToggleShift = (open: boolean, width: number): number =>
  open ? width - CLOSED_MODE_TOGGLE_RIGHT : 0;
