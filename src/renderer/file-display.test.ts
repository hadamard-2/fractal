import { expect, test } from 'vitest';
import { absoluteProjectPath, basename, formatSize, languageFor } from './file-display';

test('names a file by its last path segment', () => {
  expect(basename('src/components/a.tsx')).toBe('a.tsx');
  expect(basename('C:\\repo\\a.ts')).toBe('a.ts');
});

test('formats sizes in B, KiB and MiB', () => {
  expect(formatSize(512)).toBe('512 B');
  expect(formatSize(1536)).toBe('1.5 KiB');
  expect(formatSize(14 * 1024 * 1024)).toBe('14.0 MiB');
});

test('picks a language from the extension, or from the name of a file without one', () => {
  expect(languageFor('src/a.ts')).toBe('ts');
  expect(languageFor('vite.renderer.config.mts')).toBe('mts');
  expect(languageFor('Dockerfile')).toBe('dockerfile');
  expect(languageFor('notes.unknownext')).toBeUndefined();
});

test('joins a project-relative path onto its root with the root\'s separator', () => {
  expect(absoluteProjectPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
  expect(absoluteProjectPath('/repo/', 'a.ts')).toBe('/repo/a.ts');
  expect(absoluteProjectPath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts');
});
