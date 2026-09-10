import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { FractalSettings, ThemePreference } from '@/shared/settings-contract';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const satisfies readonly {
  value: ThemePreference;
  label: string;
  Icon: typeof Sun;
}[];

/**
 * Global app settings, one pane for as long as one pane is enough. Sections
 * are deliberately sparse — a setting has to earn its way in — and the row
 * shape (label left, control right) is the one that graduates to a two-pane
 * dialog with a section nav without anything moving.
 */
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Applies immediately and persists across restarts.
          </DialogDescription>
        </DialogHeader>

        {/*
          Segmented control in the mode toggle's visual language (pill on
          secondary), minus the sliding-thumb machinery — with labels the
          item widths aren't fixed, so the pill offset math doesn't apply.
        */}
        <div className="flex items-center justify-between gap-6">
          <p className="text-sm">Theme</p>
          <ToggleGroup
            type="single"
            size="sm"
            value={settings?.theme}
            onValueChange={(next) => next && setTheme(next as ThemePreference)}
            aria-label="Theme"
            className="shrink-0 gap-1 rounded-lg bg-secondary p-1"
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={label}
                className="gap-1.5 rounded-md px-2.5 data-[state=on]:bg-background data-[state=on]:shadow-sm"
              >
                <Icon className="size-3.5" />
                <span className="text-xs">{label}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </DialogContent>
    </Dialog>
  );
}
