import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ChangedFile, ChangesResult } from '@/shared/changes-contract';
import { readChanges } from './changes-service';

const created: string[] = [];
let root: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fractal-changes-')));
  created.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}

const write = (path: string, content: string | Buffer) => writeFile(join(root, path), content);
const commitAll = (message = 'commit') => {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
};

async function changes(options: { fingerprint?: string; at?: string; limits?: Parameters<typeof readChanges>[2] } = {}) {
  const result = await readChanges(options.at ?? root, options.fingerprint, options.limits);
  if (result.kind !== 'changes') throw new Error(`expected changes, got ${JSON.stringify(result)}`);
  return result;
}
const byPath = (files: ChangedFile[], path: string) => {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`no ${path} in ${files.map((candidate) => candidate.path).join(', ')}`);
  return file;
};
const addedTexts = (file: ChangedFile) =>
  file.body.kind === 'hunks' ? file.body.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'added').map((line) => line.text) : [];
const numbered = (count: number, tag = 'line') => Array.from({ length: count }, (_, index) => `${tag} ${index}\n`).join('');

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  root = await makeRepo();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('a clean repository has no changes; a folder that is not a repository says so', async () => {
  await write('a.txt', 'a\n');
  commitAll();
  const result = await changes();
  expect(result).toMatchObject({ files: [], truncated: false, head: { branch: 'main' } });

  const plain = await realpath(await mkdtemp(join(tmpdir(), 'fractal-plain-')));
  created.push(plain);
  expect(await readChanges(plain)).toEqual({ kind: 'not-a-repo' });
});

test('reports git as unavailable when it cannot start', async () => {
  vi.stubEnv('PATH', '');
  expect(await readChanges(root)).toEqual({ kind: 'git-unavailable' });
});

test('names each kind of change', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5]);
  const deletedBinary = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  await write('modified.txt', 'one\ntwo\nthree\n');
  await write('deleted.txt', 'bye\n');
  await write('old-name.txt', numbered(20, 'keep'));
  await write('script.sh', '#!/bin/sh\n');
  await write('becomes-link', 'plain\n');
  await write('image.bin', Buffer.from([0, 1, 2]));
  await write('gone.bin', deletedBinary);
  commitAll();

  await write('modified.txt', 'one\n2\nthree\n');
  await write('staged.txt', 'new\n');
  git(root, 'add', 'staged.txt');
  await rm(join(root, 'deleted.txt'));
  git(root, 'mv', 'old-name.txt', 'new-name.txt');
  await write('new-name.txt', `${numbered(20, 'keep')}extra\n`);
  await write('untracked.txt', 'u1\nu2');
  await chmod(join(root, 'script.sh'), 0o755);
  await rm(join(root, 'becomes-link'));
  await symlink('target-file', join(root, 'becomes-link'));
  await write('image.bin', png);
  await rm(join(root, 'gone.bin'));

  const { files } = await changes();
  expect(files.map((file) => file.path)).toEqual([
    'becomes-link', 'deleted.txt', 'gone.bin', 'image.bin', 'modified.txt', 'new-name.txt', 'script.sh', 'staged.txt', 'untracked.txt',
  ]);

  expect(byPath(files, 'modified.txt')).toMatchObject({ status: 'modified', added: 1, removed: 1, collapsed: false, body: { kind: 'hunks' } });
  expect(byPath(files, 'staged.txt')).toMatchObject({ status: 'added', added: 1, removed: 0 });
  expect(addedTexts(byPath(files, 'staged.txt'))).toEqual(['new']);
  expect(byPath(files, 'deleted.txt')).toMatchObject({ status: 'deleted', added: 0, removed: 1 });
  expect(byPath(files, 'new-name.txt')).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt', added: 1, removed: 0 });
  expect(byPath(files, 'script.sh')).toMatchObject({ status: 'modified', body: { kind: 'mode', oldMode: '100644', newMode: '100755' } });
  expect(byPath(files, 'becomes-link')).toMatchObject({ status: 'type-changed', body: { kind: 'type-change', from: 'file', to: 'symlink' } });
  expect(byPath(files, 'image.bin')).toMatchObject({ status: 'modified', added: null, removed: null, body: { kind: 'binary', size: png.length } });
  expect(byPath(files, 'gone.bin')).toMatchObject({ status: 'deleted', body: { kind: 'binary', size: deletedBinary.length } });

  const untracked = byPath(files, 'untracked.txt');
  expect(untracked).toMatchObject({ status: 'added', added: 2, removed: 0, collapsed: false });
  expect(untracked.body).toEqual({
    kind: 'hunks',
    hunks: [{
      header: '',
      oldStart: 0,
      newStart: 1,
      lines: [
        { kind: 'added', text: 'u1', newNumber: 1 },
        { kind: 'added', text: 'u2', newNumber: 2 },
        { kind: 'no-newline', text: ' No newline at end of file' },
      ],
    }],
  });
});

