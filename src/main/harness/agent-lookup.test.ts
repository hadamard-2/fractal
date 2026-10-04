import { expect, test } from 'vitest';
import { lookUpAgent } from '@/main/harness/agent-lookup';

const executables = (...files: string[]) => async (file: string) => files.includes(file);

test('finds a bare name in the first absolute PATH folder that has it', async () => {
  await expect(lookUpAgent('claude', 'linux', 'bin:/usr/bin:/home/me/.local/bin', executables('bin/claude', '/home/me/.local/bin/claude')))
    .resolves.toEqual({ status: 'found', path: '/home/me/.local/bin/claude' });
});

test('checks a configured path directly instead of searching', async () => {
  await expect(lookUpAgent('/opt/claude', 'linux', '/usr/bin', executables('/usr/bin/claude'))).resolves.toEqual({ status: 'not-found' });
  await expect(lookUpAgent('/opt/claude', 'linux', '', executables('/opt/claude'))).resolves.toEqual({ status: 'found', path: '/opt/claude' });
});

test('does not look anything up on Windows', async () => {
  await expect(lookUpAgent('claude', 'win32', 'C:\\bin', executables())).resolves.toEqual({ status: 'unchecked' });
});
