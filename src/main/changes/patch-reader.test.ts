import { expect, test } from 'vitest';
import type { ChangeBody } from '../../shared/changes-contract';
import { parseDiffRecords, type DiffRecord } from './git-records';
import { createPatchReader, type PatchLimits } from './patch-reader';

const RAW_NUMSTAT = [
  ':100644 100644 20f982d561018f3bfdd8f3230d65ded24d81c79c 0000000000000000000000000000000000000000 M',
  'bin.dat',
  ':100644 000000 b77b4eb1d946f923f61785536da9ca5af6909f06 0000000000000000000000000000000000000000 D',
  'del.txt',
  ':100644 100644 4cb29ea38f70d7c61b2a3a25b02e3bdf44905402 0000000000000000000000000000000000000000 M',
  'mod.txt',
  ':100644 100755 4163036efa65bd4a469e752267498f01ea36a55c 0000000000000000000000000000000000000000 M',
  'mode.sh',
  ':100644 100644 489ce0f857e7634a0eb9f328265a3e91fad49f61 0000000000000000000000000000000000000000 M',
  'nonl.txt',
  ':100644 100644 0fdf397db08b5cecda1b6394d4fef7395c1933ba e0318ee591c50776923491211c55b86b2880583d R083',
  'ren.txt',
  'renamed.txt',
  ':100644 100644 e0e07580635fe8ace8ed9c6e97d787f599738c68 24e71b7288b2ac4ffad0236bb63770bef0976550 M',
  'staged.txt',
  ':100644 120000 dd59d098638313f5d00a7fa657379b33b191f2e2 0000000000000000000000000000000000000000 T',
  'tc.txt',
  ':100644 100644 34472d5e98057ba680e49f3913db709bd7a03d2d 0000000000000000000000000000000000000000 M',
  'with space.txt',
  '-\t-\tbin.dat',
  '0\t2\tdel.txt',
  '1\t1\tmod.txt',
  '0\t0\tmode.sh',
  '1\t1\tnonl.txt',
  '1\t1\t',
  'ren.txt',
  'renamed.txt',
  '1\t0\tstaged.txt',
  '1\t1\ttc.txt',
  '1\t1\twith space.txt',
].join('\0') + '\0';

const PATCH = [
  'diff --git a/bin.dat b/bin.dat',
  'index 20f982d..29efa0f 100644',
  'Binary files a/bin.dat and b/bin.dat differ',
  'diff --git a/del.txt b/del.txt',
  'deleted file mode 100644',
  'index b77b4eb..0000000',
  '--- a/del.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
  'diff --git a/mod.txt b/mod.txt',
  'index 4cb29ea..ddc897f 100644',
  '--- a/mod.txt',
  '+++ b/mod.txt',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  'diff --git a/mode.sh b/mode.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/nonl.txt b/nonl.txt',
  'index 489ce0f..3e5126c 100644',
  '--- a/nonl.txt',
  '+++ b/nonl.txt',
  '@@ -1 +1 @@',
  '-old',
  '\\ No newline at end of file',
  '+new',
  '\\ No newline at end of file',
  'diff --git a/ren.txt b/renamed.txt',
  'similarity index 83%',
  'rename from ren.txt',
  'rename to renamed.txt',
  'index 0fdf397..e0318ee 100644',
  '--- a/ren.txt',
  '+++ b/renamed.txt',
  '@@ -3,4 +3,4 @@ b',
  ' c',
  ' d',
  ' e',
  '-f',
  '+F',
  'diff --git a/staged.txt b/staged.txt',
  'index e0e0758..24e71b7 100644',
  '--- a/staged.txt',
  '+++ b/staged.txt',
  '@@ -1,2 +1,3 @@',
  ' s1',
  ' s2',
  '+s3',
  'diff --git a/tc.txt b/tc.txt',
  'deleted file mode 100644',
  'index dd59d09..0000000',
  '--- a/tc.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-file content',
  'diff --git a/tc.txt b/tc.txt',
  'new file mode 120000',
  'index 0000000..1de5659',
  '--- /dev/null',
  '+++ b/tc.txt',
  '@@ -0,0 +1 @@',
  '+target',
  '\\ No newline at end of file',
  'diff --git a/with space.txt b/with space.txt',
  'index 34472d5..39d83e0 100644',
  '--- a/with space.txt\t',
  '+++ b/with space.txt\t',
  '@@ -1,2 +1,2 @@',
  ' sp1',
  '-sp2',
  '+SP2',
].join('\n') + '\n';

