import type { ReactNode } from 'react';
import { PromptInputSelect, PromptInputSelectContent, PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue } from '@/components/ai-elements/prompt-input';
import { cn } from '@/lib/utils';
import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';
import { pickerModels, switchModel } from './model-choice';

interface Props {
  models: AgentModel[];
  choice: ModelChoice | null;
  onChoose(choice: ModelChoice): void;
  /** Called when the model list opens, so a catalog that arrived since can be shown. */
  onOpen(): void;
}

// Both pickers read as the same quiet control while closed. The select trigger's own dark-mode fill is overridden so it stays transparent.
const TRIGGER = 'h-8 min-w-0 gap-1 px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground dark:bg-transparent dark:hover:bg-accent/50 dark:aria-expanded:bg-accent/50';

// The current option, text and checkmark, in the primary colour. Important so it holds while the item is also focused.
const ITEM = 'data-[state=checked]:text-primary! data-[state=checked]:[&_svg]:text-primary!';

/** Both menus open above the composer with every option in view, rather than centred on the current one. */
function Menu({ children }: { children: ReactNode }) {
  return <PromptInputSelectContent align="start" position="popper" side="top">{children}</PromptInputSelectContent>;
}

export function ModelPicker({ models, choice, onChoose, onOpen }: Props) {
  const listed = pickerModels(models, choice);
  const selected = choice ? listed.find((model) => model.id === choice.model) : undefined;
  return (
    <div className="flex min-w-0 items-center">
      {/* Radix's hidden native <select> can fire a spurious change to '' while its options are still catching up to a controlled value; a real pick never has an empty id. */}
      <PromptInputSelect onOpenChange={(open) => { if (open) onOpen(); }} onValueChange={(id) => { if (id) onChoose(switchModel(models, choice, id)); }} value={choice?.model ?? ''}>
        <PromptInputSelectTrigger aria-label="Model" className={cn(TRIGGER, 'max-w-48')} size="sm">
          <PromptInputSelectValue placeholder="Default" />
        </PromptInputSelectTrigger>
        <Menu>
          {listed.map((model) => <PromptInputSelectItem className={ITEM} key={model.id} value={model.id}>{model.label}</PromptInputSelectItem>)}
        </Menu>
      </PromptInputSelect>
      {selected && selected.efforts.length > 0 && (
        <PromptInputSelect onValueChange={(effort) => onChoose({ model: selected.id, effort })} value={choice?.effort ?? selected.defaultEffort ?? ''}>
          <PromptInputSelectTrigger aria-label="Effort" className={cn(TRIGGER, 'capitalize')} size="sm">
            <PromptInputSelectValue placeholder="Default" />
          </PromptInputSelectTrigger>
          <Menu>
            {selected.efforts.map((effort) => <PromptInputSelectItem className={cn(ITEM, 'capitalize')} key={effort} value={effort}>{effort}</PromptInputSelectItem>)}
          </Menu>
        </PromptInputSelect>
      )}
    </div>
  );
}
