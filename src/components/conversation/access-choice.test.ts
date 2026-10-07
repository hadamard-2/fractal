import { expect, test } from 'vitest';
import { accessLevels } from '@/shared/access-levels';
import { accessStateLabel, accessTriggerLabel, nextAccessLevel, visibleAccessLevels } from './access-choice';

const claudeLevels = accessLevels('claude');
const codexLevels = accessLevels('codex');

test('labels the default, levels and custom states', () => {
  expect(accessTriggerLabel('claude', null, claudeLevels)).toBe("Claude's default");
  expect(accessTriggerLabel('codex', null, codexLevels)).toBe("Codex's default");
  expect(accessTriggerLabel('claude', { state: { kind: 'level', level: 'default' }, picked: false }, claudeLevels)).toBe('Ask');
  expect(accessTriggerLabel('codex', { state: { kind: 'custom', label: 'read-only · never ask' }, picked: false }, codexLevels)).toBe('Custom: read-only · never ask');
});

test('labels a level missing from the catalog by its id', () => {
  expect(accessStateLabel({ kind: 'level', level: 'mystery' }, claudeLevels)).toBe('mystery');
});

test('shows a dangerous level only when allowed or already current', () => {
  expect(visibleAccessLevels(claudeLevels, false, null).map((l) => l.id)).not.toContain('bypassPermissions');
  expect(visibleAccessLevels(claudeLevels, true, null).map((l) => l.id)).toContain('bypassPermissions');
  expect(visibleAccessLevels(claudeLevels, false, { state: { kind: 'level', level: 'bypassPermissions' }, picked: true }).map((l) => l.id)).toContain('bypassPermissions');
});

test('cycles forward through safe levels, wrapping, starting from the first', () => {
  expect(nextAccessLevel(claudeLevels, null)).toBe('plan');
  expect(nextAccessLevel(claudeLevels, { state: { kind: 'level', level: 'acceptEdits' }, picked: true })).toBe('auto');
  expect(nextAccessLevel(claudeLevels, { state: { kind: 'level', level: 'auto' }, picked: true })).toBe('plan');
  expect(nextAccessLevel(claudeLevels, { state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).toBe('plan');
  expect(nextAccessLevel([], null)).toBeUndefined();
});