test('marks a conflicted file and shows its conflict markers as additions', async () => {
  await write('c.txt', 'base\n');
  commitAll();
  git(root, 'checkout', '-q', '-b', 'other');
  await write('c.txt', 'other\n');
  commitAll('other');
  git(root, 'checkout', '-q', 'main');
  await write('c.txt', 'main\n');
  commitAll('main');
  expect(() => git(root, 'merge', 'other')).toThrow();

  const { files } = await changes();
  expect(files.map((file) => file.path)).toEqual(['c.txt']);
  expect(files[0].status).toBe('conflicted');
  expect(files[0].body.kind).toBe('hunks');
  expect(addedTexts(files[0])).toContain('<<<<<<< HEAD');
});

test('reports a submodule move', async () => {
  const origin = await makeRepo();
  await writeFile(join(origin, 'f.txt'), 'f\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'init');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, 'sub');
  commitAll('add submodule');

  const sub = join(root, 'sub');
  git(sub, 'config', 'user.name', 'Test');
  git(sub, 'config', 'user.email', 'test@example.com');
  await writeFile(join(sub, 'g.txt'), 'g\n');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '-m', 'move');
  const commit = git(sub, 'rev-parse', 'HEAD').trim();

  const { files } = await changes();
  expect(byPath(files, 'sub')).toMatchObject({ status: 'modified', body: { kind: 'submodule', commit } });
});

test('diffs against the empty tree before the first commit', async () => {
  await write('first.txt', 'hello\n');
  git(root, 'add', 'first.txt');
  const result = await changes();
  expect(result.head).toEqual({ branch: 'main' });
  expect(byPath(result.files, 'first.txt')).toMatchObject({ status: 'added', added: 1, removed: 0 });
  expect(addedTexts(byPath(result.files, 'first.txt'))).toEqual(['hello']);
});

test('keeps unusual names intact', async () => {
  const names = ['with space.txt', 'ünï.txt', 'line\nbreak.txt'];
  for (const name of names) await write(name, 'x\n');
  commitAll();
  for (const name of names) await write(name, 'y\n');
  const { files } = await changes();
  expect(files.map((file) => file.path).sort()).toEqual([...names].sort());
  for (const name of names) expect(byPath(files, name)).toMatchObject({ status: 'modified', added: 1, removed: 1 });
});

test('returns unchanged for an unchanged tree, and a new fingerprint after each kind of edit', async () => {
  await write('a.txt', 'a\n');
  commitAll();
  await write('a.txt', 'changed\n');
  const first = await changes();
  expect(await readChanges(root, first.fingerprint)).toEqual({ kind: 'unchanged', fingerprint: first.fingerprint });

  await write('a.txt', 'changed again, longer\n');
  const second = await changes({ fingerprint: first.fingerprint });
  expect(second.fingerprint).not.toBe(first.fingerprint);

  await write('new.txt', 'n\n');
  const third = await changes({ fingerprint: second.fingerprint });
  expect(third.fingerprint).not.toBe(second.fingerprint);

  commitAll();
  const fourth = await changes({ fingerprint: third.fingerprint });
  expect(fourth.fingerprint).not.toBe(third.fingerprint);
  expect(fourth.files).toEqual([]);
});

test('applies the size bounds', async () => {
  await write('small.txt', numbered(20));
  await write('big.txt', numbered(700));
  await write('late.txt', numbered(20));
  commitAll();

  await write('small.txt', numbered(20, 'edit'));
  const tight = { fileMaxLines: 10, fileMaxBytes: 1_000_000, totalMaxBytes: 1_000_000 };
  const limited = await changes({ limits: tight });
  expect(byPath(limited.files, 'small.txt')).toMatchObject({ added: 20, removed: 20, body: { kind: 'too-large' } });

  await write('big.txt', numbered(700, 'edit'));
  const { files } = await changes();
  expect(byPath(files, 'big.txt')).toMatchObject({ added: 700, removed: 700, collapsed: true, body: { kind: 'hunks' } });
  expect(byPath(files, 'small.txt').collapsed).toBe(false);

  await write('late.txt', numbered(20, 'edit'));
  const total = await changes({ limits: { fileMaxLines: 5_000, fileMaxBytes: 1_000_000, totalMaxBytes: 2_000 } });
  expect(total.truncated).toBe(true);
  expect(byPath(total.files, 'late.txt').body).toEqual({ kind: 'not-loaded' });
});

test('treats untracked files over the per-file bounds as too large', async () => {
  await write('tracked.txt', 't\n');
  commitAll();
  await write('long.txt', numbered(30));
  const { files } = await changes({ limits: { fileMaxLines: 10, fileMaxBytes: 1_000_000, totalMaxBytes: 1_000_000 } });
  expect(byPath(files, 'long.txt')).toMatchObject({ status: 'added', added: 30, removed: 0, body: { kind: 'too-large' } });
});

