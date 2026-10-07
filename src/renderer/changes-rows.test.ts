import { describe, expect, test } from 'vitest';
import type { ChangedFile, DiffHunk, DiffLine } from '@/shared/changes-contract';
import { bodyMessage, buildRows, countsText, fileIndexAt, isCollapsed, statusLetter, summaryText } from './changes-rows';

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path, status: 'modified', added: 1, removed: 1, collapsed: false, body: { kind: 'hunks', hunks: [] }, ...over,
});
const hunks = (...list: DiffHunk[]) => ({ kind: 'hunks' as const, hunks: list });
const hunk = (oldStart: number, newStart: number, lines: DiffLine[]): DiffHunk => ({ header: `@@ -${oldStart} +${newStart} @@`, oldStart, newStart, lines });
const ctx = (o: number, n: number, text = 'x'): DiffLine => ({ kind: 'context', text, oldNumber: o, newNumber: n });
const add = (n: number, text = 'x'): DiffLine => ({ kind: 'added', text, newNumber: n });
const del = (o: number, text = 'x'): DiffLine => ({ kind: 'removed', text, oldNumber: o });
const noNewline: DiffLine = { kind: 'no-newline', text: ' No newline at end of file' };
const lineRows = (rows: ReturnType<typeof buildRows>) => rows.flatMap((row) => (row.kind === 'line' ? [row] : []));

describe('buildRows', () => {
  test('builds file, hunk and line rows, and only a header for a collapsed file', () => {
    const a = file('a.ts', { body: hunks(hunk(1, 1, [ctx(1, 1), del(2), add(2)])) });
    const big = file('big.lock', { body: hunks(hunk(1, 1, [add(1)])) });
    expect(buildRows([a, big], new Map()).map((row) => row.kind)).toEqual(['file', 'hunk', 'line', 'line', 'line', 'file', 'hunk', 'line']);
    expect(buildRows([a, big], new Map([['big.lock', true]])).map((row) => row.key)).toEqual([
      'f:a.ts', 'h:a.ts:1', 'l:a.ts:c:1', 'l:a.ts:r:2', 'l:a.ts:a:2:1', 'f:big.lock',
    ]);
  });

  test('emits a message row for a non-hunk body and nothing for empty hunks', () => {
    const rows = buildRows([file('a.bin', { body: { kind: 'binary', size: null } }), file('empty', { status: 'added', body: hunks() })], new Map());
    expect(rows).toEqual([
      { kind: 'file', key: 'f:a.bin', fileIndex: 0 },
      { kind: 'message', key: 'm:a.bin', fileIndex: 0, text: 'Binary file changed' },
      { kind: 'file', key: 'f:empty', fileIndex: 1 },
    ]);
  });

  test('starts files collapsed by their hint, and lets overrides win both ways', () => {
    const hinted = file('h.ts', { collapsed: true, body: hunks(hunk(1, 1, [add(1)])) });
    const open = file('o.ts', { body: hunks(hunk(1, 1, [add(1)])) });
    expect(isCollapsed(hinted, new Map())).toBe(true);
    expect(isCollapsed(hinted, new Map([['h.ts', false]]))).toBe(false);
    expect(isCollapsed(open, new Map([['o.ts', true]]))).toBe(true);
    expect(buildRows([hinted], new Map())).toHaveLength(1);
    expect(buildRows([hinted], new Map([['h.ts', false]]))).toHaveLength(3);
    expect(buildRows([open], new Map([['o.ts', true]]))).toHaveLength(1);
  });

  test('numbers each side for highlighting and points removed lines at the nearest new line', () => {
    const f = file('a.ts', { body: hunks(hunk(1, 1, [ctx(1, 1), del(2), add(2), ctx(3, 3)])) });
    const lines = lineRows(buildRows([f], new Map()));
    expect(lines.map((row) => [row.side, row.sideIndex, row.openAt])).toEqual([['new', 0, 1], ['old', 1, 1], ['new', 1, 2], ['new', 2, 3]]);
  });

  test('counts side indexes across hunks and falls back to max(1, newStart)', () => {
    const f = file('d.ts', { status: 'deleted', body: hunks(hunk(1, 0, [del(1), del(2)]), hunk(10, 0, [del(10)])) });
    const lines = lineRows(buildRows([f], new Map()));
    expect(lines.map((row) => [row.side, row.sideIndex, row.openAt])).toEqual([['old', 0, 1], ['old', 1, 1], ['old', 2, 1]]);
    const g = file('g.ts', { body: hunks(hunk(5, 7, [del(5), add(7)])) });
    expect(lineRows(buildRows([g], new Map())).map((row) => row.openAt)).toEqual([7, 7]);
  });

  test('keeps the previous side and index for no-newline rows, and unique keys', () => {
    const f = file('a.ts', { body: hunks(hunk(1, 1, [del(1), noNewline, add(1), noNewline])) });
    const lines = lineRows(buildRows([f], new Map()));
    expect(lines.map((row) => [row.side, row.sideIndex, row.openAt])).toEqual([['old', 0, 1], ['old', 0, 1], ['new', 0, 1], ['new', 0, 1]]);
    expect(lines[1].line).toBe(noNewline);
    expect(new Set(lines.map((row) => row.key)).size).toBe(4);
  });

  test('keeps row keys stable when lines are added above', () => {
    const second = (shift: number) => hunk(10, 10 + shift, [ctx(10, 10 + shift), add(11 + shift), ctx(11, 12 + shift), ctx(12, 13 + shift)]);
    const keys = (f: ChangedFile) => buildRows([f], new Map()).map((row) => row.key);
    const before = file('a.ts', { body: hunks(second(0)) });
    const after = file('a.ts', { body: hunks(hunk(1, 1, [add(1), add(2), ctx(1, 3)]), second(2)) });
    const [, hunkKey, contextKey, addedKey] = keys(before);
    expect([hunkKey, contextKey, addedKey]).toEqual(['h:a.ts:10', 'l:a.ts:c:10', 'l:a.ts:a:10:1']);
    const afterKeys = keys(after);
    expect(afterKeys).toContain(hunkKey);
    expect(afterKeys).toContain(contextKey);
    expect(afterKeys).toContain(addedKey);
  });

  test('gives every row of a multi-hunk file a distinct key', () => {
    const f = file('a.ts', {
      body: hunks(
        hunk(10, 10, [add(10), add(11), ctx(10, 12), del(11), add(13), add(14), ctx(12, 15), noNewline]),
        hunk(30, 32, [del(30), add(32), noNewline]),
      ),
    });
    const rows = buildRows([f], new Map());
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(rows.length);
    expect(keys).toContain('l:a.ts:a:9:1');
    expect(keys).toContain('l:a.ts:a:9:2');
    expect(keys).toContain('l:a.ts:r:11');
    expect(keys).toContain('l:a.ts:a:11:1');
    expect(keys).toContain('l:a.ts:a:11:2');
  });
});

