// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { accessLevels } from '@/shared/access-levels';
import type { ProviderId, TurnAccess } from '@/shared/conversation-contract';
import { AccessPicker } from './access-picker';

// jsdom has no layout; Radix scrolls the selected option into view.
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: (): void => undefined }); });
afterEach(cleanup);

const level = (id: string, picked = true): TurnAccess => ({ state: { kind: 'level', level: id }, picked });

function setup(provider: ProviderId, props: Partial<Parameters<typeof AccessPicker>[0]> = {}) {
  const onChoose = vi.fn();
  const onOpen = vi.fn();
  render(<AccessPicker access={null} allowDangerous levels={accessLevels(provider)} onChoose={onChoose} onOpen={onOpen} provider={provider} {...props} />);
  return { onChoose, onOpen, user: userEvent.setup() };
}

test('the trigger is labelled Access and shows the current label', () => {
  setup('claude', { access: level('default') });
  expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Ask');
});

test('the trigger reads as the agent\'s default with no state', () => {
  setup('codex');
  expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe("Codex's default");
});

test('opening lists each level with its description and reports the open', async () => {
  const { user, onOpen } = setup('claude', { access: level('auto') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('menuitem', { name: /Plan/ }).textContent).toContain('Reads and proposes a plan; no edits until you approve it.');
  expect(screen.getByRole('menuitem', { name: /Auto/ }).textContent).toContain('Acts without asking; a safety check reviews each action.');
});

test('a safe level is chosen at once', async () => {
  const { user, onChoose } = setup('claude', { access: level('auto') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  await user.click(screen.getByRole('menuitem', { name: /Plan/ }));
  expect(onChoose).toHaveBeenCalledWith('plan');
});

test('hides a dangerous level unless allowed or current', async () => {
  const { user } = setup('claude', { allowDangerous: false, access: level('auto') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  expect(screen.queryByRole('menuitem', { name: /Bypass/ })).toBeNull();
});

test('a dangerous level is chosen only after confirming', async () => {
  const { user, onChoose } = setup('claude', { access: level('auto') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  await user.click(screen.getByRole('menuitem', { name: /Bypass/ }));
  expect(screen.getByRole('dialog', { name: 'Allow Bypass?' })).toBeTruthy();
  expect(screen.getByText('Claude Code will act without asking you and without any safety check, on every turn of this conversation until you change it.')).toBeTruthy();
  expect(onChoose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Use Bypass' }));
  expect(onChoose).toHaveBeenCalledWith('bypassPermissions');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('cancelling the confirmation chooses nothing', async () => {
  const { user, onChoose } = setup('codex', { access: level('auto') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  await user.click(screen.getByRole('menuitem', { name: /Full access/ }));
  expect(screen.getByRole('dialog', { name: 'Allow Full access?' })).toBeTruthy();
  expect(screen.getByText('Codex will run any command with no sandbox and never ask, on every turn of this conversation until you change it.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onChoose).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a dangerous level that is already current is shown without asking again', async () => {
  const { user, onChoose } = setup('claude', { allowDangerous: false, access: level('bypassPermissions') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  await user.click(screen.getByRole('menuitem', { name: /Bypass/ }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onChoose).toHaveBeenCalledWith('bypassPermissions');
});

test('a dangerous current level colours the trigger', () => {
  setup('claude', { access: level('bypassPermissions') });
  expect(screen.getByRole('button', { name: 'Access' }).className).toContain('text-destructive');
});

test('states what the last turn ran in when it differs', async () => {
  const { user } = setup('claude', { access: level('auto'), observed: { kind: 'level', level: 'default' } });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  expect(screen.getByText('Last turn ran in Ask, not Auto')).toBeTruthy();
});

test('shows no observed line without an observed state', async () => {
  const { user } = setup('claude', { access: level('auto') });
  await user.click(screen.getByRole('button', { name: 'Access' }));
  expect(screen.queryByText(/Last turn ran in/)).toBeNull();
});

test('a custom state appears as a checked item', async () => {
  const { user } = setup('claude', { access: { state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false } });
  expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Custom: dontAsk');
  await user.click(screen.getByRole('button', { name: 'Access' }));
  const item = screen.getByRole('menuitem', { name: /Custom: dontAsk/ });
  expect(item.querySelector('svg')).not.toBeNull();
});