const SM_OLD = 'b462d1c191e3a89e97da2760f8a331027b0a1ab1';
const SM_NEW = 'cce7d3e86a8699e631221e252a4b61448f434cd3';

const record = (overrides: Partial<DiffRecord>): DiffRecord => ({
  path: 'f.txt', letter: 'M', oldMode: '100644', newMode: '100644', oldSha: 'a'.repeat(40), added: 1, removed: 1, ...overrides,
});
const submodule = (sha: string) => record({ path: 'sm', oldMode: '160000', newMode: '160000', added: 1, removed: 1, oldSha: sha });
const section = (name: string, lines: string[]) => [`diff --git a/${name} b/${name}`, 'index 1..2 100644', `--- a/${name}`, `+++ b/${name}`, ...lines].join('\n');

function read(records: DiffRecord[], patch: string, limits?: PatchLimits) {
  const reader = createPatchReader(records, limits);
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const kept = lines.every((line) => reader.onLine(line));
  return { ...reader.finish(), kept };
}

const RECORDS = parseDiffRecords(RAW_NUMSTAT);
const bodyFor = (path: string, outcome = read(RECORDS, PATCH)) => outcome.bodies[RECORDS.findIndex((candidate) => candidate.path === path)];
const hunksOf = (body: ChangeBody) => {
  if (body.kind !== 'hunks') throw new Error(`expected hunks, got ${body.kind}`);
  return body.hunks;
};

test('parses hunks with numbers, function context, and missing newlines', () => {
  expect(bodyFor('mod.txt')).toEqual({ kind: 'hunks', hunks: [{ header: '', oldStart: 1, newStart: 1, lines: [
    { kind: 'context', text: 'one', oldNumber: 1, newNumber: 1 },
    { kind: 'removed', text: 'two', oldNumber: 2 },
    { kind: 'added', text: 'TWO', newNumber: 2 },
    { kind: 'context', text: 'three', oldNumber: 3, newNumber: 3 },
  ] }] });
  expect(hunksOf(bodyFor('renamed.txt'))[0].header).toBe('b');
  expect(hunksOf(bodyFor('nonl.txt'))[0].lines.map((line) => line.kind)).toEqual(['removed', 'no-newline', 'added', 'no-newline']);
  expect(hunksOf(bodyFor('del.txt'))[0]).toMatchObject({ oldStart: 1, newStart: 0 });
});

test('matches sections to records, giving a type change two sections', () => {
  const outcome = read(RECORDS, PATCH);
  expect(outcome.bodies).toHaveLength(RECORDS.length);
  expect(outcome.truncated).toBe(false);
  expect(bodyFor('tc.txt', outcome)).toEqual({ kind: 'type-change', from: 'file', to: 'symlink' });
  expect(bodyFor('with space.txt', outcome).kind).toBe('hunks');
  expect(hunksOf(bodyFor('with space.txt', outcome))[0].lines.map((line) => line.text)).toEqual(['sp1', 'sp2', 'SP2']);
  expect(bodyFor('bin.dat', outcome)).toEqual({ kind: 'binary', size: null });
  expect(bodyFor('mode.sh', outcome)).toEqual({ kind: 'mode', oldMode: '100644', newMode: '100755' });
});

test('reads submodule moves and uncommitted submodule changes', () => {
  const moved = read([submodule(SM_OLD)], [
    'diff --git a/sm b/sm', 'index b462d1c..cce7d3e 160000', '--- a/sm', '+++ b/sm', '@@ -1 +1 @@',
    `-Subproject commit ${SM_OLD}`, `+Subproject commit ${SM_NEW}`,
  ].join('\n'));
  expect(moved.bodies).toEqual([{ kind: 'submodule', commit: SM_NEW }]);

  const dirty = read([submodule(SM_OLD)], [
    'diff --git a/sm b/sm', 'index b462d1c..b462d1c 160000', '--- a/sm', '+++ b/sm', '@@ -1 +1 @@',
    `-Subproject commit ${SM_OLD}`, `+Subproject commit ${SM_OLD}-dirty`,
  ].join('\n'));
  expect(dirty.bodies).toEqual([{ kind: 'submodule', commit: null }]);
});

