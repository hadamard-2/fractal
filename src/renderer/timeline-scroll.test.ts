import { describe, expect, test } from 'vitest';
import { nextScrollAction, readingAnchor, restoreAnchor } from './timeline-scroll';

describe('nextScrollAction', () => {
  test('follows new content only when already near the bottom', () => {
    expect(nextScrollAction({ distanceFromBottom: 24, appended: true, resizedAboveAnchor: false })).toBe('follow-bottom');
    expect(nextScrollAction({ distanceFromBottom: 96, appended: true, resizedAboveAnchor: false })).toBe('follow-bottom');
    expect(nextScrollAction({ distanceFromBottom: 97, appended: true, resizedAboveAnchor: false })).toBe('preserve-anchor');
  });
  test('preserves the reader during earlier height changes and ignores unchanged content', () => {
    expect(nextScrollAction({ distanceFromBottom: 500, appended: false, resizedAboveAnchor: true })).toBe('preserve-anchor');
    expect(nextScrollAction({ distanceFromBottom: 10, appended: false, resizedAboveAnchor: true })).toBe('follow-bottom');
    expect(nextScrollAction({ distanceFromBottom: 10, appended: false, resizedAboveAnchor: false })).toBe('none');
  });
});

describe('reading anchor', () => {
  const rows = [{ key: 'a', start: 0, end: 200 }, { key: 'b', start: 200, end: 500 }];
  test('captures the first visible row, excluding overscan and a row ending at the viewport edge', () => {
    expect(readingAnchor(rows, 220)).toEqual({ id: 'b', offset: 20 });
    expect(readingAnchor(rows, 200)).toEqual({ id: 'b', offset: 0 });
    expect(readingAnchor([], 0)).toBeNull();
  });
  test('restores the same reading point after prepends and height changes', () => {
    expect(restoreAnchor({ id: 'b', offset: 20 }, [{ key: 'a', start: 100, end: 400 }, { key: 'b', start: 400, end: 700 }])).toBe(420);
    expect(restoreAnchor({ id: 'missing', offset: 20 }, rows)).toBeNull();
    expect(restoreAnchor(null, rows)).toBeNull();
  });
  test('clamps an offset when the anchored row collapses', () => {
    expect(restoreAnchor({ id: 'b', offset: 280 }, [{ key: 'b', start: 200, end: 240 }])).toBe(239);
  });
});
