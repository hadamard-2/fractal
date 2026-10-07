import {
  CHANGES_FILE_MAX_BYTES,
  CHANGES_FILE_MAX_LINES,
  CHANGES_TOTAL_MAX_BYTES,
  type ChangeBody,
  type DiffHunk,
  type DiffLine,
} from '../../shared/changes-contract';
import { entryKind, type DiffRecord } from './git-records';

export interface PatchLimits { fileMaxLines: number; fileMaxBytes: number; totalMaxBytes: number }
export interface PatchOutcome { bodies: ChangeBody[]; truncated: boolean; /** Bytes kept toward the total cap. */ bytes: number }

const DEFAULT_LIMITS: PatchLimits = {
  fileMaxLines: CHANGES_FILE_MAX_LINES,
  fileMaxBytes: CHANGES_FILE_MAX_BYTES,
  totalMaxBytes: CHANGES_TOTAL_MAX_BYTES,
};

const SECTION_START = 'diff --git ';
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const SUBMODULE_LINE = /^([+-])Subproject commit ([0-9a-f]+)(-dirty)?$/;
const NO_MODE = '000000';

interface Section {
  index: number;
  record: DiffRecord;
  /** Set when the body is known before the lines are read; the lines are then discarded. */
  fixed: boolean;
  hunks: DiffHunk[];
  hunk?: DiffHunk;
  oldNumber: number;
  newNumber: number;
  lineCount: number;
  bytes: number;
  tooLarge: boolean;
  oldCommit?: string;
  newCommit?: string;
}

export function createPatchReader(records: DiffRecord[], limits: PatchLimits = DEFAULT_LIMITS) {
  const bodies: (ChangeBody | undefined)[] = new Array<ChangeBody | undefined>(records.length).fill(undefined);
  let recordIndex = -1;
  let sectionsSeen = 0;
  let section: Section | undefined;
  let total = 0;
  let truncated = false;

  function truncate(): void {
    truncated = true;
    if (section) bodies[section.index] = { kind: 'not-loaded' };
    section = undefined;
  }

  function startSection(index: number): void {
    const record = records[index];
    const fixedBody = bodyFromRecord(record, limits);
    if (fixedBody) bodies[index] = fixedBody;
    section = {
      index,
      record,
      fixed: fixedBody !== undefined,
      hunks: [],
      oldNumber: 0,
      newNumber: 0,
      lineCount: 0,
      bytes: 0,
      tooLarge: false,
    };
  }

  function finalize(): void {
    if (!section || section.fixed) {
      section = undefined;
      return;
    }

    const { record, index } = section;
    if (record.oldMode === '160000' || record.newMode === '160000') {
      const { oldCommit, newCommit } = section;
      bodies[index] = { kind: 'submodule', commit: newCommit === undefined || newCommit === oldCommit ? null : newCommit };
    } else if (section.tooLarge) {
      bodies[index] = { kind: 'too-large' };
    } else if (section.hunks.length === 0 && record.oldMode !== record.newMode && record.oldMode !== NO_MODE && record.newMode !== NO_MODE) {
      bodies[index] = { kind: 'mode', oldMode: record.oldMode, newMode: record.newMode };
    } else {
      bodies[index] = { kind: 'hunks', hunks: section.hunks };
      total += section.bytes;
    }
    section = undefined;
  }

  function nextSection(): void {
    finalize();
    const current = records[recordIndex];
    if (current?.letter === 'T' && sectionsSeen < 2) {
      sectionsSeen++;
      return;
    }

    recordIndex++;
    sectionsSeen = 1;
    if (recordIndex < records.length) startSection(recordIndex);
  }

  function readHunkLine(current: Section, line: string): void {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current.hunk = { header: header[3].trim(), oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      current.oldNumber = current.hunk.oldStart;
      current.newNumber = current.hunk.newStart;
      if (!current.tooLarge) {
        current.hunks.push(current.hunk);
        current.bytes += line.length + 1;
      }
      return;
    }
    if (!current.hunk) return;

    const text = (line.endsWith('\r') ? line.slice(0, -1) : line).slice(1);
    let diffLine: DiffLine;
    if (line.startsWith('+')) diffLine = { kind: 'added', text, newNumber: current.newNumber++ };
    else if (line.startsWith('-')) diffLine = { kind: 'removed', text, oldNumber: current.oldNumber++ };
    else if (line.startsWith('\\')) diffLine = { kind: 'no-newline', text };
    else if (line === '' || line.startsWith(' ')) {
      diffLine = { kind: 'context', text, oldNumber: current.oldNumber++, newNumber: current.newNumber++ };
    } else return;

    if (current.tooLarge) return;
    current.lineCount++;
    current.bytes += line.length + 1;
    if (current.lineCount > limits.fileMaxLines || current.bytes > limits.fileMaxBytes) {
      current.tooLarge = true;
      current.hunks = [];
      current.hunk = undefined;
      return;
    }
    if (total + current.bytes > limits.totalMaxBytes) {
      truncate();
      return;
    }
    current.hunk.lines.push(diffLine);
  }

  function readSubmoduleLine(current: Section, line: string): void {
    const match = SUBMODULE_LINE.exec(line);
    if (!match) return;
    if (match[1] === '-') current.oldCommit = match[2];
    else current.newCommit = match[2];
  }

  return {
    onLine(line: string): boolean {
      if (truncated) return false;
      if (line.startsWith(SECTION_START)) {
        nextSection();
        return true;
      }

      const current = section;
      if (!current || current.fixed) return true;
      if (current.record.oldMode === '160000' || current.record.newMode === '160000') readSubmoduleLine(current, line);
      else readHunkLine(current, line);
      return !truncated;
    },

    finish(): PatchOutcome {
      if (!truncated) finalize();
      return { bodies: bodies.map((body) => body ?? { kind: 'not-loaded' }), truncated, bytes: total };
    },
  };
}

function bodyFromRecord(record: DiffRecord, limits: PatchLimits): ChangeBody | undefined {
  if (record.letter === 'T') return { kind: 'type-change', from: entryKind(record.oldMode), to: entryKind(record.newMode) };
  if (record.oldMode === '160000' || record.newMode === '160000') return undefined;
  if (record.added === null) return { kind: 'binary', size: null };
  if (record.added + (record.removed ?? 0) > limits.fileMaxLines) return { kind: 'too-large' };
  return undefined;
}
