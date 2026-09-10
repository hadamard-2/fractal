import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FractalSettings, ThemePreference } from '@/shared/settings-contract';

const DEFAULTS: FractalSettings = { theme: 'system' };

const THEME_VALUES: readonly string[] = ['system', 'light', 'dark'];

/**
 * Settings files are user-editable JSON (and may come from a newer Fractal),
 * so nothing read back is trusted: an unknown theme falls back to the default
 * instead of flowing into `nativeTheme.themeSource`, which throws on anything
 * outside its union.
 */
function coerceTheme(value: unknown): ThemePreference {
  return typeof value === 'string' && THEME_VALUES.includes(value)
    ? (value as ThemePreference)
    : DEFAULTS.theme;
}

/**
 * App preferences, persisted as JSON in the userData directory. Deliberately
 * synchronous and tiny: settings are read once at startup — before any window
 * exists, so the theme is right from the first frame — and on every change.
 *
 * Follows ConversationStore's conventions: atomic writes via temp+rename, and
 * parse errors rethrown with the path but without the parser's own message
 * (which would quote file contents back to whoever triggered the corruption).
 */
export class SettingsStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'settings.json');
    mkdirSync(rootDir, { recursive: true });
  }

  load(): FractalSettings {
    if (!existsSync(this.filePath)) return { ...DEFAULTS };
    const raw = readFileSync(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Settings file ${this.filePath} is corrupt or truncated.`);
    }
    const theme =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).theme
        : undefined;
    return { theme: coerceTheme(theme) };
  }

  save(settings: FractalSettings): FractalSettings {
    const validated: FractalSettings = { theme: coerceTheme(settings.theme) };
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(validated, null, 2));
    renameSync(tmpPath, this.filePath);
    return validated;
  }
}
