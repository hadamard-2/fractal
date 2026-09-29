import { expect, test } from 'vitest';
import { configuredExecutable, executableNotFoundMessage } from './executable';

test('a bare name that is not found points at PATH and Settings', () => {
  expect(executableNotFoundMessage('claude')).toBe("Couldn't find \"claude\" on the PATH Fractal searches. Set its location in Settings.");
});

test('a configured path that is not found names the path', () => {
  expect(executableNotFoundMessage('/opt/codex/bin/codex')).toBe("Couldn't find /opt/codex/bin/codex. Check its location in Settings.");
  expect(executableNotFoundMessage('C:\\Tools\\codex.exe')).toBe("Couldn't find C:\\Tools\\codex.exe. Check its location in Settings.");
});

test('an empty setting falls back to the bare name, and ~ expands to the home directory', () => {
  expect(configuredExecutable('', 'claude', '/home/me')).toBe('claude');
  expect(configuredExecutable('~/bin/claude', 'claude', '/home/me')).toBe('/home/me/bin/claude');
  expect(configuredExecutable('/opt/claude', 'claude', '/home/me')).toBe('/opt/claude');
  expect(configuredExecutable('~', 'claude', '/home/me')).toBe('/home/me');
});
