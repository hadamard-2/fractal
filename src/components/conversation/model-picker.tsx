import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';
import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';
import { Option, Trigger } from './composer-menu';
import { currentModel, menuModels, pickerModels, switchModel } from './model-choice';

interface Props {
  models: AgentModel[];
  choice: ModelChoice | null;
  onChoose(choice: ModelChoice): void;
  /** Called when the model list opens, so a catalog that arrived since can be shown. */
  onOpen(): void;
}

// The submenu is placed against its trigger, which sits inside the first level's padding and border; these offsets clear them to leave a small gap and match the outer bottom edges.
const SUB_SIDE_OFFSET = 9;
const SUB_ALIGN_OFFSET = -5;

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
