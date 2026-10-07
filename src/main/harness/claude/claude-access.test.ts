import { describe, expect, test } from 'vitest';
import { claudeAccessState, claudePermissionMode } from './claude-access';

describe('Claude access mapping', () => {
  test('sends a level as its id and a custom state as its mode, picked or read back', () => {
    expect(claudePermissionMode({ state: { kind: 'level', level: 'acceptEdits' }, picked: true })).toBe('acceptEdits');
    expect(claudePermissionMode({ state: { kind: 'level', level: 'plan' }, picked: false })).toBe('plan');
    expect(claudePermissionMode({ state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).toBe('dontAsk');
    expect(claudePermissionMode({ state: { kind: 'custom', label: 'x' }, picked: false })).toBeUndefined();
    expect(claudePermissionMode(undefined)).toBeUndefined();
  });

  test('maps a recorded mode to a level, the manual alias to Ask, and anything else to custom', () => {
    expect(claudeAccessState('auto')).toEqual({ kind: 'level', level: 'auto' });
    expect(claudeAccessState('manual')).toEqual({ kind: 'level', level: 'default' });
    expect(claudeAccessState('dontAsk')).toEqual({ kind: 'custom', label: 'dontAsk', mode: 'dontAsk' });
  });

  test('keeps a recorded value that is not a safe mode as a label only', () => {
    expect(claudeAccessState('--dangerous flag')).toEqual({ kind: 'custom', label: '--dangerous flag' });
    expect(claudeAccessState('x'.repeat(33))).toEqual({ kind: 'custom', label: 'x'.repeat(33) });
  });
});
