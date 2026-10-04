import { expect, test } from 'vitest';
import { filterPaths } from './file-filter';

const paths = ['src/readme/index.ts', 'README.md', 'docs/guide/readme-notes.md', 'src/app.ts'];

test('matches paths ignoring case, file-name matches first, then shorter paths', () => {
  expect(filterPaths(paths, 'readme', 10)).toEqual(['README.md', 'docs/guide/readme-notes.md', 'src/readme/index.ts']);
});

test('returns nothing for a blank query and stops at the limit', () => {
  expect(filterPaths(paths, '   ', 10)).toEqual([]);
  expect(filterPaths(paths, 's', 2)).toHaveLength(2);
});
