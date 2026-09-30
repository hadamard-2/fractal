import { PromptInputSelect, PromptInputSelectContent, PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue } from '@/components/ai-elements/prompt-input';
import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';
import { pickerModels, switchModel } from './model-choice';

interface Props {
  models: AgentModel[];
  choice: ModelChoice | null;
  onChoose(choice: ModelChoice): void;
  /** Called when the model list opens, so a catalog that arrived since can be shown. */
  onOpen(): void;
}

// The description lives inside the item text, so it is hidden when the trigger mirrors the selected item.
const DESCRIPTION = 'text-xs text-muted-foreground [[data-slot=select-trigger]_&]:hidden';

export function ModelPicker({ models, choice, onChoose, onOpen }: Props) {
  const listed = pickerModels(models, choice);
  const selected = choice ? listed.find((model) => model.id === choice.model) : undefined;
  return (
    <div className="flex min-w-0 items-center">
      {/* Radix's hidden native <select> can fire a spurious change to '' while its options are still catching up to a controlled value; a real pick never has an empty id. */}
      <PromptInputSelect onOpenChange={(open) => { if (open) onOpen(); }} onValueChange={(id) => { if (id) onChoose(switchModel(models, choice, id)); }} value={choice?.model ?? ''}>
        <PromptInputSelectTrigger aria-label="Model" className="h-8 max-w-48 px-2 text-xs" size="sm">
          <PromptInputSelectValue placeholder="Default" />
        </PromptInputSelectTrigger>
        <PromptInputSelectContent>
          {listed.map((model) => (
            <PromptInputSelectItem key={model.id} value={model.id}>
              <span className="flex flex-col">
                <span>{model.label}</span>
                {model.description && <span className={DESCRIPTION}>{model.description}</span>}
              </span>
            </PromptInputSelectItem>
          ))}
        </PromptInputSelectContent>
      </PromptInputSelect>
      {selected && selected.efforts.length > 0 && (
        <PromptInputSelect onValueChange={(effort) => onChoose({ model: selected.id, effort })} value={choice?.effort ?? selected.defaultEffort ?? ''}>
          <PromptInputSelectTrigger aria-label="Effort" className="h-8 px-2 text-xs" size="sm">
            <PromptInputSelectValue placeholder="Default" />
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            {selected.efforts.map((effort) => <PromptInputSelectItem key={effort} value={effort}>{effort}</PromptInputSelectItem>)}
          </PromptInputSelectContent>
        </PromptInputSelect>
      )}
    </div>
  );
}
