// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { nextTerminalNumber, terminalTabLabel, type TerminalTab } from './terminal-tabs';

afterEach(cleanup);

test('labels a lone terminal plainly and numbers several', () => {
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 2, shell: 'zsh' }, 1)).toBe('Terminal');
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 1, shell: 'zsh' }, 2)).toBe('Terminal 1');
  expect(terminalTabLabel({ id: 'b', cwd: null, number: 3 }, 2)).toBe('Terminal 3');
});

test('takes the lowest number no open tab is using', () => {
  const tab = (number: number): TerminalTab => ({ id: String(number), cwd: null, number });
  expect(nextTerminalNumber([])).toBe(1);
  expect(nextTerminalNumber([tab(1), tab(3)])).toBe(2);
  expect(nextTerminalNumber([tab(2)])).toBe(1);
  expect(nextTerminalNumber([tab(1), tab(2)])).toBe(3);
});
