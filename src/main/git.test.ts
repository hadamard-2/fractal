import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { streamGitLines } from './git';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-main-git-')));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fractal Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fractal-test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
  await writeFile(join(root, 'three.txt'), 'a\nb\r\nc');
  execFileSync('git', ['-C', root, 'add', 'three.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'add three']);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test('streams lines, including a final line without a newline', async () => {
  const lines: string[] = [];
  const result = await streamGitLines(root, ['show', 'HEAD:three.txt'], (line) => { lines.push(line); return true; });
  expect(result).toEqual({ code: 0, stopped: false });
  expect(lines).toEqual(['a', 'b\r', 'c']);
});

test('stops when the consumer returns false', async () => {
  const lines: string[] = [];
  const result = await streamGitLines(root, ['show', 'HEAD:three.txt'], (line) => { lines.push(line); return false; });
  expect(result.stopped).toBe(true);
  expect(lines).toEqual(['a']);
});

test('reports a git that cannot start', async () => {
  vi.stubEnv('PATH', '');
  expect(await streamGitLines(root, ['status'], () => true)).toEqual({ code: null, stopped: false });
});
