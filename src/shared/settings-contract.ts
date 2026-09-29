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

/**
 * Where to find each agent's executable. An empty string means the bare name
 * (`claude`, `codex`) is looked up on PATH; anything else is used as given.
 */
export interface AgentExecutables {
  claude: string;
  codex: string;
}

/** Whether Fractal could add the login shell's PATH to its own at startup. */
export type ShellPathResolution =
  | { status: 'resolved'; shell: string }
  | { status: 'failed'; shell: string; reason: string }
  | { status: 'skipped'; reason: string };

/** Where Fractal looks for agents given by bare name. */
export interface AgentEnvironment {
  shellPath: ShellPathResolution;
  /** The PATH entries in search order. */
  searchPath: string[];
}

export interface FractalSettings {
  theme: ThemePreference;
  defaultCodingAgent: DefaultCodingAgent;
  sidebarOrder: SidebarOrder;
  projectVisibility: ProjectVisibility;
  projectFilter: ProjectFilter;
  /** Colored per-agent dot on each sidebar chat row. */
  showAgentColorTags: boolean;
  agentExecutables: AgentExecutables;
}

export const SETTINGS_INVOKE_CHANNEL = 'fractal:settings:invoke';

export type SettingsInvokeRequest =
  | { method: 'get' }
  | { method: 'set'; patch: Partial<FractalSettings> }
  | { method: 'openDataFolder' }
  | { method: 'agentEnvironment' };

export interface FractalSettingsApi {
  get(): Promise<FractalSettings>;
  /** Merges the patch into the stored settings and applies it; resolves with the full updated settings. */
  set(patch: Partial<FractalSettings>): Promise<FractalSettings>;
  /** Reveals the app data folder (conversations, settings) in the OS file manager. */
  openDataFolder(): Promise<void>;
  /** How Fractal resolved the PATH it searches for agents given by bare name. */
  agentEnvironment(): Promise<AgentEnvironment>;
}
