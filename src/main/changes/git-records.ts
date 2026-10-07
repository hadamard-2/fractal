import type { ChangesHead, EntryKind } from '../../shared/changes-contract';

export interface StatusRecords {
  head: ChangesHead;
  /** Every path status lists inside the project, rename sources included, project-relative. Used for the fingerprint. */
  paths: string[];
  /** Project-relative; a nested repository keeps its trailing '/'. */
  untracked: string[];
  conflicted: Set<string>;
}

export function parseStatus(output: string, prefix: string): StatusRecords {
  const head: ChangesHead = {};
  const paths: string[] = [];
  const untracked: string[] = [];
  const conflicted = new Set<string>();
  const tokens = nulTokens(output);

  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index];

    if (record.startsWith('# branch.oid ')) {
      const commit = record.slice('# branch.oid '.length);
      if (commit !== '(initial)') head.commit = commit;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice('# branch.head '.length);
      if (branch !== '(detached)') head.branch = branch;
      continue;
    }

    if (record.startsWith('1 ')) {
      addPath(paths, fixedPath(record, 8), prefix);
      continue;
    }

    if (record.startsWith('2 ')) {
      const path = addPath(paths, fixedPath(record, 9), prefix);
      const origPath = requiredToken(tokens, ++index, record);
      if (path !== undefined) addPath(paths, origPath, prefix);
      continue;
    }

    if (record.startsWith('u ')) {
      const path = addPath(paths, fixedPath(record, 10), prefix);
      if (path !== undefined) conflicted.add(path);
      continue;
    }

    if (record.startsWith('? ')) {
      const path = addPath(paths, record.slice(2), prefix);
      if (path !== undefined) untracked.push(path);
    }
  }

  return { head, paths, untracked, conflicted };
}

export interface DiffRecord {
  path: string;
  oldPath?: string;
  letter: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  added: number | null;
  removed: number | null;
}

export function parseDiffRecords(output: string): DiffRecord[] {
  const tokens = nulTokens(output);
  const records: DiffRecord[] = [];
  let index = 0;

  while (index < tokens.length && tokens[index].startsWith(':')) {
    const raw = tokens[index++];
    const [oldMode, newMode, oldSha, , rawLetter] = raw.slice(1).split(' ');
    if (oldMode === undefined || newMode === undefined || oldSha === undefined || rawLetter === undefined) {
      throw new Error(`Malformed raw diff record: ${raw}`);
    }

    const letter = rawLetter.replace(/\d+$/, '');
    if (letter.startsWith('R') || letter.startsWith('C')) {
      const oldPath = requiredToken(tokens, index++, raw);
      const path = requiredToken(tokens, index++, raw);
      records.push({ path, oldPath, letter, oldMode, newMode, oldSha, added: 0, removed: 0 });
    } else {
      const path = requiredToken(tokens, index++, raw);
      records.push({ path, letter, oldMode, newMode, oldSha, added: 0, removed: 0 });
    }
  }

  for (const record of records) {
    const numstat = requiredToken(tokens, index++, record.path);
    const counts = numstat.split('\t');
    if (counts.length < 3) throw new Error(`Malformed numstat record: ${numstat}`);

    record.added = counts[0] === '-' ? null : Number.parseInt(counts[0], 10);
    record.removed = counts[1] === '-' ? null : Number.parseInt(counts[1], 10);
    if ((record.added !== null && Number.isNaN(record.added)) || (record.removed !== null && Number.isNaN(record.removed))) {
      throw new Error(`Malformed numstat counts: ${numstat}`);
    }

    if (record.oldPath !== undefined) {
      requiredToken(tokens, index++, numstat);
      requiredToken(tokens, index++, numstat);
    }
  }

  return records;
}

export function entryKind(mode: string): EntryKind {
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  return 'file';
}

function nulTokens(output: string): string[] {
  return output.split('\0').filter((token) => token.length > 0);
}

function fixedPath(record: string, fieldCount: number): string {
  let spaces = 0;
  for (let index = 0; index < record.length; index++) {
    if (record[index] === ' ') {
      spaces++;
      if (spaces === fieldCount) return record.slice(index + 1);
    }
  }
  throw new Error(`Malformed status record: ${record}`);
}

function stripPrefix(path: string, prefix: string): string | undefined {
  if (prefix.length === 0) return path;
  if (!path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length);
}

function addPath(paths: string[], path: string, prefix: string): string | undefined {
  const stripped = stripPrefix(path, prefix);
  if (stripped === undefined) return undefined;
  paths.push(stripped);
  return stripped;
}

function requiredToken(tokens: string[], index: number, record: string): string {
  const token = tokens[index];
  if (token === undefined) throw new Error(`Missing path token for record: ${record}`);
  return token;
}
