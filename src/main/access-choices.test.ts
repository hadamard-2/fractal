import { describe, expect, test, vi } from 'vitest';
import { AccessChoices } from './access-choices';
import type { AccessState, ConversationRef } from '@/shared/conversation-contract';
import type { StoredAccess } from './access-choice-store';

const claudeRef: ConversationRef = { provider: 'claude', nativeSessionId: 'a', projectPath: '/work' };
const codexRef: ConversationRef = { provider: 'codex', nativeSessionId: 'b', projectPath: '/work' };
const level = (id: string): AccessState => ({ kind: 'level', level: id });

function memoryStore() {
  const entries = new Map<string, StoredAccess>();
  return { entries, get: (key: string) => entries.get(key), set: (key: string, value: StoredAccess) => { entries.set(key, value); } };
}

function setup(readAccess?: (ref: ConversationRef) => Promise<AccessState | undefined>, allowed: (provider: string) => boolean = () => false) {
  const store = memoryStore();
  const choices = new AccessChoices([{ provider: 'claude', readAccess }, { provider: 'codex' }], store, allowed);
  return { store, choices };
}

describe('AccessChoices', () => {
  test('lists the levels for an agent', () => {
    const { choices } = setup();
    expect(choices.levels('claude').map((entry) => entry.id)).toEqual(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
    expect(choices.levels('codex').map((entry) => entry.id)).toEqual(['read-only', 'auto', 'auto-review', 'full-access']);
  });

  test('resolves a saved pick, else the read-back adopted, else the agent default', async () => {
    const readAccess = vi.fn(async (): Promise<AccessState | undefined> => ({ kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }));
    const { choices } = setup(readAccess);
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false } });
    choices.choose(claudeRef, 'plan');
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: level('plan'), picked: true } });
    await expect(choices.resolve(codexRef)).resolves.toEqual({ access: null });
    readAccess.mockResolvedValueOnce(undefined);
    await expect(setup(readAccess).choices.resolve(claudeRef)).resolves.toEqual({ access: null });
  });

  test('treats a read-back failure as the default and does not cache it', async () => {
    const readAccess = vi.fn<() => Promise<AccessState | undefined>>().mockRejectedValueOnce(new Error('gone')).mockResolvedValue(level('plan'));
    const { choices } = setup(readAccess);
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: null });
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: level('plan'), picked: false } });
    expect(readAccess).toHaveBeenCalledTimes(2);
  });

  test('reads back once until a turn is sent, then reads again', async () => {
    const readAccess = vi.fn(async (): Promise<AccessState | undefined> => level('default'));
    const { choices } = setup(readAccess);
    await choices.resolve(claudeRef);
    await choices.resolve(claudeRef);
    expect(readAccess).toHaveBeenCalledOnce();
    choices.recordSend(claudeRef, undefined);
    await choices.resolve(claudeRef);
    expect(readAccess).toHaveBeenCalledTimes(2);
  });

  test('caches an absent read-back too', async () => {
    const readAccess = vi.fn(async (): Promise<AccessState | undefined> => undefined);
    const { choices } = setup(readAccess);
    await choices.resolve(claudeRef);
    await choices.resolve(claudeRef);
    expect(readAccess).toHaveBeenCalledOnce();
  });

  test('reports observed only for a sent pick that differs from the read-back', async () => {
    let readBack: AccessState = level('default');
    const { choices } = setup(async () => readBack);
    choices.choose(claudeRef, 'auto');
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: level('auto'), picked: true } });
    choices.recordSend(claudeRef, { state: level('auto'), picked: true });
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: level('auto'), picked: true }, observed: level('default') });
    readBack = level('auto');
    choices.recordSend(claudeRef, undefined);
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: level('auto'), picked: true } });
  });

  test('reports no observed state for a sent pick when nothing can be read back', async () => {
    const { choices, store } = setup(async () => { throw new Error('gone'); });
    store.set('claude:a', { state: level('auto'), sent: true });
    store.set('codex:b', { state: level('auto'), sent: true });
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ access: { state: level('auto'), picked: true } });
    await expect(choices.resolve(codexRef)).resolves.toEqual({ access: { state: level('auto'), picked: true } });
  });

  test('rejects unknown levels and dangerous levels that Settings has not allowed', () => {
    const { choices, store } = setup();
    expect(() => choices.choose(claudeRef, 'nope')).toThrow('Unknown access level');
    expect(() => choices.choose(claudeRef, 'bypassPermissions')).toThrow('Bypass is turned off in Settings');
    expect(store.entries.size).toBe(0);
    expect(() => choices.validateSend(codexRef, { state: level('full-access'), picked: true })).toThrow('Full access is turned off in Settings');
    expect(() => choices.validateSend(codexRef, { state: level('nope'), picked: true })).toThrow('Unknown access level');
    expect(() => choices.validateSend(claudeRef, { state: { kind: 'custom', label: 'x', mode: 'plan' }, picked: true })).toThrow('Unknown access level');
    expect(() => choices.validateSend(claudeRef, { state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).not.toThrow();
    expect(() => choices.validateSend(claudeRef, { state: level('bypassPermissions'), picked: false })).not.toThrow();
    expect(() => choices.validateSend(claudeRef, undefined)).not.toThrow();
    expect(() => choices.validateSend(claudeRef, { state: level('auto'), picked: true })).not.toThrow();
  });

  test('allows a dangerous level once Settings allows it for that agent', () => {
    const { choices, store } = setup(undefined, (provider) => provider === 'claude');
    choices.choose(claudeRef, 'bypassPermissions');
    expect(store.get('claude:a')).toEqual({ state: level('bypassPermissions'), sent: false });
    expect(() => choices.validateSend(claudeRef, { state: level('bypassPermissions'), picked: true })).not.toThrow();
    expect(() => choices.choose(codexRef, 'full-access')).toThrow('Full access is turned off in Settings');
  });

  test('counts a throwing allowDangerous as not allowed', () => {
    const { choices } = setup(undefined, () => { throw new Error('settings corrupt'); });
    expect(choices.allowDangerous('claude')).toBe(false);
    expect(() => choices.choose(claudeRef, 'bypassPermissions')).toThrow('Bypass is turned off in Settings');
  });

  test('saves only picked states on send', () => {
    const { choices, store } = setup();
    choices.recordSend(claudeRef, { state: level('plan'), picked: false });
    choices.recordSend(claudeRef, undefined);
    expect(store.entries.size).toBe(0);
    choices.recordSend(claudeRef, { state: level('plan'), picked: true });
    expect(store.get('claude:a')).toEqual({ state: level('plan'), sent: true });
  });
});
