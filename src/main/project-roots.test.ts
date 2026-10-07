import { expect, test, vi } from 'vitest';
import { createRootCheck, UnknownProjectError } from './project-roots';

test('refuses unknown roots and asks about a known root only once', async () => {
  const knowsProject = vi.fn(async (path: string) => path === '/known');
  const check = createRootCheck(knowsProject);
  await expect(check('/other')).rejects.toBeInstanceOf(UnknownProjectError);
  await check('/known');
  await check('/known');
  expect(knowsProject.mock.calls.filter(([path]) => path === '/known')).toHaveLength(1);
});
