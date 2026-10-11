import { describe, expect, test } from 'vitest';
import { codePlugin, FRACTAL_DARK, fractalDarkCodeTheme, TERMINAL_DARK, terminalTheme } from './fractal-theme';

describe('code highlighting', () => {
  test('keeps GitHub light and uses the Fractal theme in dark mode', () => {
    expect(codePlugin.getThemes()).toEqual(['github-light', fractalDarkCodeTheme]);
  });

  test('colours keywords teal and strings sand', () => {
    const colourOf = (scope: string) => fractalDarkCodeTheme.tokenColors.find((rule) => [rule.scope].flat().includes(scope))?.settings.foreground;
    expect(colourOf('keyword')).toBe(FRACTAL_DARK.teal);
    expect(colourOf('string')).toBe(FRACTAL_DARK.sand);
  });
});

describe('terminalTheme', () => {
  test('in dark mode, adds the teal cursor and the terminal ANSI palette', () => {
    const theme = terminalTheme({ dark: true, background: 'bg', foreground: 'fg' });
    expect(theme).toMatchObject({ background: 'bg', foreground: 'fg', cursor: FRACTAL_DARK.teal, cursorAccent: 'bg', green: TERMINAL_DARK.green, red: TERMINAL_DARK.red });
  });

  test('keeps bright colours saturated rather than pale', () => {
    const theme = terminalTheme({ dark: true, background: 'bg', foreground: 'fg' });
    // A pale tint mixes in white, so all three channels sit high; a saturated
    // colour keeps at least one channel well down.
    const lowestChannel = (hex: string) => Math.min(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
    for (const name of ['brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'] as const) {
      expect(lowestChannel(theme[name] as string), name).toBeLessThan(0x90);
    }
  });

  test('in light mode, sets only the background and text colours', () => {
    expect(terminalTheme({ dark: false, background: 'bg', foreground: 'fg' })).toEqual({ background: 'bg', foreground: 'fg' });
  });
});
