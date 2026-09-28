import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODING_AGENT, type DefaultCodingAgent, type FractalSettings, type ProjectFilter, type ProjectVisibility, type SidebarOrder, type ThemePreference } from '@/shared/settings-contract';

const emptySidebarOrder = (): SidebarOrder => ({ projects: [], chatsByProject: {} });
const emptyProjectVisibility = (): ProjectVisibility => ({ archived: [], removed: [] });
const defaults = (): FractalSettings => ({ theme: 'system', defaultCodingAgent: DEFAULT_CODING_AGENT, sidebarOrder: emptySidebarOrder(), projectVisibility: emptyProjectVisibility(), projectFilter: 'active' });

const THEME_VALUES: readonly string[] = ['system', 'light', 'dark'];
const CODING_AGENT_VALUES: readonly string[] = ['codex', 'claude', 'ask'];
const PROJECT_FILTER_VALUES: readonly string[] = ['active', 'archived', 'all'];

/**
 * Settings files are user-editable JSON (and may come from a newer Fractal),
 * so nothing read back is trusted: an unknown theme falls back to the default
 * instead of flowing into `nativeTheme.themeSource`, which throws on anything
 * outside its union.
 */
function coerceTheme(value: unknown): ThemePreference {
  return typeof value === 'string' && THEME_VALUES.includes(value)
    ? (value as ThemePreference)
    : 'system';
}

function coerceDefaultCodingAgent(value: unknown): DefaultCodingAgent {
  return typeof value === 'string' && CODING_AGENT_VALUES.includes(value)
    ? (value as DefaultCodingAgent)
    : DEFAULT_CODING_AGENT;
}

function coerceStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : [];
}

function coerceSidebarOrder(value: unknown): SidebarOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptySidebarOrder();
  const order = value as Record<string, unknown>;
  const rawChats = order.chatsByProject;
  const chatsByProject: Record<string, string[]> = typeof rawChats === 'object' && rawChats !== null && !Array.isArray(rawChats)
    ? Object.fromEntries(Object.entries(rawChats).filter(([projectPath]) => projectPath.length > 0).map(([projectPath, ids]) => [projectPath, coerceStrings(ids)]))
    : {};
  return { projects: coerceStrings(order.projects), chatsByProject };
}

function coerceProjectVisibility(value: unknown): ProjectVisibility {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyProjectVisibility();
  const visibility = value as Record<string, unknown>;
  const removed = coerceStrings(visibility.removed);
  // A path in both lists counts as removed, the stronger of the two states.
  return { archived: coerceStrings(visibility.archived).filter((projectPath) => !removed.includes(projectPath)), removed };
}

function coerceProjectFilter(value: unknown): ProjectFilter {
  return typeof value === 'string' && PROJECT_FILTER_VALUES.includes(value) ? (value as ProjectFilter) : 'active';
}

function coerceSettings(record: Record<string, unknown>): FractalSettings {
  return {
    theme: coerceTheme(record.theme),
    defaultCodingAgent: coerceDefaultCodingAgent(record.defaultCodingAgent),
    sidebarOrder: coerceSidebarOrder(record.sidebarOrder),
    projectVisibility: coerceProjectVisibility(record.projectVisibility),
    projectFilter: coerceProjectFilter(record.projectFilter),
  };
}

/**
 * App preferences, persisted as JSON in the userData directory. Deliberately
 * synchronous and tiny: settings are read once at startup — before any window
 * exists, so the theme is right from the first frame — and on every change.
 *
 * Uses atomic writes via temp+rename, and
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
    if (!existsSync(this.filePath)) return defaults();
    const raw = readFileSync(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Settings file ${this.filePath} is corrupt or truncated.`);
    }
    const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
    return coerceSettings(record);
  }

  save(settings: FractalSettings): FractalSettings {
    const validated = coerceSettings({ ...settings });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(validated, null, 2));
    renameSync(tmpPath, this.filePath);
    return validated;
  }
}
