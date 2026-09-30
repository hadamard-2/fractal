import { describe, expect, test } from 'vitest';
import { MODEL_CHANNELS, parseModelChoice, parsePromptInput } from '@/shared/conversation-ipc';

describe('model choice contract', () => {
  test('accepts a model with or without an effort, and null for the agent default', () => {
    expect(parseModelChoice({ model: 'opus' })).toEqual({ model: 'opus' });
    expect(parseModelChoice({ model: 'gpt-5.5', effort: 'high' })).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(parseModelChoice(null)).toBeNull();
  });

  test.each([
    undefined, 'opus', { model: '' }, { model: '   ' }, { model: 'x'.repeat(201) },
    { model: 'opus', effort: '' }, { model: 'opus', effort: 3 }, { effort: 'high' },
  ])('rejects %j', (value) => {
    expect(() => parseModelChoice(value)).toThrow('Invalid model choice');
  });

  test('carries model and effort on a prompt only when given', () => {
    expect(parsePromptInput({ text: 'Go' })).toEqual({ text: 'Go' });
    expect(parsePromptInput({ text: 'Go', model: 'opus' })).toEqual({ text: 'Go', model: 'opus' });
    expect(parsePromptInput({ text: 'Go', model: 'opus', effort: 'high' })).toEqual({ text: 'Go', model: 'opus', effort: 'high' });
    expect(() => parsePromptInput({ text: 'Go', effort: 'high' })).toThrow('Invalid model choice');
    expect(() => parsePromptInput({ text: 'Go', model: 'x'.repeat(201) })).toThrow('Invalid model choice');
  });

  test('names its own channels', () => {
    expect(MODEL_CHANNELS).toEqual({ list: 'fractal:models:list', choose: 'fractal:models:choose' });
  });
});
