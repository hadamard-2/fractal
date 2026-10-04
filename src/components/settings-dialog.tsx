import { useEffect, useState } from 'react';
import { Info, Monitor, Moon, Settings2, Sun, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DEFAULT_CODING_AGENT,
  type AgentEnvironment,
  type AgentExecutables,
  type AgentInUse,
  type DefaultCodingAgent,
  type FractalSettings,
  type ShellPathResolution,
  type ThemePreference,
} from '@/shared/settings-contract';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const satisfies readonly {
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}[];

const CODING_AGENT_OPTIONS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'ask', label: 'Ask every time' },
] as const satisfies readonly { value: DefaultCodingAgent; label: string }[];

const AGENT_LOCATION_FIELDS = [
  { agent: 'claude', label: 'Claude Code', bareName: 'claude' },
  { agent: 'codex', label: 'Codex', bareName: 'codex' },
] as const satisfies readonly { agent: keyof AgentExecutables; label: string; bareName: string }[];

const NO_AGENT_EXECUTABLES: AgentExecutables = { claude: '', codex: '' };

function shellPathText(resolution: ShellPathResolution): string {
  switch (resolution.status) {
    case 'resolved':
      return `Includes your login shell's PATH (${resolution.shell}).`;
    case 'failed':
      return `Couldn't read your login shell's PATH (${resolution.shell} ${resolution.reason}), so only the PATH Fractal was launched with is searched.`;
    case 'skipped':
      return 'Uses the PATH Fractal was launched with.';
  }
}

