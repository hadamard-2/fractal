import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { isInside, isMissing, OutsideProjectError, resolveInProject, resolveParentInProject } from './project-paths';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-project-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'fractal-outside-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'a');
  await mkdir(join(root, 'node_modules', '.pnpm', 'react'), { recursive: true });
  await symlink(join(root, 'node_modules', '.pnpm', 'react'), join(root, 'node_modules', 'react'));
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(root, 'leak'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('compares whole path segments', () => {
  expect(isInside('/repo', '/repo')).toBe(true);
  expect(isInside('/repo', '/repo/a')).toBe(true);
  expect(isInside('/repo', '/repo/..foo')).toBe(true);
  expect(isInside('/repo', '/repo-other')).toBe(false);
  expect(isInside('/repo', '/')).toBe(false);
});

test('resolves paths inside the project, including symlinks that stay inside', async () => {
  await expect(resolveInProject(root, '')).resolves.toEqual({ realRoot: root, lexical: root, real: root });
  await expect(resolveInProject(root, 'src/a.ts')).resolves.toMatchObject({ real: join(root, 'src', 'a.ts') });
  await expect(resolveInProject(root, 'node_modules/react')).resolves.toEqual({ realRoot: root, lexical: join(root, 'node_modules', 'react'), real: join(root, 'node_modules', '.pnpm', 'react') });
});

test('rejects ../ escapes and symlinks that lead out of the project', async () => {
  await expect(resolveInProject(root, '../x')).rejects.toBeInstanceOf(OutsideProjectError);
  await expect(resolveInProject(root, 'src/../../x')).rejects.toBeInstanceOf(OutsideProjectError);
  await expect(resolveInProject(root, 'leak')).rejects.toBeInstanceOf(OutsideProjectError);
});

test('reports a missing path as missing, but a missing path that escapes as outside', async () => {
  expect(isMissing(await resolveInProject(root, 'src/gone.ts').catch((error: unknown) => error))).toBe(true);
  expect(isMissing(await resolveInProject(root, 'src/a.ts/x').catch((error: unknown) => error))).toBe(true);
  await expect(resolveInProject(root, '../gone')).rejects.toBeInstanceOf(OutsideProjectError);
});

test('resolves the folder of a file that may not exist', async () => {
  await expect(resolveParentInProject(root, 'src/new.ts')).resolves.toEqual({ realParent: join(root, 'src'), name: 'new.ts' });
  await expect(resolveParentInProject(root, '')).rejects.toBeInstanceOf(OutsideProjectError);
  await expect(resolveParentInProject(root, '../x')).rejects.toBeInstanceOf(OutsideProjectError);
});
