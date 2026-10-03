import { expect, test } from 'vitest';
import type { AgentModel } from '@/shared/conversation-contract';
import { currentModel, menuModels, pickerModels, switchModel } from './model-choice';

const opus: AgentModel = { id: 'opus', label: 'Opus', efforts: ['low', 'high', 'max'] };
const haiku: AgentModel = { id: 'haiku', label: 'Haiku', efforts: [] };
const terra: AgentModel = { id: 'gpt-5.6-terra', label: 'Terra', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' };
const legacy: AgentModel = { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' };

test('lists an off-catalog current model first, under its raw id', () => {
  expect(pickerModels([opus], { model: 'claude-opus-5-5', effort: 'high' })).toEqual([{ id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['high'] }, opus]);
  expect(pickerModels([opus], { model: 'claude-opus-5-5' })[0].efforts).toEqual([]);
  expect(pickerModels([opus], { model: 'opus' })).toEqual([opus]);
  expect(pickerModels([opus], null)).toEqual([opus]);
});

test('keeps the effort when the new model accepts it', () => {
  expect(switchModel([opus, terra], { model: 'gpt-5.6-terra', effort: 'low' }, 'opus')).toEqual({ model: 'opus', effort: 'low' });
  expect(switchModel([opus], { model: 'claude-opus-5-5', effort: 'max' }, 'opus')).toEqual({ model: 'opus', effort: 'max' });
});

test('otherwise falls back to the new model default effort, or to none', () => {
  expect(switchModel([terra, legacy], { model: 'gpt-5.6-terra', effort: 'ultra' }, 'gpt-5.5')).toEqual({ model: 'gpt-5.5', effort: 'medium' });
  expect(switchModel([opus, haiku], { model: 'opus', effort: 'high' }, 'haiku')).toEqual({ model: 'haiku' });
  expect(switchModel([opus], null, 'opus')).toEqual({ model: 'opus' });
});

test('keeps the newest of each Claude family up front, Fable to Haiku, and the rest under More', () => {
  const claude = (id: string, label: string): AgentModel => ({ id, label, efforts: [] });
  const catalog = [
    claude('opus', 'Opus 5.5'), claude('sonnet', 'Sonnet 5.5'), claude('fable', 'Fable 5.1'), claude('haiku', 'Haiku 4.5'),
    claude('claude-sonnet-5', 'Sonnet 5'), claude('claude-opus-5', 'Opus 5'), claude('claude-fable-5', 'Fable 5'), claude('claude-opus-4-8', 'Opus 4.8'), claude('claude-opus-4-10', 'Opus 4.10'),
  ];
  const { primary, more } = menuModels(catalog);
  expect(primary.map((model) => model.label)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
  // Grouped by family in the same order, newest first within each.
  expect(more.map((model) => model.label)).toEqual(['Fable 5', 'Opus 5', 'Opus 4.10', 'Opus 4.8', 'Sonnet 5']);
});

test('lists models outside those families as they come, ahead of the families', () => {
  const { primary, more } = menuModels([{ id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: [] }, opus, terra, legacy, { id: 'opus-5', label: 'Opus 5', efforts: [] }]);
  expect(primary.map((model) => model.id)).toEqual(['claude-opus-5-5', 'opus', 'gpt-5.6-terra', 'opus-5', 'gpt-5.5']);
  expect(more).toEqual([]);
});

test('a conversation on the full id an alias points to shows as that alias, without a raw entry', () => {
  const aliased: AgentModel = { id: 'opus', label: 'Opus 5.5', resolvesTo: 'claude-opus-5-5', efforts: ['low', 'high'] };
  const pinned: AgentModel = { id: 'claude-opus-5-5', label: 'Opus 5.5 (pinned)', efforts: ['high'] };
  expect(currentModel([aliased], { model: 'claude-opus-5-5', effort: 'high' })).toBe(aliased);
  expect(pickerModels([aliased], { model: 'claude-opus-5-5' })).toEqual([aliased]);
  // An exact id wins over an alias that resolves to it.
  expect(currentModel([aliased, pinned], { model: 'claude-opus-5-5' })).toBe(pinned);
  expect(currentModel([aliased], null)).toBeUndefined();
});

test('groups Codex models by variant, in the order Codex lists them, with plain GPT as its own family', () => {
  const codex = (id: string, label: string): AgentModel => ({ id, label, efforts: [] });
  const { primary, more } = menuModels([
    codex('gpt-6-luna', 'GPT-6-Luna'), codex('gpt-5.6-terra', 'GPT-5.6-Terra'), codex('gpt-5.6-luna', 'GPT-5.6-Luna'), codex('gpt-5.5', 'GPT-5.5'), codex('gpt-5', 'GPT-5'),
  ]);
  expect(primary.map((model) => model.label)).toEqual(['GPT-6-Luna', 'GPT-5.6-Terra', 'GPT-5.5']);
  expect(more.map((model) => model.label)).toEqual(['GPT-5.6-Luna', 'GPT-5']);
});
