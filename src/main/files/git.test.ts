import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ignoredNames, listGitFiles } from './git';

let root: string;
let plain: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-git-')));
  plain = await realpath(await mkdtemp(join(tmpdir(), 'fractal-plain-')));
  execFileSync('git', ['-C', root, 'init', '-q']);
  await writeFile(join(root, '.gitignore'), 'out/\n*.log\n');
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'out', 'c.js'), 'c');
  await writeFile(join(root, 'a.log'), 'log');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'b.ts'), 'b');
  await writeFile(join(root, 'README.md'), 'r');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
});

test('names the ignored files and folders in a repository directory', async () => {
  expect(await ignoredNames(root, ['out', 'a.log', 'src', 'README.md'])).toEqual(new Set(['out', 'a.log']));
  expect(await ignoredNames(join(root, 'src'), ['b.ts'])).toEqual(new Set());
  expect(await ignoredNames(root, [])).toEqual(new Set());
});

test('ignores nothing outside a repository', async () => {
  await writeFile(join(plain, 'x.log'), 'x');
  expect(await ignoredNames(plain, ['x.log'])).toEqual(new Set());
});

test('lists tracked and untracked files but not ignored ones', async () => {
  const list = await listGitFiles(root, 100);
  expect(list?.truncated).toBe(false);
  expect(list?.paths.sort()).toEqual(['.gitignore', 'README.md', 'src/b.ts']);
});

test('stops listing at the cap and says so', async () => {
  const list = await listGitFiles(root, 2);
  expect(list).toMatchObject({ truncated: true });
  expect(list?.paths).toHaveLength(2);
});

test('lists nothing outside a repository', async () => {
  expect(await listGitFiles(plain, 100)).toBeUndefined();
});