test('treats an empty line inside a hunk as context, and strips CR', () => {
  const { bodies } = read([record({})], section('f.txt', ['@@ -1,3 +1,3 @@', ' x', '', '-y\r', '+Y\r']));
  expect(hunksOf(bodies[0])[0].lines.map(({ kind, text }) => [kind, text])).toEqual([['context', 'x'], ['context', ''], ['removed', 'y'], ['added', 'Y']]);
  expect(hunksOf(bodies[0])[0].lines[1]).toEqual({ kind: 'context', text: '', oldNumber: 2, newNumber: 2 });
});

test('does not mistake content that looks like headers for section boundaries', () => {
  const { bodies } = read([record({})], section('f.txt', ['@@ -1,2 +1,2 @@', '--- a/x', '+++ b/x']));
  expect(hunksOf(bodies[0])[0].lines.map((line) => line.text)).toEqual(['-- a/x', '++ b/x']);
});

test('applies the per-file caps', () => {
  const limits = { fileMaxLines: 3, fileMaxBytes: 1_000, totalMaxBytes: 10_000 };
  const huge = read([record({ added: 4, removed: 0 })], section('f.txt', ['@@ -0,0 +1,4 @@', '+1', '+2', '+3', '+4']), limits);
  expect(huge.bodies).toEqual([{ kind: 'too-large' }]);

  const lines = read([record({})], section('f.txt', ['@@ -0,0 +1,4 @@', '+1', '+2', '+3', '+4']), limits);
  expect(lines.bodies).toEqual([{ kind: 'too-large' }]);

  const bytes = read([record({})], section('f.txt', ['@@ -1 +1 @@', '-aaaaaaaa', '+bbbbbbbb']), { fileMaxLines: 100, fileMaxBytes: 10, totalMaxBytes: 10_000 });
  expect(bytes.bodies).toEqual([{ kind: 'too-large' }]);
});

test('does not count files that are too large against the total', () => {
  const limits = { fileMaxLines: 2, fileMaxBytes: 1_000, totalMaxBytes: 60 };
  const patch = [
    section('big.txt', ['@@ -1,3 +1,3 @@', ' 1', ' 2', ' 3']),
    section('small.txt', ['@@ -1 +1 @@', '-a', '+b']),
  ].join('\n');
  const outcome = read([record({ path: 'big.txt', added: 0, removed: 0 }), record({ path: 'small.txt' })], patch, limits);
  expect(outcome.bodies.map((body) => body.kind)).toEqual(['too-large', 'hunks']);
  expect(outcome.truncated).toBe(false);
});

test('stops at the total cap, marking the rest not loaded', () => {
  // each section's stored lines take 12 + 14 + 14 = 40 bytes
  const forty = (name: string) => section(name, ['@@ -1 +1 @@', '-aaaaaaaaaaaa', '+bbbbbbbbbbbb']);
  const names = ['a.txt', 'b.txt', 'c.txt'];
  const outcome = read(names.map((path) => record({ path })), names.map(forty).join('\n'), { fileMaxLines: 100, fileMaxBytes: 1_000, totalMaxBytes: 100 });
  expect(outcome.bodies.map((body) => body.kind)).toEqual(['hunks', 'hunks', 'not-loaded']);
  expect(outcome.truncated).toBe(true);
  expect(outcome.kept).toBe(false);
});

test('marks records the patch never reached as not loaded', () => {
  const outcome = read([record({ path: 'a.txt' }), record({ path: 'b.txt' })], section('a.txt', ['@@ -1 +1 @@', '-a', '+b']));
  expect(outcome.bodies.map((body) => body.kind)).toEqual(['hunks', 'not-loaded']);
  expect(outcome.truncated).toBe(false);
});
