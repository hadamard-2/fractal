import { expect, test } from 'vitest';
import { entryKind, parseDiffRecords, parseStatus } from './git-records';

const STATUS = [
  '# branch.oid 48ca86f8c49f2f4db36ad71059fd7e768f680c63',
  '# branch.head main',
  '2 R. N... 100644 100644 100644 438999b0e222bae98dc7c582fa2467c7d2da8917 438999b0e222bae98dc7c582fa2467c7d2da8917 R100 renamed.txt',
  'ren.txt',
  '1 .M N... 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 df967b96a579e45a18b8251732d16804b2e56a55 with space.txt',
  'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 b19a1e93bec1317dc6097229e12afaffbfa74dc2 950b81b7eee953d050aa05a641f8e056c85dd1bd both.txt',
  '? untracked.txt',
  '? nested/',
].join('\0') + '\0';

const BIN_SHA = 'd43e6e83345438787f245d7976e872ebf6f9eb46';
const MODE_SHA = '4163036efa65bd4a469e752267498f01ea36a55c';
const REN_SHA = '438999b0e222bae98dc7c582fa2467c7d2da8917';
const TC_SHA = 'b9bca019c83a65e6d717d0b6da86215f45dde1b3';
const LB_SHA = 'df967b96a579e45a18b8251732d16804b2e56a55';

const RAW_NUMSTAT = [
  `:100644 100644 ${BIN_SHA} 266df74550ccee8c2db1909a5fe8d7f53e08faa2 M`,
  'bin.dat',
  `:100644 100755 ${MODE_SHA} ${MODE_SHA} M`,
  'mode.sh',
  `:100644 100644 ${REN_SHA} 4c0acd2717df01e95a53f5bac022f08b2c2877fa R055`,
  'ren.txt',
  'renamed.txt',
  `:100644 120000 ${TC_SHA} 1de565933b05f74c75ff9a6520af5f9f8a5a2f1d T`,
  'tc.txt',
  `:100644 100644 ${LB_SHA} d6154e96915f440562e479ef38fbf9ba1b7a7652 M`,
  'line\nbreak.txt',
  '-\t-\tbin.dat',
  '0\t0\tmode.sh',
  '1\t1\t',
  'ren.txt',
  'renamed.txt',
  '1\t1\ttc.txt',
  '2\t0\tline\nbreak.txt',
].join('\0') + '\0';

test('reads head, changed, renamed, conflicted and untracked entries', () => {
  const records = parseStatus(STATUS, '');
  expect(records.head).toEqual({ branch: 'main', commit: '48ca86f8c49f2f4db36ad71059fd7e768f680c63' });
  expect(records.untracked).toEqual(['untracked.txt', 'nested/']);
  expect(records.conflicted).toEqual(new Set(['both.txt']));
  expect(records.paths).toEqual(expect.arrayContaining(['with space.txt', 'renamed.txt', 'ren.txt', 'both.txt', 'untracked.txt', 'nested/']));
});

test('reports no commit before the first one and no branch when detached', () => {
  expect(parseStatus('# branch.oid (initial)\0# branch.head main\0', '').head).toEqual({ branch: 'main' });
  expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0', '').head).toEqual({ commit: 'abc' });
});

test('strips the project folder prefix and drops entries outside it', () => {
  const records = parseStatus('1 .M N... 100644 100644 100644 a a app/a\0' + '1 .M N... 100644 100644 100644 b b other/o\0' + '? app/new\0', 'app/');
  expect(records.paths).toEqual(['a', 'new']);
  expect(records.untracked).toEqual(['new']);
});

test('drops the project folder itself when status reports it as untracked', () => {
  const records = parseStatus('? app/\0', 'app/');
  expect(records.paths).toEqual([]);
  expect(records.untracked).toEqual([]);
});

test('pairs raw and numstat records, including renames, binaries and odd names', () => {
  expect(parseDiffRecords(RAW_NUMSTAT)).toEqual([
    { path: 'bin.dat', letter: 'M', oldMode: '100644', newMode: '100644', oldSha: BIN_SHA, added: null, removed: null },
    { path: 'mode.sh', letter: 'M', oldMode: '100644', newMode: '100755', oldSha: MODE_SHA, added: 0, removed: 0 },
    { path: 'renamed.txt', oldPath: 'ren.txt', letter: 'R', oldMode: '100644', newMode: '100644', oldSha: REN_SHA, added: 1, removed: 1 },
    { path: 'tc.txt', letter: 'T', oldMode: '100644', newMode: '120000', oldSha: TC_SHA, added: 1, removed: 1 },
    { path: 'line\nbreak.txt', letter: 'M', oldMode: '100644', newMode: '100644', oldSha: LB_SHA, added: 2, removed: 0 },
  ]);
});

test('names entry kinds by mode', () => {
  expect([entryKind('100644'), entryKind('100755'), entryKind('120000'), entryKind('160000')]).toEqual(['file', 'file', 'symlink', 'submodule']);
});
