import { useEffect, useState } from 'react';
import { Monitor, Moon, Settings2, Sun, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DEFAULT_CODING_AGENT, type DefaultCodingAgent, type FractalSettings, type ThemePreference } from '@/shared/settings-contract';

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

/** Global app settings. The rail has one section until another setting needs it. */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<FractalSettings | null>(null);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[880px] flex-col gap-0 overflow-y-auto bg-card p-0 sm:min-h-[min(420px,calc(100vh-2rem))] sm:max-w-[880px]" showCloseButton={false}>
        <DialogHeader className="flex-row items-center justify-between py-4 pr-6 pl-6 text-left sm:pr-8">
          <DialogTitle className="text-xl font-medium">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Choose how Fractal looks and which coding agent starts new chats.
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
            <section aria-labelledby="coding-agent-heading">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 id="coding-agent-heading" className="text-base font-medium">Coding agent</h2>
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
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
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
                    className="flex h-28 w-full flex-col gap-3 rounded-xl px-2 text-sm font-medium data-[state=on]:border-ring data-[state=on]:bg-accent data-[state=on]:ring-1 data-[state=on]:ring-ring/50"
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