test('shows only the project folder of a larger repository, relative to it', async () => {
  await mkdir(join(root, 'app'));
  await mkdir(join(root, 'other'));
  await write('app/a', 'a\n');
  await write('other/b', 'b\n');
  commitAll();
  await write('app/a', 'a2\n');
  await write('app/new', 'n\n');
  await write('other/b', 'b2\n');
  await write('other/new-other', 'n\n');

  const { files } = await changes({ at: join(root, 'app') });
  expect(files.map((file) => file.path)).toEqual(['a', 'new']);
  expect(byPath(files, 'a')).toMatchObject({ status: 'modified', added: 1, removed: 1 });
});

test('parses the same with diff-reshaping git config', async () => {
  const setup = async () => {
    await write('a.txt', 'one\n\ntwo\nthree\nfour\n');
    await write('b.txt', 'b\n');
    commitAll();
    await write('a.txt', 'one\n\ntwo\nTHREE\nfour\n');
    await write('c.txt', 'c\n');
  };
  await setup();
  const plain = await changes();

  const configured = await makeRepo();
  root = configured;
  await setup();
  for (const [key, value] of [
    ['diff.suppressBlankEmpty', 'true'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'],
    ['color.ui', 'always'], ['diff.context', '10'], ['diff.external', 'false'],
  ]) git(configured, 'config', key, value);

  const reshaped = await changes();
  expect(reshaped.files).toEqual(plain.files);
  expect(reshaped.head).toEqual(plain.head);
});

test('reads while another git holds the index lock, and creates nothing', async () => {
  await write('a.txt', 'a\n');
  commitAll();
  await write('a.txt', 'b\n');
  await write('new.txt', 'n\n');
  await write('.git/index.lock', '');

  const snapshot = async () => {
    const entries: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { entries.push(`${path}/`); await walk(path); continue; }
        const stats = await lstat(path);
        entries.push(`${path} ${stats.size} ${stats.mtimeMs}`);
      }
    };
    await walk(join(root, '.git'));
    return entries;
  };
  const before = await snapshot();
  const result = await changes();
  expect(result.files.map((file) => file.path)).toEqual(['a.txt', 'new.txt']);
  expect(await snapshot()).toEqual(before);
  expect(await readFile(join(root, '.git', 'index.lock'), 'utf8')).toBe('');
});

test('tolerates untracked entries that vanish, link, or nest', async () => {
  await write('tracked.txt', 't\n');
  commitAll();
  await symlink('some/target', join(root, 'link'));
  const nested = join(root, 'nested');
  await mkdir(nested);
  git(nested, 'init', '-q', '-b', 'main');
  await writeFile(join(nested, 'inner.txt'), 'i\n');
  await write('kept.txt', 'k\n');
  await write('vanishes.txt', 'v\n');

  const realLstat = lstat;
  let calls = 0;
  const result = await readChanges(root, undefined, undefined, {
    lstat: ((path: string, ...rest: never[]) => {
      if (String(path).endsWith('vanishes.txt') && ++calls > 1) return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      return realLstat(path, ...rest);
    }) as typeof lstat,
  });
  if (result.kind !== 'changes') throw new Error(JSON.stringify(result));
  expect(result.files.map((file) => file.path)).toEqual(['kept.txt', 'link', 'nested']);
  expect(byPath(result.files, 'link').body).toEqual({
    kind: 'hunks',
    hunks: [{ header: '', oldStart: 0, newStart: 1, lines: [{ kind: 'added', text: 'some/target', newNumber: 1 }, { kind: 'no-newline', text: ' No newline at end of file' }] }],
  });
  expect(byPath(result.files, 'nested')).toMatchObject({ status: 'added', added: null, removed: null, body: { kind: 'folder' } });

  const afterRead = await readChanges(root, undefined, undefined, {
    readFile: async (path) => {
      await rename(path, `${path}.moved`);
      return readFile(`${path}.moved`);
    },
  });
  if (afterRead.kind !== 'changes') throw new Error(JSON.stringify(afterRead));
  expect(afterRead.files.map((file) => file.path)).toContain('link');
});

test('a file that disappears before it is read is simply absent', async () => {
  await write('a.txt', 'a\n');
  commitAll();
  await write('vanishes.txt', 'v\n');
  await write('stays.txt', 's\n');
  const result = await readChanges(root, undefined, undefined, {
    readFile: async (path) => {
      if (path.endsWith('vanishes.txt')) {
        await rm(path);
      }
      return readFile(path);
    },
  });
  if (result.kind !== 'changes') throw new Error(JSON.stringify(result));
  expect(result.files.map((file) => file.path)).toEqual(['stays.txt']);
});

test('reports an error rather than a partial result when git fails', async () => {
  await write('a.txt', 'a\n');
  commitAll();
  await write('.git/index', 'garbage');
  const result: ChangesResult = await readChanges(root);
  expect(result).toEqual({ kind: 'error', message: "Changes couldn't be read" });
});
