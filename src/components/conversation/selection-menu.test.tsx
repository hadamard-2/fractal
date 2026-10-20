// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SelectionMenu, useMessageSelection, type MessageSelection } from './selection-menu';

/** The canvas's pan, which dismisses the menu through the hook. */
let pan: () => void = () => undefined;

type Accepts = ((sourceId: string) => boolean) | null;

/** Two sources inside a container, and a third, plus a textarea, around it. */
function Harness({ accepts, onChoose }: { accepts: Accepts; onChoose: (selection: MessageSelection) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const { selection, dismiss } = useMessageSelection(container, accepts);
  pan = dismiss;
  return (
    <>
      <div ref={container}>
        <div>
          <div className="map-node-drag">You</div>
          <div data-selection-source="a">First message</div>
        </div>
        <div><div data-selection-source="b">Second message</div></div>
        <div data-selection-source="d"><textarea defaultValue="Typed draft" /></div>
      </div>
      <div data-selection-source="c">Beside the container</div>
      <p>Outside the map</p>
      {selection && <SelectionMenu onChoose={() => onChoose(selection)} selection={selection} />}
    </>
  );
}

/** Two containers side by side, each with its own hook. */
function Siblings() {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const leftSelection = useMessageSelection(left, () => true).selection;
  const rightSelection = useMessageSelection(right, () => true).selection;
  return (
    <>
      <div ref={left}><div data-selection-source="l">Left message</div></div>
      <div ref={right}><div data-selection-source="r">Right message</div></div>
      <output data-testid="seen">{`${leftSelection?.sourceId ?? '-'}|${rightSelection?.sourceId ?? '-'}`}</output>
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

test('choosing it hands over the source and the selected text', async () => {
  const onChoose = vi.fn();
  render(<Harness accepts={all} onChoose={onChoose} />);
  select('First message', 'First message', [6, 13]);
  const button = menu();
  if (!button) throw new Error('No menu');
  await userEvent.setup().click(button);
  expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'a', text: 'message' }));
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
  render(<Harness accepts={(sourceId) => sourceId === 'b'} onChoose={vi.fn()} />);
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

test('a selection made before it was disabled doesn\'t come back when it is enabled again', () => {
  const view = render(<Harness accepts={all} onChoose={vi.fn()} />);
  select('First message');
  expect(menu()).toBeTruthy();
  view.rerender(<Harness accepts={null} onChoose={vi.fn()} />);
  expect(menu()).toBeNull();
  view.rerender(<Harness accepts={all} onChoose={vi.fn()} />);
  expect(menu()).toBeNull();
  // A new selection still offers it.
  select('Second message');
  expect(menu()).toBeTruthy();
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

test('a source outside the container is never offered, even when accepts would take it', () => {
  render(<Harness accepts={all} onChoose={vi.fn()} />);
  select('Beside the container');
  expect(menu()).toBeNull();
  // Neither is a selection that starts inside the container and ends outside it.
  select('First message', 'Beside the container');
  expect(menu()).toBeNull();
});

test('two hooks with sibling containers each see only their own selections', () => {
  render(<Siblings />);
  const seen = () => screen.getByTestId('seen').textContent;
  select('Left message');
  expect(seen()).toBe('l|-');
  select('Right message');
  expect(seen()).toBe('-|r');
  select('Left message', 'Right message');
  expect(seen()).toBe('-|-');
});

test('text selected in a textarea inside the container shows no menu', () => {
  render(<Harness accepts={all} onChoose={vi.fn()} />);
  const field = screen.getByRole('textbox');
  if (!(field instanceof HTMLTextAreaElement)) throw new Error('No textarea');
  act(() => {
    field.focus();
    field.setSelectionRange(0, 5);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(menu()).toBeNull();
  // Where a browser also exposes a range, it puts its endpoints in the textarea's own text.
  const text = field.firstChild;
  if (!text) throw new Error('No text');
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 5);
  act(() => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(menu()).toBeNull();
});
