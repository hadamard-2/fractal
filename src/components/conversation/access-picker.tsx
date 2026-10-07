import { TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AccessLevel, AccessState, ProviderId, TurnAccess } from '@/shared/conversation-contract';
import { accessStateLabel, accessTriggerLabel, visibleAccessLevels } from './access-choice';
import { Option, Trigger } from './composer-menu';

interface Props {
  provider: ProviderId;
  levels: AccessLevel[];
  access: TurnAccess | null;
  /** What the agent's own history says the last turn ran with, when that differs from `access`. */
  observed?: AccessState;
  allowDangerous: boolean;
  onChoose(level: string): void;
  /** Called when the menu opens, so a listing that changed since can be shown. */
  onOpen(): void;
}

const DANGER: Record<ProviderId, string> = {
  claude: 'Claude Code will act without asking you and without any safety check, on every turn of this conversation until you change it.',
  codex: 'Codex will run any command with no sandbox and never ask, on every turn of this conversation until you change it.',
};

export function AccessPicker({ provider, levels, access, observed, allowDangerous, onChoose, onOpen }: Props) {
  const [pending, setPending] = useState<AccessLevel | null>(null);
  // The dialog animates out after `pending` clears, so it keeps naming the last level meanwhile.
  const [shownLevel, setShownLevel] = useState<AccessLevel | null>(null);
  if (pending && pending !== shownLevel) setShownLevel(pending);
  const currentId = access?.state.kind === 'level' ? access.state.level : undefined;
  const dangerousNow = levels.some((level) => level.dangerous && level.id === currentId);
  const observedText = observed ? `Last turn ran in ${accessStateLabel(observed, levels)}, not ${accessTriggerLabel(provider, access, levels)}` : undefined;
  const alert = <TriangleAlertIcon className="size-3.5 shrink-0" />;
  const icon = observedText ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild><span className="flex">{alert}</span></TooltipTrigger>
        <TooltipContent>{observedText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : dangerousNow ? alert : undefined;

  const pick = (level: AccessLevel) => {
    if (level.dangerous && level.id !== currentId) setPending(level);
    else onChoose(level.id);
  };

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) onOpen(); }}>
        <Trigger className={cn('max-w-48', dangerousNow && 'text-destructive hover:text-destructive aria-expanded:text-destructive')} icon={icon} label="Access">{accessTriggerLabel(provider, access, levels)}</Trigger>
        <DropdownMenuContent align="start" side="top">
          {visibleAccessLevels(levels, allowDangerous, access).map((level) => (
            <Option current={level.id === currentId} key={level.id} onSelect={() => pick(level)}>
              <span className="flex flex-col">
                <span>{level.label}</span>
                <span className="text-xs font-normal text-muted-foreground">{level.description}</span>
              </span>
            </Option>
          ))}
          {access?.state.kind === 'custom' && (
            <>
              <DropdownMenuSeparator />
              <Option current onSelect={() => undefined}>{accessStateLabel(access.state, levels)}</Option>
            </>
          )}
          {observedText && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{observedText}</DropdownMenuLabel>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog onOpenChange={(open) => { if (!open) setPending(null); }} open={pending !== null}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Allow {shownLevel?.label}?</DialogTitle>
            <DialogDescription>{DANGER[provider]}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setPending(null)} variant="outline">Cancel</Button>
            <Button onClick={() => { if (pending) onChoose(pending.id); setPending(null); }} variant="destructive">Use {shownLevel?.label}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
