import type { ChangedFile, ChangeStatus, DiffLine } from '@/shared/changes-contract';
import { formatSize } from '@/renderer/file-display';

export type ChangeRow =
  | { kind: 'file'; key: string; fileIndex: number }
  | { kind: 'hunk'; key: string; fileIndex: number; header: string }
  | { kind: 'line'; key: string; fileIndex: number; line: DiffLine; side: 'old' | 'new'; sideIndex: number; openAt: number }
  | { kind: 'message'; key: string; fileIndex: number; text: string };

export const FILE_ROW_HEIGHT = 36;
export const LINE_ROW_HEIGHT = 20;

export function isCollapsed(file: ChangedFile, overrides: ReadonlyMap<string, boolean>): boolean {
  return overrides.get(file.path) ?? file.collapsed;
}

export function countsText(added: number | null, removed: number | null): string {
  return added === null && removed === null ? '' : `+${added ?? 0} −${removed ?? 0}`;
}

export function summaryText(files: ChangedFile[]): string {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} changed · ${countsText(added, removed)}`;
}

const STATUS_LETTERS = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', 'type-changed': 'T', conflicted: 'U' } as const;

export function statusLetter(status: ChangeStatus): 'M' | 'A' | 'D' | 'R' | 'T' | 'U' {
  return STATUS_LETTERS[status];
}

export function bodyMessage(file: ChangedFile): string | null {
  const { body } = file;
  switch (body.kind) {
    case 'hunks': return null;
    case 'binary': return body.size === null ? 'Binary file changed' : `Binary file changed · ${formatSize(body.size)}`;
    case 'too-large': {
      const counts = countsText(file.added, file.removed);
      return counts ? `Diff too large to show · ${counts}` : 'Diff too large to show';
    }
    case 'mode': return `File mode changed ${body.oldMode.slice(-3)} → ${body.newMode.slice(-3)}`;
    case 'type-change': return `Changed from a ${body.from} to a ${body.to}`;
    case 'submodule': return body.commit === null ? 'Submodule has uncommitted changes' : `Submodule moved to \`${body.commit.slice(0, 7)}\``;
    case 'folder': return 'Untracked folder · contents not shown';
    case 'not-loaded': return 'Not loaded: too many changes';
  }
}

export function buildRows(files: ChangedFile[], overrides: ReadonlyMap<string, boolean>): ChangeRow[] {
  const rows: ChangeRow[] = [];
  files.forEach((file, fileIndex) => {
    rows.push({ kind: 'file', key: `f:${file.path}`, fileIndex });
    if (isCollapsed(file, overrides)) return;
    const text = bodyMessage(file);
    if (text !== null) {
      rows.push({ kind: 'message', key: `m:${file.path}`, fileIndex, text });
      return;
    }
    if (file.body.kind !== 'hunks') return;
    let oldIndex = 0;
    let newIndex = 0;
    let previous: { side: 'old' | 'new'; sideIndex: number } = { side: 'new', sideIndex: 0 };
    let noNewlines = 0;
    for (const hunk of file.body.hunks) {
      rows.push({ kind: 'hunk', key: `h:${file.path}:${hunk.oldStart}:${hunk.newStart}`, fileIndex, header: hunk.header });
      let lastNew = Math.max(1, hunk.newStart);
      for (const line of hunk.lines) {
        let key = `l:${file.path}:${line.kind}:${line.oldNumber ?? ''}:${line.newNumber ?? ''}`;
        let side = previous.side;
        let sideIndex = previous.sideIndex;
        if (line.kind === 'no-newline') {
          key += `:${noNewlines++}`;
        } else {
          side = line.kind === 'removed' ? 'old' : 'new';
          sideIndex = side === 'old' ? oldIndex : newIndex;
          if (line.kind !== 'added') oldIndex++;
          if (line.kind !== 'removed') newIndex++;
          previous = { side, sideIndex };
        }
        const openAt = line.kind !== 'removed' && line.kind !== 'no-newline' && line.newNumber !== undefined ? line.newNumber : lastNew;
        if (line.newNumber !== undefined && line.kind !== 'no-newline') lastNew = line.newNumber;
        rows.push({ kind: 'line', key, fileIndex, line, side, sideIndex, openAt });
      }
    }
  });
  return rows;
}

export function fileIndexAt(rows: ChangeRow[], index: number): number {
  if (rows.length === 0) return -1;
  return rows[Math.min(Math.max(index, 0), rows.length - 1)].fileIndex;
}
