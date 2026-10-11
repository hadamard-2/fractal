// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { DefaultFileIcon, DefaultFolderIcon } from '@react-symbols/icons/utils';
import { afterEach, expect, test } from 'vitest';
import { FileTypeIcon, FolderTypeIcon } from './file-icons';

afterEach(cleanup);

const markup = (element: React.ReactElement) => render(element).container.innerHTML;

test('gives a known file type its own icon, not the generic file', () => {
  expect(markup(<FileTypeIcon path="src/app.ts" />)).not.toBe(markup(<DefaultFileIcon />));
});

test('picks the icon from the file name, whatever folder it is in', () => {
  expect(markup(<FileTypeIcon path="src/components/app.ts" />)).toBe(markup(<FileTypeIcon path="app.ts" />));
});

test('gives a known folder its own icon, not the generic folder', () => {
  expect(markup(<FolderTypeIcon name="src" />)).not.toBe(markup(<DefaultFolderIcon />));
});

test('hides the icons from assistive tech, since the name beside them says it all', () => {
  const { container } = render(<><FileTypeIcon path="a.ts" /><FolderTypeIcon name="src" /></>);
  for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('aria-hidden')).toBe('true');
});