describe('bodyMessage', () => {
  test('writes each body message', () => {
    const msg = (body: ChangedFile['body'], over: Partial<ChangedFile> = {}) => bodyMessage(file('f', { body, ...over }));
    expect(msg(hunks())).toBeNull();
    expect(msg({ kind: 'binary', size: 1258291 })).toBe('Binary file changed · 1.2 MiB');
    expect(msg({ kind: 'binary', size: null })).toBe('Binary file changed');
    expect(msg({ kind: 'mode', oldMode: '100644', newMode: '100755' })).toBe('File mode changed 644 → 755');
    expect(msg({ kind: 'type-change', from: 'file', to: 'symlink' })).toBe('Changed from a file to a symlink');
    expect(msg({ kind: 'submodule', commit: 'abc1234def5678' })).toBe('Submodule moved to `abc1234`');
    expect(msg({ kind: 'submodule', commit: null })).toBe('Submodule has uncommitted changes');
    expect(msg({ kind: 'folder' }, { status: 'added', added: null, removed: null })).toBe('Untracked folder · contents not shown');
    expect(msg({ kind: 'not-loaded' })).toBe('Not loaded: too many changes');
    expect(msg({ kind: 'too-large' }, { added: 40, removed: 2 })).toBe('Diff too large to show · +40 −2');
    expect(msg({ kind: 'too-large' }, { added: null, removed: null })).toBe('Diff too large to show');
  });
});

describe('summaries', () => {
  test('summarises counts', () => {
    expect(summaryText([file('a', { added: 1, removed: 0 })])).toBe('1 file changed · +1 −0');
    expect(summaryText([file('a', { added: 10, removed: 1 }), file('b', { added: null, removed: null }), file('c', { added: 2, removed: 3 })])).toBe('3 files changed · +12 −4');
  });

  test('formats counts and status letters', () => {
    expect(countsText(12, 4)).toBe('+12 −4');
    expect(countsText(3, null)).toBe('+3 −0');
    expect(countsText(null, 2)).toBe('+0 −2');
    expect(countsText(null, null)).toBe('');
    expect(['modified', 'added', 'deleted', 'renamed', 'type-changed', 'conflicted'].map((s) => statusLetter(s as ChangedFile['status']))).toEqual(['M', 'A', 'D', 'R', 'T', 'U']);
  });
});

test('finds the file a row belongs to', () => {
  const rows = buildRows([file('a', { body: hunks(hunk(1, 1, [add(1)])) }), file('b')], new Map());
  expect(rows.map((_, i) => fileIndexAt(rows, i))).toEqual([0, 0, 0, 1]);
  expect(fileIndexAt(rows, 99)).toBe(1);
  expect(fileIndexAt(rows, -5)).toBe(0);
  expect(fileIndexAt([], 0)).toBe(-1);
});
