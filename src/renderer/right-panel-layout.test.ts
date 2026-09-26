import { expect, test } from 'vitest';
import { MODE_TOGGLE_WIDTH } from '@/components/mode-toggle';
import { CLOSED_MODE_TOGGLE_RIGHT, defaultPanelWidth, modeToggleShift, panelLayout } from './right-panel-layout';

test('the mode toggle is as wide as its items, their gaps, and its padding', () => {
  expect(MODE_TOGGLE_WIDTH).toBe(128);
});

test('defaults to 40% of the space right of the left sidebar, clamped', () => {
  expect(defaultPanelWidth(1400, 300)).toBe(440);
  expect(defaultPanelWidth(600, 0)).toBe(320);
  expect(defaultPanelWidth(3000, 0)).toBe(720);
});

test('splits only when the content keeps its minimum beside the open panel', () => {
  expect(panelLayout({ open: true, width: 400, containerWidth: 1120, leftInset: 300 }).split).toBe(true);
  expect(panelLayout({ open: true, width: 400, containerWidth: 1119, leftInset: 300 }).split).toBe(false);
  expect(panelLayout({ open: false, width: 400, containerWidth: 3000, leftInset: 0 }).split).toBe(false);
});

test('caps resizing at what leaves the content its minimum while split', () => {
  expect(panelLayout({ open: true, width: 400, containerWidth: 1300, leftInset: 300 }).maxWidth).toBe(580);
  expect(panelLayout({ open: true, width: 400, containerWidth: 1000, leftInset: 300 }).maxWidth).toBe(720);
});

test('reserves header space for whichever toggles sit in the header row', () => {
  expect(panelLayout({ open: false, width: 400, containerWidth: 1600, leftInset: 0 }).headerReserve).toBe(CLOSED_MODE_TOGGLE_RIGHT + 128 + 8);
  expect(panelLayout({ open: true, width: 400, containerWidth: 1600, leftInset: 0 }).headerReserve).toBe(136);
  expect(panelLayout({ open: true, width: 400, containerWidth: 700, leftInset: 0 }).headerReserve).toBe(536);
});

test('moves the mode toggle to the panel edge only while open', () => {
  expect(modeToggleShift(false, 400)).toBe(0);
  expect(modeToggleShift(true, 400)).toBe(352);
});
