import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';

/** The catalog, with an off-catalog current model listed first under its raw id, so what the picker shows is what runs. */
export function pickerModels(models: AgentModel[], choice: ModelChoice | null): AgentModel[] {
  if (!choice || models.some((model) => model.id === choice.model)) return models;
  return [{ id: choice.model, label: choice.model, efforts: choice.effort ? [choice.effort] : [] }, ...models];
}

/** Moving to another model keeps the effort only when that model accepts it; otherwise its default, or none. */
export function switchModel(models: AgentModel[], choice: ModelChoice | null, modelId: string): ModelChoice {
  const target = models.find((model) => model.id === modelId);
  if (choice?.effort && target?.efforts.includes(choice.effort)) return { model: modelId, effort: choice.effort };
  return target?.defaultEffort ? { model: modelId, effort: target.defaultEffort } : { model: modelId };
}
