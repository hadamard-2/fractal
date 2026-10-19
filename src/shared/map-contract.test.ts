import { expect, test } from 'vitest';
import { EMPTY_MAP_LAYOUT, parseMapLayout } from './map-contract';

const node = { x: 10, y: -20 };

test('copies a valid layout and drops extra keys', () => {
  const input = { view: 'full', extra: 1, nodes: { 'claude:a': { x: 1.5, y: -2, width: 400, junk: true }, 'claude:b': node } };
  const parsed = parseMapLayout(input);
  expect(parsed).toEqual({ view: 'full', nodes: { 'claude:a': { x: 1.5, y: -2, width: 400 }, 'claude:b': node } });
  expect(parsed.nodes['claude:b']).not.toBe(input.nodes['claude:b']);
  expect(Object.keys(parsed.nodes['claude:b'])).toEqual(['x', 'y']);
  expect(parseMapLayout(EMPTY_MAP_LAYOUT)).toEqual(EMPTY_MAP_LAYOUT);
});

test('keeps a node id that names an object prototype as plain data', () => {
  const parsed = parseMapLayout(JSON.parse('{"view":"preview","nodes":{"__proto__":{"x":1,"y":2}}}'));
  expect(Object.keys(parsed.nodes)).toEqual(['__proto__']);
  expect(Object.getPrototypeOf(parsed.nodes)).toBe(Object.prototype);
});

test('bounds the number of nodes and the length of a node id', () => {
  const nodes = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`n${i}`, node]));
  expect(Object.keys(parseMapLayout({ view: 'preview', nodes: nodes(5000) }).nodes)).toHaveLength(5000);
  expect(() => parseMapLayout({ view: 'preview', nodes: nodes(5001) })).toThrow('Invalid map layout');
  expect(() => parseMapLayout({ view: 'preview', nodes: { ['a'.repeat(600)]: node } })).not.toThrow();
  expect(() => parseMapLayout({ view: 'preview', nodes: { ['a'.repeat(601)]: node } })).toThrow('Invalid map layout');
});

test('bounds coordinates and widths to finite, sane values', () => {
  const layout = (n: unknown) => ({ view: 'preview', nodes: { a: n } });
  expect(() => parseMapLayout(layout({ x: 10_000_000, y: -10_000_000 }))).not.toThrow();
  const badNodes: unknown[] = [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 10_000_001, y: 0 }, { x: 0, y: -10_000_001 }, { x: '1', y: 0 }, { x: 0 }, 'a', null, []];
  for (const bad of badNodes) {
    expect(() => parseMapLayout(layout(bad)), JSON.stringify(bad)).toThrow('Invalid map layout');
  }
  expect(parseMapLayout(layout({ ...node, width: 240 })).nodes.a.width).toBe(240);
  expect(parseMapLayout(layout({ ...node, width: 960 })).nodes.a.width).toBe(960);
  for (const width of [239, 961, NaN, Infinity, '300', null]) {
    expect(() => parseMapLayout(layout({ ...node, width })), String(width)).toThrow('Invalid map layout');
  }
});

test('rejects any other view and malformed layouts', () => {
  for (const view of ['grid', '', undefined, 1]) expect(() => parseMapLayout({ view, nodes: {} })).toThrow('Invalid map layout');
  const badLayouts: unknown[] = [null, 'x', [], { view: 'full' }, { view: 'full', nodes: [] }, { view: 'full', nodes: null }];
  for (const bad of badLayouts) {
    expect(() => parseMapLayout(bad)).toThrow('Invalid map layout');
  }
});
