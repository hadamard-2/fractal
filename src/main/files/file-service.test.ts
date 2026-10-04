import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FILE_VIEW_MAX_BYTES } from '@/shared/files-contract';
import { listDirectory, listProjectFiles, readProjectFile } from './file-service';
import { OutsideProjectError } from './project-paths';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-files-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'fractal-outside-')));
  execFileSync('git', ['-C', root, 'init', '-q']);
  await writeFile(join(root, '.gitignore'), 'out/\n');
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'out', 'built.js'), 'x');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'a2.txt'), '2');
  await writeFile(join(root, 'a10.txt'), '10');
  await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(root, 'big.txt'), Buffer.alloc(FILE_VIEW_MAX_BYTES + 1, 0x61));
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(root, 'leak'));
  await symlink(join(root, 'src'), join(root, 'src-link'));
  await symlink(join(root, 'nowhere'), join(root, 'dangling'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('listDirectory', () => {
  test('lists folders first in natural order, hides .git, and marks ignored entries and links', async () => {
    const entries = await listDirectory(root, '');
    const names = entries.map((entry) => entry.name);
    expect(names.slice(0, 3)).toEqual(['out', 'src', 'src-link']);
    expect(names.indexOf('a2.txt')).toBeLessThan(names.indexOf('a10.txt'));
    expect(names).not.toContain('.git');
    expect(entries.find((entry) => entry.name === 'out')).toMatchObject({ kind: 'directory', ignored: true });
    expect(entries.find((entry) => entry.name === 'src')).toMatchObject({ kind: 'directory', ignored: false, symlink: false });
    expect(entries.find((entry) => entry.name === 'src-link')).toMatchObject({ kind: 'directory', symlink: true, outside: false });
    expect(entries.find((entry) => entry.name === 'leak')).toMatchObject({ kind: 'file', symlink: true, outside: true });
    expect(entries.find((entry) => entry.name === 'dangling')).toMatchObject({ kind: 'file', symlink: true, outside: false });
  });

  test('marks nothing ignored outside a repository', async () => {
    await rm(join(root, '.git'), { recursive: true, force: true });
    expect((await listDirectory(root, '')).find((entry) => entry.name === 'out')?.ignored).toBe(false);
  });

  test('refuses a folder outside the project', async () => {
    await expect(listDirectory(root, '..')).rejects.toBeInstanceOf(OutsideProjectError);
  });
});

describe('readProjectFile', () => {
  test('returns text, binary, and too-large files', async () => {
    await expect(readProjectFile(root, 'src/a.ts')).resolves.toEqual({ kind: 'text', content: 'export const a = 1;\n', size: 20 });
    await expect(readProjectFile(root, 'bin.dat')).resolves.toEqual({ kind: 'binary', size: 3 });
    await expect(readProjectFile(root, 'big.txt')).resolves.toEqual({ kind: 'too-large', size: FILE_VIEW_MAX_BYTES + 1 });
  });

  test('reports missing and unreadable paths instead of failing', async () => {
    await expect(readProjectFile(root, 'src/gone.ts')).resolves.toEqual({ kind: 'missing' });
    await expect(readProjectFile(root, 'dangling')).resolves.toEqual({ kind: 'missing' });
    await expect(readProjectFile(root, 'src')).resolves.toEqual({ kind: 'unreadable' });
  });

  test('refuses files outside the project', async () => {
    await expect(readProjectFile(root, 'leak')).rejects.toBeInstanceOf(OutsideProjectError);
    await expect(readProjectFile(root, '../secret')).rejects.toBeInstanceOf(OutsideProjectError);
  });
});

describe('listProjectFiles', () => {
  test('uses git in a repository, leaving out ignored files', async () => {
    const list = await listProjectFiles(root);
    expect(list.truncated).toBe(false);
    expect(list.paths).toContain('src/a.ts');
    expect(list.paths).not.toContain('out/built.js');
  });

  test('walks a folder that is not a repository, skipping .git and stopping at the cap', async () => {
    await rm(join(root, '.git'), { recursive: true, force: true });
    const all = await listProjectFiles(root);
    expect(all.paths).toContain('out/built.js');
    expect(all.paths).toContain('src/a.ts');
    await expect(listProjectFiles(root, 2)).resolves.toMatchObject({ truncated: true, paths: expect.any(Array) });
    expect((await listProjectFiles(root, 2)).paths).toHaveLength(2);
  });
});
