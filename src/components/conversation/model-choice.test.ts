import { expect, test } from 'vitest';
import type { AgentModel } from '@/shared/conversation-contract';
import { pickerModels, switchModel } from './model-choice';

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