/** Where agents left blank are looked up; shown only when one wasn't found. Tinted when the login shell PATH couldn't be read, the one case it explains a missing agent. */
function SearchPathInfo({ environment }: { environment: AgentEnvironment }) {
  const failed = environment.shellPath.status === 'failed';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Where Fractal looks for agents"
          className={failed ? 'size-6 text-destructive' : 'size-6 text-muted-foreground'}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Info className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-96 flex-col gap-2 text-sm">
        <p>For an agent left blank, Fractal searches these folders in order.</p>
        <p className="text-muted-foreground">{shellPathText(environment.shellPath)}</p>
        {/* The open dialog blocks wheel scrolling outside its own content, and
            this popover renders outside it, so the wheel is applied by hand. */}
        <ol
          aria-label="Folders searched for agents"
          className="flex max-h-60 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-foreground"
          onWheel={(event) => { event.currentTarget.scrollTop += event.deltaY; }}
        >
          {environment.searchPath.map((folder, index) => (
            <li key={`${index}:${folder}`}>{folder}</li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

/** What this launch is running, and whether the saved location differs from it. */
function AgentStatus({ inUse, saved, bareName }: { inUse: AgentInUse; saved: string; bareName: string }) {
  const pendingRestart = saved !== inUse.configured;
  const { lookup } = inUse;
  if (lookup.status === 'unchecked' && !pendingRestart) return null;
  return (
    <p className="text-xs text-muted-foreground sm:text-right">
      {lookup.status === 'found' && <span className="font-mono break-all">{`Using ${lookup.path}`}</span>}
      {lookup.status === 'not-found' && (
        <span className="text-destructive">
          {inUse.configured ? `Couldn't find ${inUse.configured}.` : `"${bareName}" isn't on the PATH Fractal searches. Set a location to use it.`}
        </span>
      )}
      {pendingRestart && <span className="block">Restart Fractal to use the new location.</span>}
    </p>
  );
}

/** Edits locally and saves on blur or Enter, so a half-typed path is never persisted. */
function AgentLocationField({
  label,
  bareName,
  saved,
  disabled,
  inUse,
  onSave,
}: {
  label: string;
  bareName: string;
  saved: string;
  disabled: boolean;
  inUse?: AgentInUse;
  onSave: (location: string) => void;
}) {
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => {
    const next = draft.trim();
    if (next !== saved) onSave(next);
  };
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <span className="text-sm sm:pt-2">{label}</span>
      <div className="flex w-full flex-col gap-1.5 sm:max-w-96">
        <Input
          aria-label={`${label} location`}
          className="font-mono"
          disabled={disabled}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
          placeholder={bareName}
          spellCheck={false}
          value={draft}
        />
        {inUse && <AgentStatus bareName={bareName} inUse={inUse} saved={saved} />}
      </div>
    </div>
  );
}

/** Global app settings. The rail has one section until another setting needs it. */
export function SettingsDialog({
  open,
  onOpenChange,
  onShowAgentColorTagsChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // App mirrors this one setting for the sidebar, which doesn't reload
  // settings on its own; called optimistically and again on revert.
  onShowAgentColorTagsChange?: (show: boolean) => void;
}) {
  const [settings, setSettings] = useState<FractalSettings | null>(null);
  const [environment, setEnvironment] = useState<AgentEnvironment | null>(null);

  // Loaded on every open rather than once at mount, so edits made outside the
  // dialog (or in settings.json directly) show up on the next visit.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.fractal.settings
      .get()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch(() => {
        // Leave the controls inert rather than displaying a state that isn't
        // real — a wrong active pill is harder to notice than a blank one.
      });
    // Settled once at startup, but read on each open like the settings above.
    Promise.resolve()
      .then(() => window.fractal.settings.agentEnvironment())
      .then((loaded) => {
        if (!cancelled) setEnvironment(loaded);
      })
      .catch(() => {
        // Without it the section still works; it just can't show what is searched.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const setTheme = (theme: ThemePreference) => {
    if (!settings || settings.theme === theme) return;
    const previous = settings;
    setSettings({ ...previous, theme }); // optimistic; the round-trip is local
    window.fractal.settings
      .set({ theme })
      .then(setSettings)
      .catch(() => setSettings(previous));
  };

  const setDefaultCodingAgent = (defaultCodingAgent: DefaultCodingAgent) => {
    if (!settings || settings.defaultCodingAgent === defaultCodingAgent) return;
    const previous = settings;
    setSettings({ ...previous, defaultCodingAgent });
    window.fractal.settings
      .set({ defaultCodingAgent })
      .then(setSettings)
      .catch(() => setSettings(previous));
  };

  const setShowAgentColorTags = (showAgentColorTags: boolean) => {
    if (!settings || settings.showAgentColorTags === showAgentColorTags) return;
    const previous = settings;
    setSettings({ ...previous, showAgentColorTags });
    onShowAgentColorTagsChange?.(showAgentColorTags);
    window.fractal.settings
      .set({ showAgentColorTags })
      .then(setSettings)
      .catch(() => {
        setSettings(previous);
        onShowAgentColorTagsChange?.(previous.showAgentColorTags);
      });
  };

  const setAgentExecutable = (agent: keyof AgentExecutables, location: string) => {
    if (!settings) return;
    const previous = settings;
    const agentExecutables = { ...(previous.agentExecutables ?? NO_AGENT_EXECUTABLES), [agent]: location };
    setSettings({ ...previous, agentExecutables });
    window.fractal.settings
      .set({ agentExecutables })
      .then(setSettings)
      .catch(() => setSettings(previous));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[880px] flex-col gap-0 overflow-y-auto bg-card p-0 sm:min-h-[min(420px,calc(100vh-2rem))] sm:max-w-[880px]" showCloseButton={false}>
        <DialogHeader className="flex-row items-center justify-between py-4 pr-6 pl-6 text-left sm:pr-8">
          <DialogTitle className="text-xl font-medium">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Choose how Fractal looks, which coding agent starts new chats, and where to find each agent.
          </DialogDescription>
          <DialogClose asChild>
            <Button aria-label="Close settings" size="icon" type="button" variant="ghost">
              <X className="size-5" aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="flex min-h-0 flex-col sm:flex-row">
          <aside aria-label="Settings sections" className="shrink-0 p-3 sm:w-48">
            <div aria-current="page" className="flex items-center gap-2.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-medium text-accent-foreground">
              <Settings2 className="size-4" aria-hidden="true" />
              General
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col gap-8 px-6 pt-3 pb-7 sm:px-8 sm:pb-8">
            <section aria-labelledby="agents-heading">
              <h2 id="agents-heading" className="text-base font-medium">Agents</h2>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 id="coding-agent-heading" className="text-sm font-medium">Coding agent</h3>
                <Select
                  disabled={!settings}
                  onValueChange={(next) => setDefaultCodingAgent(next as DefaultCodingAgent)}
                  value={settings?.defaultCodingAgent ?? DEFAULT_CODING_AGENT}
                >
                  <SelectTrigger
                    aria-labelledby="coding-agent-heading"
                    className="min-w-40 rounded-md border-0 bg-secondary px-4 shadow-none dark:bg-secondary"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" position="popper">
                    <SelectGroup>
                      {CODING_AGENT_OPTIONS.map(({ value, label }) => (
                        <SelectItem
                          className="data-[state=checked]:text-primary-text [&_svg]:text-primary-text!"
                          key={value}
                          value={value}
                        >
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="mt-6 flex items-center justify-between gap-6">
                <div className="flex flex-col gap-1">
                  <h3 id="agent-color-tags-heading" className="text-sm font-medium">Agent color tags</h3>
                  <p id="agent-color-tags-description" className="text-sm text-muted-foreground">
                    Tag sidebar chats with Claude Code orange or Codex blue.
                  </p>
                </div>
                <Switch
                  aria-describedby="agent-color-tags-description"
                  aria-labelledby="agent-color-tags-heading"
                  checked={settings?.showAgentColorTags ?? true}
                  disabled={!settings}
                  onCheckedChange={setShowAgentColorTags}
                />
              </div>

              <div className="mt-6 flex flex-col gap-1">
                <div className="flex items-center gap-1">
                  <h3 id="agent-locations-heading" className="text-sm font-medium">Locations</h3>
                  {environment && Object.values(environment.agents).some(({ lookup }) => lookup.status === 'not-found') && (
                    <SearchPathInfo environment={environment} />
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Fractal looks for each agent on your PATH. Set a location to use a specific executable instead. Changes apply the next time Fractal starts.
                </p>
              </div>
              <div className="mt-4 flex flex-col gap-3">
                {AGENT_LOCATION_FIELDS.map(({ agent, label, bareName }) => (
                  <AgentLocationField
                    bareName={bareName}
                    disabled={!settings}
                    inUse={environment?.agents[agent]}
                    key={agent}
                    label={label}
                    onSave={(location) => setAgentExecutable(agent, location)}
                    saved={settings?.agentExecutables?.[agent] ?? ''}
                  />
                ))}
              </div>
            </section>

            <section aria-labelledby="appearance-heading">
              <div className="flex flex-col gap-1">
                <h2 id="appearance-heading" className="text-base font-medium">Appearance</h2>
                <p className="text-sm text-muted-foreground">
                  Choose how Fractal looks. Changes apply immediately and persist across restarts.
                </p>
              </div>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                disabled={!settings}
                value={settings?.theme ?? ''}
                onValueChange={(next) => next && setTheme(next as ThemePreference)}
                aria-label="Theme"
                className="mt-6 grid w-full grid-cols-3 gap-2.5"
              >
                {THEME_OPTIONS.map(({ value, label, Icon }) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    aria-label={label}
                    className="flex h-28 w-full flex-col gap-3 rounded-xl px-2 text-sm font-medium data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary-text data-[state=on]:ring-1 data-[state=on]:ring-primary/50"
                  >
                    <Icon className="size-5" aria-hidden="true" />
                    <span>{label}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
