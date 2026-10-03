import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';

/**
 * The catalog entry the choice runs on: its exact id, else an alias that
 * currently resolves to it. History records full ids (`claude-opus-5-5`) while
 * the catalog may list only the alias (`opus`); the choice keeps its exact id,
 * so the conversation stays on that model if the alias later moves.
 */
export function currentModel(models: AgentModel[], choice: ModelChoice | null): AgentModel | undefined {
  if (!choice) return undefined;
  return models.find((model) => model.id === choice.model) ?? models.find((model) => model.resolvesTo === choice.model);
}

/** The catalog, with an off-catalog current model listed first under its raw id, so what the picker shows is what runs. */
export function pickerModels(models: AgentModel[], choice: ModelChoice | null): AgentModel[] {
  if (!choice || currentModel(models, choice)) return models;
  return [{ id: choice.model, label: choice.model, efforts: choice.effort ? [choice.effort] : [] }, ...models];
}

/** Moving to another model keeps the effort only when that model accepts it; otherwise its default, or none. */
export function switchModel(models: AgentModel[], choice: ModelChoice | null, modelId: string): ModelChoice {
  const target = models.find((model) => model.id === modelId);
  if (choice?.effort && target?.efforts.includes(choice.effort)) return { model: modelId, effort: choice.effort };
  return target?.defaultEffort ? { model: modelId, effort: target.defaultEffort } : { model: modelId };
}

/** Claude's model families, in the order the picker leads with them. */
const CLAUDE_FAMILIES = ['Fable', 'Opus', 'Sonnet', 'Haiku'];

interface Named { model: AgentModel; family: string; version: number[] }

/**
 * A model's family and version, read from its name: Claude's "<family>
 * <version>" for a known family, or Codex's "GPT-<version>[-<variant>]", where
 * the variant is the family and a plain "GPT-5.5" is a family of its own.
 */
function named(model: AgentModel): Named | undefined {
  const claude = /^(\S+) (\d+(?:\.\d+)*)$/.exec(model.label);
  if (claude && CLAUDE_FAMILIES.includes(claude[1])) return { model, family: claude[1], version: claude[2].split('.').map(Number) };
  const codex = /^GPT-(\d+(?:\.\d+)*)(?:-([A-Za-z]+))?$/.exec(model.label);
  if (codex) return { model, family: `GPT-${codex[2] ?? ''}`, version: codex[1].split('.').map(Number) };
  return undefined;
}

function newer(a: number[], b: number[]): boolean {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Splits the picker into a short first level and a "More models" level. Each
 * family counts once up front, by its newest version; its older versions go
 * under More, grouped in the same family order, newest first. Claude's
 * families lead in their fixed order; others follow in the order the agent
 * lists their newest model. Anything without a family (an off-catalog current
 * model, a name in another shape) stays up front, ahead of the families.
 */
export function menuModels(models: AgentModel[]): { primary: AgentModel[]; more: AgentModel[] } {
  const groups = new Map<string, Named[]>();
  for (const model of models) {
    const entry = named(model);
    if (entry) groups.set(entry.family, [...(groups.get(entry.family) ?? []), entry]);
  }
  const rank = (family: string) => { const index = CLAUDE_FAMILIES.indexOf(family); return index < 0 ? CLAUDE_FAMILIES.length : index; };
  const families = [...groups.values()]
    .map((entries) => [...entries].sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0)))
    .sort((a, b) => rank(a[0].family) - rank(b[0].family) || models.indexOf(a[0].model) - models.indexOf(b[0].model));
  return {
    primary: [...models.filter((model) => !named(model)), ...families.map((entries) => entries[0].model)],
    more: families.flatMap((entries) => entries.slice(1).map((entry) => entry.model)),
  };
}
