// Shared settings IPC contract. Type-only (plus the channel name) — no I/O,
// no Electron imports, no React. It is imported by
// both the main and renderer processes; the single source of truth.

export type ThemePreference = 'system' | 'light' | 'dark';
export type DefaultCodingAgent = 'codex' | 'claude' | 'ask';
export const DEFAULT_CODING_AGENT: DefaultCodingAgent = 'claude';

export interface SidebarOrder {
  projects: string[];
  chatsByProject: Record<string, string[]>;
}

/**
 * Project folder paths Fractal hides. Projects come from the agents' own
 * history, so neither state touches anything on disk: archived projects are
 * tucked behind the sidebar filter, removed ones are hidden everywhere until a
 * conversation is started in the folder again.
 */
export interface ProjectVisibility {
  archived: string[];
  removed: string[];
}

export type ProjectFilter = 'active' | 'archived' | 'all';

export interface FractalSettings {
  theme: ThemePreference;
  defaultCodingAgent: DefaultCodingAgent;
  sidebarOrder: SidebarOrder;
  projectVisibility: ProjectVisibility;
  projectFilter: ProjectFilter;
}

export const SETTINGS_INVOKE_CHANNEL = 'fractal:settings:invoke';

export type SettingsInvokeRequest =
  | { method: 'get' }
  | { method: 'set'; patch: Partial<FractalSettings> }
  | { method: 'openDataFolder' };

export interface FractalSettingsApi {
  get(): Promise<FractalSettings>;
  /** Merges the patch into the stored settings and applies it; resolves with the full updated settings. */
  set(patch: Partial<FractalSettings>): Promise<FractalSettings>;
  /** Reveals the app data folder (conversations, settings) in the OS file manager. */
  openDataFolder(): Promise<void>;
}
