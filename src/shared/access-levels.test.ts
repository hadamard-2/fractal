import { expect, test } from 'vitest';
import { accessLevels, findAccessLevel, sameAccess } from '@/shared/access-levels';

test("lists each agent's levels in order of increasing autonomy", () => {
  expect(accessLevels('claude').map((l) => [l.id, l.label, l.dangerous])).toEqual([
    ['plan', 'Plan', false], ['default', 'Ask', false], ['acceptEdits', 'Accept edits', false], ['auto', 'Auto', false], ['bypassPermissions', 'Bypass', true],
  ]);
  expect(accessLevels('codex').map((l) => [l.id, l.label, l.dangerous])).toEqual([
    ['read-only', 'Read-only', false], ['auto', 'Auto', false], ['auto-review', 'Auto-review', false], ['full-access', 'Full access', true],
  ]);
});

test('describes every level in the exact catalog copy', () => {
  expect(accessLevels('claude').map((l) => l.description)).toEqual([
    'Reads and proposes a plan; no edits until you approve it.',
    'Reads freely; asks before edits and commands.',
    'Edits files without asking; asks before other commands.',
    'Acts without asking; a safety check reviews each action.',
    'Acts without asking and without any safety check.',
  ]);
  expect(accessLevels('codex').map((l) => l.description)).toEqual([
    'Reads and runs read-only commands; asks to do more.',
    'Edits and runs commands in the workspace; asks to go outside it.',
    'Like Auto, but a reviewer agent answers its requests instead of you.',
    'Runs any command with no sandbox and never asks.',
  ]);
});

test('returns copies, so a caller cannot change the catalog', () => {
  accessLevels('codex')[0].label = 'x';
  expect(accessLevels('codex')[0].label).toBe('Read-only');
});

test('finds a level by id within one agent only', () => {
  expect(findAccessLevel('claude', 'bypassPermissions')).toMatchObject({ label: 'Bypass', dangerous: true });
  expect(findAccessLevel('codex', 'auto')?.description).toBe('Edits and runs commands in the workspace; asks to go outside it.');
  expect(findAccessLevel('codex', 'plan')).toBeUndefined();
});

test('compares states by level id, or by custom label and mode', () => {
  expect(sameAccess({ kind: 'level', level: 'auto' }, { kind: 'level', level: 'auto' })).toBe(true);
  expect(sameAccess({ kind: 'level', level: 'auto' }, { kind: 'level', level: 'plan' })).toBe(false);
  expect(sameAccess({ kind: 'level', level: 'auto' }, { kind: 'custom', label: 'auto' })).toBe(false);
  expect(sameAccess({ kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' })).toBe(true);
  expect(sameAccess({ kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, { kind: 'custom', label: 'dontAsk' })).toBe(false);
});
