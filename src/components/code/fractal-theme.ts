import { createCodePlugin } from '@streamdown/code';
import type { ITheme } from '@xterm/xterm';

/**
 * Fractal's dark colours for code and the terminal, led by the brand teal.
 * Keywords take the teal; strings, numbers, functions and types each get
 * their own hue beside it so code still scans at a glance, and red stays for
 * errors and deletions, where teal would read as success.
 */
export const FRACTAL_DARK = {
  teal: '#32a586',
  sand: '#e6c07b',
  orange: '#f0a46b',
  blue: '#7cb7ff',
  cyan: '#5fd4c4',
  magenta: '#d6a0e6',
  red: '#f47174',
  text: '#e5e5e5',
  punctuation: '#9c9c9c',
  comment: '#6e6e6e',
} as const;

const c = FRACTAL_DARK;

type CodeTheme = {
  name: string;
  type: 'dark';
  colors: Record<string, string>;
  tokenColors: { scope: string | string[]; settings: { foreground?: string; fontStyle?: string } }[];
};

/**
 * A Shiki theme for dark mode. Only the token colours show: message code
 * blocks and the file viewer each keep their own surface, so the background
 * here is the dark theme's --card (index.css) just to keep the theme whole.
 */
export const fractalDarkCodeTheme: CodeTheme = {
  name: 'fractal-dark',
  type: 'dark',
  colors: { 'editor.background': '#111111', 'editor.foreground': c.text },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: c.punctuation } },
    { scope: ['variable', 'variable.parameter', 'variable.other', 'meta.object-literal.key'], settings: { foreground: c.text } },
    { scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'variable.language', 'entity.name.tag'], settings: { foreground: c.teal } },
    { scope: ['string', 'string.template', 'punctuation.definition.string', 'entity.other.attribute-name.class'], settings: { foreground: c.sand } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'], settings: { foreground: c.orange } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.other.attribute-name', 'support.type.property-name.json'], settings: { foreground: c.blue } },
    { scope: ['entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'support.type', 'support.class'], settings: { foreground: c.cyan } },
    { scope: ['string.regexp'], settings: { foreground: c.magenta } },
    { scope: ['markup.heading'], settings: { foreground: c.teal, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.inserted'], settings: { foreground: c.teal } },
    { scope: ['markup.deleted', 'invalid'], settings: { foreground: c.red } },
    { scope: ['markup.changed'], settings: { foreground: c.sand } },
  ],
};

/**
 * The terminal's ANSI colours: the same hues as the code palette, pushed more
 * saturated. Terminal output is mostly plain text with sparse colour, often in
 * bold, so softer tints wash out there. The bright variants get more vivid
 * rather than whiter, for the same reason.
 */
export const TERMINAL_DARK = {
  red: '#ff6b6e',
  green: '#2fbf96',
  yellow: '#f5c451',
  blue: '#5aa9ff',
  magenta: '#d68cf0',
  cyan: '#3fd9c6',
  brightRed: '#ff8587',
  brightGreen: '#4fe0b5',
  brightYellow: '#ffd36b',
  brightBlue: '#7dbcff',
  brightMagenta: '#e08cf5',
  brightCyan: '#66e8d8',
} as const;

/** The highlighter every code surface uses: GitHub's light theme, Fractal's dark one. */
export const codePlugin = createCodePlugin({ themes: ['github-light', fractalDarkCodeTheme] });

/**
 * The terminal's colours. Dark mode adds a teal cursor and selection and the
 * terminal palette above, which restyles programs that use the 16 standard
 * colours; programs that pick their own 24-bit colours are unaffected. Light
 * mode keeps xterm's own palette.
 */
export function terminalTheme({ dark, background, foreground }: { dark: boolean; background: string; foreground: string }): ITheme {
  if (!dark) return { background, foreground };
  return {
    background,
    foreground,
    cursor: c.teal,
    cursorAccent: background,
    selectionBackground: `${c.teal}4d`,
    ...TERMINAL_DARK,
    black: '#2b2b2b',
    white: '#d4d4d4',
    brightBlack: c.comment,
    brightWhite: '#ffffff',
  };
}
