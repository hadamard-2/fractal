import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';
import { currentModel, menuModels, pickerModels, switchModel } from './model-choice';

interface Props {
  models: AgentModel[];
  choice: ModelChoice | null;
  onChoose(choice: ModelChoice): void;
  /** Called when the model list opens, so a catalog that arrived since can be shown. */
  onOpen(): void;
}

// Both pickers read as the same quiet control while closed.
const TRIGGER = 'h-8 min-w-0 gap-1 px-2 has-[>svg]:px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground dark:hover:bg-accent/50 dark:aria-expanded:bg-accent/50';

function Trigger({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <PromptInputButton aria-label={label} className={cn(TRIGGER, className)} size="sm">
        <span className="truncate">{children}</span>
        <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
      </PromptInputButton>
    </DropdownMenuTrigger>
  );
}

// The submenu is placed against its trigger, which sits inside the first level's padding and border; these offsets clear them to leave a small gap and match the outer bottom edges.
const SUB_SIDE_OFFSET = 9;
const SUB_ALIGN_OFFSET = -5;

/** An option; the current one is in the primary colour with a checkmark. */
function Option({ current, onSelect, className, children }: { current: boolean; onSelect(): void; className?: string; children: ReactNode }) {
  return (
    <DropdownMenuItem className={cn(current && 'text-primary! [&_svg]:text-primary!', className)} onSelect={onSelect}>
      {children}
      {current && <CheckIcon className="ml-auto" />}
    </DropdownMenuItem>
  );
}

export function ModelPicker({ models, choice, onChoose, onOpen }: Props) {
  const listed = pickerModels(models, choice);
  const selected = currentModel(listed, choice);
  const { primary, more } = menuModels(listed);
  const effort = choice?.effort ?? selected?.defaultEffort;
  const modelOption = (model: AgentModel) => (
    <Option current={model === selected} key={model.id} onSelect={() => onChoose(switchModel(models, choice, model.id))}>{model.label}</Option>
  );
  return (
    <div className="flex min-w-0 items-center">
      <DropdownMenu onOpenChange={(open) => { if (open) onOpen(); }}>
        <Trigger className="max-w-48" label="Model">{selected?.label ?? 'Default'}</Trigger>
        {/* Both menus open above the composer with every option in view. */}
        <DropdownMenuContent align="start" side="top">
          {primary.map(modelOption)}
          {more.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>More models</DropdownMenuSubTrigger>
                {/* Beside the first level with a small gap, bottom edges lined up. */}
                <DropdownMenuSubContent align="end" alignOffset={SUB_ALIGN_OFFSET} sideOffset={SUB_SIDE_OFFSET}>{more.map(modelOption)}</DropdownMenuSubContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && selected.efforts.length > 0 && (
        <DropdownMenu>
          <Trigger className="capitalize" label="Effort">{effort ?? 'Default'}</Trigger>
          <DropdownMenuContent align="start" side="top">
            {/* Most effort first. */}
            {[...selected.efforts].reverse().map((level) => (
              <Option className="capitalize" current={level === effort} key={level} onSelect={() => onChoose({ model: selected.id, effort: level })}>{level}</Option>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
