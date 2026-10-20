// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SelectionMenu, useMessageSelection, type MessageSelection } from './selection-menu';

/** The canvas's pan, which dismisses the menu through the hook. */
let pan: () => void = () => undefined;

function Harness({ accepts, onChoose }: { accepts: ((nodeId: string) => boolean) | null; onChoose: (selection: MessageSelection) => void }) {
  const { selection, dismiss } = useMessageSelection(accepts);
  pan = dismiss;
  return (
    <>
      <div className="react-flow__node" data-id="a">
        <div className="map-node-drag">You</div>
        <div data-map-message="">First message</div>
      </div>
      <div className="react-flow__node" data-id="b"><div data-map-message="">Second message</div></div>
      <p>Outside the map</p>
      {selection && <SelectionMenu onChoose={() => onChoose(selection)} selection={selection} />}
    </>
  );
}

/** Selects from `start` (at an offset into its text) to `end`, as a drag across the page would. */
function select(start: string, end = start, offsets: [number, number] = [0, end.length]) {
  const from = screen.getByText(start).firstChild;
  const to = screen.getByText(end).firstChild;
  if (!from || !to) throw new Error('No text to select');
  const range = document.createRange();
  range.setStart(from, offsets[0]);
  range.setEnd(to, offsets[1]);
  act(() => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

function collapse() {
  act(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

const menu = () => screen.queryByRole('button', { name: 'Side chat' });
const all = () => true;

beforeEach(() => {
  Range.prototype.getBoundingClientRect = () => DOMRect.fromRect({ x: 120, y: 200, width: 80, height: 20 });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  window.getSelection()?.removeAllRanges();
});

test('a selection inside one message shows a Side chat button by it, outside the canvas transform', () => {
  render(<Harness accepts={all} onChoose={vi.fn()} />);
  select('First message', 'First message', [6, 13]);
  const button = menu();
  expect(button).toBeTruthy();
  const panel = button?.closest('[data-slot="selection-menu"]');
  expect(panel?.parentElement).toBe(document.body);
  expect(panel instanceof HTMLElement && panel.style.position).toBe('fixed');
  expect(panel instanceof HTMLElement && [panel.style.left, panel.style.top]).toEqual(['120px', '226px']);
});

test('choosing it hands over the node and the selected text', async () => {
  const onChoose = vi.fn();
  render(<Harness accepts={all} onChoose={onChoose} />);
  select('First message', 'First message', [6, 13]);
  const button = menu();
  if (!button) throw new Error('No menu');
  await userEvent.setup().click(button);
  expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'a', text: 'message' }));
});

test('a selection spanning two messages, or outside any, shows no menu', () => {
  render(<Harness accepts={all} onChoose={vi.fn()} />);
  select('First message', 'Second message');
  expect(menu()).toBeNull();
  select('Outside the map');
  expect(menu()).toBeNull();
  // A node's header is not its message.
  select('You', 'First message');
  expect(menu()).toBeNull();
});

test('a blank selection, or one in a message that can\'t branch, shows no menu', () => {
  render(<Harness accepts={(nodeId) => nodeId === 'b'} onChoose={vi.fn()} />);
  select('First message');
  expect(menu()).toBeNull();
  select('Second message', 'Second message', [6, 7]);
  expect(menu()).toBeNull();
  select('Second message');
  expect(menu()).toBeTruthy();
});

test('read-only offers nothing', () => {
  render(<Harness accepts={null} onChoose={vi.fn()} />);
  select('First message');
  expect(menu()).toBeNull();
});

test('the menu goes when the selection collapses, the page scrolls, or the canvas moves', () => {
  render(<Harness accepts={all} onChoose={vi.fn()} />);
  select('First message');
  expect(menu()).toBeTruthy();
  collapse();
  expect(menu()).toBeNull();

  select('First message');
  act(() => { window.dispatchEvent(new Event('scroll')); });
  expect(menu()).toBeNull();

  select('First message');
  act(() => { pan(); });
  expect(menu()).toBeNull();
  // It comes back once the selection changes again.
  select('First message', 'First message', [0, 5]);
  expect(menu()).toBeTruthy();
});
