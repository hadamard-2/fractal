import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Every picker in the composer footer reads as the same quiet control while closed.
const TRIGGER = 'h-8 min-w-0 gap-1 px-2 has-[>svg]:px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground dark:hover:bg-accent/50 dark:aria-expanded:bg-accent/50';

/** A menu trigger; must sit inside a `DropdownMenu`. `icon` shows before the label. */
export function Trigger({ label, icon, children, className }: { label: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <PromptInputButton aria-label={label} className={cn(TRIGGER, className)} size="sm">
        {icon}
        <span className="truncate">{children}</span>
        <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
      </PromptInputButton>
    </DropdownMenuTrigger>
  );
}

/** An option; the current one is in the primary colour with a checkmark. */
export function Option({ current, onSelect, className, children }: { current: boolean; onSelect(): void; className?: string; children: ReactNode }) {
  return (
    <DropdownMenuItem className={cn(current && 'text-primary! [&_svg]:text-primary!', className)} onSelect={onSelect}>
      {children}
      {current && <CheckIcon className="ml-auto" />}
    </DropdownMenuItem>
  );
}
