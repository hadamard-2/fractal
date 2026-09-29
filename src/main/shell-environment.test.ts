import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { mergeSearchPath, resolveLoginShellPath } from './shell-environment';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A stand-in login shell: a POSIX script that runs the `-c` command after doing `body`. */
function fakeShell(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-shell-'));
  dirs.push(dir);
  const file = path.join(dir, 'fake-shell');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test('reads the PATH the login shell sets up, ignoring what its startup files print', async () => {
  const shell = fakeShell([
    'echo "Welcome back"',
    'PATH=/home/me/.nvm/bin:/usr/bin:/bin; export PATH',
    '/bin/sh -c "$2"',
    'echo "bye"',
  ].join('\n'));
  const result = await resolveLoginShellPath({ platform: 'linux', env: { SHELL: shell, PATH: '/usr/bin:/bin' } });
  expect(result).toEqual({ resolution: { status: 'resolved', shell }, path: '/home/me/.nvm/bin:/usr/bin:/bin' });
});

test('runs the shell as an interactive login shell so rc-file PATH entries are included', async () => {
  const shell = fakeShell('PATH="/flags/$(echo "$1" | tr -d -- -):/usr/bin:/bin"; export PATH\n/bin/sh -c "$2"');
  const result = await resolveLoginShellPath({ platform: 'linux', env: { SHELL: shell, PATH: '/usr/bin:/bin' } });
  expect(result.path?.split(':')[0]).toBe('/flags/ilc');
});

test('gives up after the timeout and reports it instead of blocking startup', async () => {
  const shell = fakeShell('sleep 5');
  const started = Date.now();
  const result = await resolveLoginShellPath({ platform: 'linux', env: { SHELL: shell, PATH: '/usr/bin:/bin' }, timeoutMs: 200 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(result).toEqual({ resolution: { status: 'failed', shell, reason: 'timed out after 200 ms' } });
});

test('reports a shell that exits without printing the PATH', async () => {
  const shell = fakeShell('exit 3');
  const result = await resolveLoginShellPath({ platform: 'linux', env: { SHELL: shell, PATH: '/usr/bin:/bin' } });
  expect(result).toEqual({ resolution: { status: 'failed', shell, reason: 'exited with code 3 before printing PATH' } });
});

test('reports a shell that cannot be started', async () => {
  const shell = '/nonexistent/fractal-shell';
  const result = await resolveLoginShellPath({ platform: 'linux', env: { SHELL: shell, PATH: '/usr/bin:/bin' } });
  expect(result.resolution).toMatchObject({ status: 'failed', shell });
  expect(result.resolution.status === 'failed' && result.resolution.reason).toMatch(/could not start/);
  expect(result.path).toBeUndefined();
});

test('falls back to /bin/sh when SHELL is unset', async () => {
  const result = await resolveLoginShellPath({ platform: 'linux', env: { PATH: '/usr/bin:/bin' } });
  expect(result.resolution).toMatchObject({ shell: '/bin/sh' });
});

test('skips Windows, where GUI apps already receive the registry PATH', async () => {
  const result = await resolveLoginShellPath({ platform: 'win32', env: { PATH: 'C:\\Windows' } });
  expect(result).toEqual({ resolution: { status: 'skipped', reason: 'not needed on Windows' } });
});

test('merging keeps the inherited PATH first and only appends directories it lacks', () => {
  expect(mergeSearchPath('/project/node_modules/.bin:/usr/bin:/bin', '/home/me/.local/bin:/usr/bin::/bin:/home/me/.local/bin', ':'))
    .toBe('/project/node_modules/.bin:/usr/bin:/bin:/home/me/.local/bin');
  expect(mergeSearchPath(undefined, '/usr/bin:/bin', ':')).toBe('/usr/bin:/bin');
});
