import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDiffHighlights } from '@/renderer/diff-highlight';
import { buildRows, FILE_ROW_HEIGHT, fileIndexAt, isCollapsed, LINE_ROW_HEIGHT, type ChangeRow } from '@/renderer/changes-rows';
import type { ChangedFile } from '@/shared/changes-contract';
import { BodyRow, FileHeader } from './diff-rows';

// text-xs with leading-5: every line is 20px, so rows never need measuring.
const TAB_WIDTH = 8;
const rowHeight = (row: ChangeRow) => (row.kind === 'file' ? FILE_ROW_HEIGHT : LINE_ROW_HEIGHT);

/** Columns in the longest line, with tabs at their CSS default width, so the content can scroll sideways. */
const columns = (text: string) => text.length + (TAB_WIDTH - 1) * (text.split('\t').length - 1);

interface Top { key: string; path: string }
interface CurrentLine { path: string; line: number; key: string }

/**
 * Where to scroll after the rows changed under a reader whose first visible
 * row was `top`: that row's new index, else the nearest row of the same file
 * that is still shown, else nowhere.
 */
function anchorIndex(top: Top, before: { rows: ChangeRow[]; files: ChangedFile[] }, rows: ChangeRow[]): number | null {
  const indexOf = new Map(rows.map((row, index) => [row.key, index]));
  const exact = indexOf.get(top.key);
  if (exact !== undefined) return exact;
  const from = before.rows.findIndex((row) => row.key === top.key);
  if (from < 0) return null;
  for (let distance = 1; distance < before.rows.length; distance++) {
    for (const index of [from - distance, from + distance]) {
      const row = before.rows[index];
      if (row && before.files[row.fileIndex]?.path === top.path) {
        const found = indexOf.get(row.key);
        if (found !== undefined) return found;
      }
    }
  }
  return null;
}

export function DiffStream({ root, files, jumpTo, onOpenFile }: {
  root: string;
  files: ChangedFile[];
  jumpTo: { path: string; token: number } | null;
  onOpenFile: (path: string) => void;
}) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [current, setCurrent] = useState<CurrentLine | null>(null);
  const rows = useMemo(() => buildRows(files, overrides), [files, overrides]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => rowHeight(rows[index]),
    getItemKey: (index) => rows[index].key,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const first = Math.min(virtualizer.range?.startIndex ?? 0, rows.length - 1);

  const fileIndexes = useMemo(() => [...new Set(items.map((item) => rows[item.index].fileIndex))], [items, rows]);
  const tokensFor = useDiffHighlights(files, fileIndexes);

  const gutter = useMemo(() => {
    let digits = 1;
    let longest = 0;
    for (const row of rows) {
      if (row.kind !== 'line') continue;
      digits = Math.max(digits, String(Math.max(row.line.oldNumber ?? 0, row.line.newNumber ?? 0)).length);
      longest = Math.max(longest, columns(row.line.text));
    }
    return { columns: digits + 2, longest };
  }, [rows]);
  // Rows are absolutely positioned, so the content's width has to be set rather than measured.
  const width = `calc(${gutter.longest}ch + ${gutter.columns * 2 + 2}ch + 1rem)`;

  const pendingJump = useRef<string | null>(null);
  const reading = useRef<{ top: Top | null; rows: ChangeRow[]; files: ChangedFile[] }>({ top: null, rows, files });
  const scrollToKey = (key: string) => {
    const index = rows.findIndex((row) => row.key === key);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'start' });
    return index;
  };

  // The reading position is the key of the first visible row. Once the rows have changed it is scrolled back to, or a requested jump is.
  useLayoutEffect(() => {
    const before = reading.current;
    const topOf = (index: number): Top | null => {
      const row = rows[index];
      return row ? { key: row.key, path: files[row.fileIndex].path } : null;
    };
    let top = topOf(first);
    if (before.rows !== rows) {
      const target = pendingJump.current !== null
        ? rows.findIndex((row) => row.key === `f:${pendingJump.current}`)
        : before.top ? anchorIndex(before.top, before, rows) : null;
      pendingJump.current = null;
      if (target !== null && target >= 0) {
        virtualizer.scrollToIndex(target, { align: 'start' });
        top = topOf(target);
      }
    }
    reading.current = { top, rows, files };
  });

  useEffect(() => {
    if (!jumpTo) return;
    const file = files.find((candidate) => candidate.path === jumpTo.path);
    if (!file) return;
    if (isCollapsed(file, overrides)) {
      pendingJump.current = file.path;
      setOverrides((previous) => new Map(previous).set(file.path, false));
    } else {
      scrollToKey(`f:${file.path}`);
    }
    // A jump is a request, answered once per token, whatever else changes.
  }, [jumpTo?.token]);

  const toggle = (file: ChangedFile) => setOverrides((previous) => new Map(previous).set(file.path, !isCollapsed(file, previous)));
  const lineFor = (file: ChangedFile) => (current?.path === file.path ? current.line : undefined);
  const stuck = rows.length > 0 && rows[first].kind !== 'file' ? files[fileIndexAt(rows, first)] : undefined;

  return (
    <div aria-label="Changes" className="h-full overflow-auto font-mono text-xs leading-5 [container-type:inline-size]" ref={scroller} role="region">
      {stuck && (
        <div className="pointer-events-none sticky top-0 left-0 z-10 h-0 w-[100cqw]">
          <div className="pointer-events-auto">
            <FileHeader collapsed={isCollapsed(stuck, overrides)} file={stuck} line={lineFor(stuck)} onOpenFile={onOpenFile} onToggle={() => toggle(stuck)} root={root} />
          </div>
        </div>
      )}
      <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize(), width }}>
        {items.map((item) => {
          const row = rows[item.index];
          const file = files[row.fileIndex];
          return (
            <div className="absolute left-0 w-full" data-row={row.key} key={item.key} style={{ top: item.start, height: item.size }}>
              {row.kind === 'file' ? (
                <div className="sticky left-0 w-[100cqw]">
                  <FileHeader collapsed={isCollapsed(file, overrides)} file={file} line={lineFor(file)} onOpenFile={onOpenFile} onToggle={() => toggle(file)} root={root} />
                </div>
              ) : (
                <BodyRow
                  current={row.kind === 'line' && current?.key === row.key}
                  gutter={gutter.columns}
                  onLine={() => { if (row.kind === 'line') setCurrent({ path: file.path, line: row.openAt, key: row.key }); }}
                  row={row}
                  tokens={row.kind === 'line' && row.line.kind !== 'no-newline' ? tokensFor(row.fileIndex, row.side, row.sideIndex) : null}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
