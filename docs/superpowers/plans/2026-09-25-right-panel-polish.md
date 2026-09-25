# Right Panel Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Execute-only right panel into one app-level panel shared by every mode, with a panel toggle in the far-right corner, a mode toggle that slides to the panel's edge, the left sidebar's open/close motion, compact tabs, a Codex-style tool list, and a `Ctrl+`` terminal toggle.

**Architecture:** `App` owns the panel's open state, its width, and the Execute project path, and renders one `RightWorkspace` around all modes plus a fixed corner strip holding the mode toggle and the panel toggle. `RightWorkspace` measures its own box and the active mode's left inset, derives split/overlay layout and the header space to reserve from a pure layout module, and publishes that reserve as a CSS variable for content headers. All motion is CSS in `index.css`, keyed by `data-slot` attributes and suspended while a resize drag is active, mirroring the left sidebar's existing pattern.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, Tailwind v4, Radix/shadcn (`dropdown-menu`, `tooltip`), lucide-react, `@xterm/xterm` with `@xterm/addon-fit`, Vitest with Testing Library and jsdom.

**Spec:** [docs/superpowers/specs/2026-09-25-right-sidebar-terminal-design.md](../specs/2026-09-25-right-sidebar-terminal-design.md)

## Global Constraints

- The panel starts closed. One panel instance is mounted at the app level for the app's lifetime; changing modes never unmounts it or its terminal views.
- Panel width: 320px minimum, 720px maximum; set once, on first open, to 40% of the space right of the left sidebar; afterwards it changes only by resizing. The content beside a split panel keeps at least 420px.
- Motion: 200ms, linear — the left sidebar's `duration-200 ease-linear`. No easing during drag-resize. `prefers-reduced-motion: reduce` makes open/close immediate.
- Tool entries, in order: Review, Terminal, Browser, Files, Side chat. Only Terminal works. Terminal's hint reads `Ctrl+``; the others read `Soon`, use secondary text colour (not reduced opacity), and are disabled.
- `Ctrl+`` is matched on `event.code === 'Backquote'` with Ctrl and no other modifier, in the capture phase, so a focused terminal never receives it.
- Keep `contextIsolation: true` and `nodeIntegration: false`; no Node APIs in the renderer. This plan does not touch the main process, preload, or terminal contract.
- Do not change the build config or the version pins in `docs/environment-notes.md`.
- The working tree holds the earlier, uncommitted terminal work and unrelated Claude probe edits. Commit only when executing under `superpowers:subagent-driven-development` or when the user explicitly asks; never push. Leave the Claude probe files untouched.
- Markdown edits keep each paragraph on one line.

## Review Focus

- The mode toggle's slide and the header reserve must use the same geometry. `CLOSED_MODE_TOGGLE_RIGHT` in the layout module encodes App's strip (12px inset, 32px panel toggle, 4px gap); Task 6 builds that strip. A mismatch shows as the toggle stopping short of, or overlapping, the panel edge.
- Focus from `Ctrl+`` when the panel was closed: the panel's `visibility` must switch to visible without delay on open (Task 6 CSS), or `terminal.focus()` lands on a still-hidden element and silently fails.
- Per-frame renders: measuring the left inset happens inside `RightWorkspace` so a left-sidebar animation re-renders only the panel, not `App` and the conversation tree. `children` is passed through unchanged, so React skips re-rendering it.
- The default width is written back to `App` in a layout effect, so the first open paints with the mode toggle already at its target instead of one frame later.

## File Structure

- Create `src/renderer/right-panel-layout.ts` — pure geometry: width clamps and default, split/overlay decision, resize cap, header reserve, mode toggle shift.
- Create `src/components/right-panel/tool-entries.tsx` — the five tool entries, rendered as the empty-state list and as `+` menu items.
- Create `src/components/right-panel/terminal-tabs.tsx` — the `TerminalTab` type, tab labelling, and the tab strip.
- Modify `src/components/mode-toggle.tsx` — export the toggle's rendered width.
- Modify `src/components/terminal-view.tsx` — inset surface colours, focus requests, exit reporting, started directory.
- Modify `src/components/right-workspace.tsx` — becomes the app-level panel container: measurement, layout, gap and sliding panel, header, empty state, tab panels, resize handle, `Ctrl+``.
- Modify `src/components/execute-mode.tsx` — drop the panel, expose its content inset and selected project, reserve header space.
- Modify `src/App.tsx` — own panel state, render the corner strip and the panel around all modes.
- Modify `src/index.css` — panel motion and resize suppression.
- Tests beside each file: `right-panel-layout.test.ts`, `tool-entries.test.tsx`, `terminal-tabs.test.tsx`, `terminal-view.test.tsx`, `right-workspace.test.tsx`, `execute-mode.test.tsx`, `App.test.tsx`.

---

### Task 1: Panel geometry

**Files:**
- Modify: `src/components/mode-toggle.tsx` (after the `itemOffsets` declaration)
- Create: `src/renderer/right-panel-layout.ts`
- Test: `src/renderer/right-panel-layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: from `@/components/mode-toggle`: `MODE_TOGGLE_WIDTH: number` (128). From `@/renderer/right-panel-layout`: `PANEL_MIN_WIDTH = 320`, `PANEL_MAX_WIDTH = 720`, `CONTENT_MIN_WIDTH = 420`, `CLOSED_MODE_TOGGLE_RIGHT = 48`, `clampPanelWidth(value: number): number`, `defaultPanelWidth(containerWidth: number, leftInset: number): number`, `type PanelLayout = { split: boolean; maxWidth: number; headerReserve: number }`, `panelLayout(input: { open: boolean; width: number; containerWidth: number; leftInset: number }): PanelLayout`, `modeToggleShift(open: boolean, width: number): number`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/right-panel-layout.test.ts`:

```ts
import { expect, test } from 'vitest';
import { MODE_TOGGLE_WIDTH } from '@/components/mode-toggle';
import { CLOSED_MODE_TOGGLE_RIGHT, defaultPanelWidth, modeToggleShift, panelLayout } from './right-panel-layout';

test('the mode toggle is as wide as its items, their gaps, and its padding', () => {
  expect(MODE_TOGGLE_WIDTH).toBe(128);
});

test('defaults to 40% of the space right of the left sidebar, clamped', () => {
  expect(defaultPanelWidth(1400, 300)).toBe(440);
  expect(defaultPanelWidth(600, 0)).toBe(320);
  expect(defaultPanelWidth(3000, 0)).toBe(720);
});

test('splits only when the content keeps its minimum beside the open panel', () => {
  expect(panelLayout({ open: true, width: 400, containerWidth: 1120, leftInset: 300 }).split).toBe(true);
  expect(panelLayout({ open: true, width: 400, containerWidth: 1119, leftInset: 300 }).split).toBe(false);
  expect(panelLayout({ open: false, width: 400, containerWidth: 3000, leftInset: 0 }).split).toBe(false);
});

test('caps resizing at what leaves the content its minimum while split', () => {
  expect(panelLayout({ open: true, width: 400, containerWidth: 1300, leftInset: 300 }).maxWidth).toBe(580);
  expect(panelLayout({ open: true, width: 400, containerWidth: 1000, leftInset: 300 }).maxWidth).toBe(720);
});

test('reserves header space for whichever toggles sit in the header row', () => {
  expect(panelLayout({ open: false, width: 400, containerWidth: 1600, leftInset: 0 }).headerReserve).toBe(CLOSED_MODE_TOGGLE_RIGHT + 128 + 8);
  expect(panelLayout({ open: true, width: 400, containerWidth: 1600, leftInset: 0 }).headerReserve).toBe(136);
  expect(panelLayout({ open: true, width: 400, containerWidth: 700, leftInset: 0 }).headerReserve).toBe(536);
});

test('moves the mode toggle to the panel edge only while open', () => {
  expect(modeToggleShift(false, 400)).toBe(0);
  expect(modeToggleShift(true, 400)).toBe(352);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/renderer/right-panel-layout.test.ts`
Expected: FAIL — `Failed to resolve import "./right-panel-layout"`.

- [ ] **Step 3: Export the toggle width**

In `src/components/mode-toggle.tsx`, directly after the `itemOffsets` declaration, add:

```ts
// The toggle's rendered width: the last item's offset plus its own width,
// plus the group's `p-1` on both sides. The right panel reads it to keep
// header titles clear of the toggle.
export const MODE_TOGGLE_WIDTH = itemOffsets[itemOffsets.length - 1] + ITEM_WIDTH + 8;
```

- [ ] **Step 4: Write the layout module**

Create `src/renderer/right-panel-layout.ts`:

```ts
import { MODE_TOGGLE_WIDTH } from '@/components/mode-toggle';

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 720;
export const CONTENT_MIN_WIDTH = 420;

/*
  Where the mode toggle's right edge sits, measured from the window's right
  edge, while the panel is closed. App's corner strip lays out
  [mode toggle][4px gap][32px panel toggle] with a 12px inset — that is
  (--app-bar-height 56px − 32px) / 2, so the panel toggle is as far from the
  window edge as from the band's top and bottom. Change those and this
  together.
*/
export const CLOSED_MODE_TOGGLE_RIGHT = 12 + 32 + 4;

// Space kept between the mode toggle and a title that ellipsizes before it.
const TITLE_CLEARANCE = 8;

export const clampPanelWidth = (value: number): number =>
  Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, value));

export const defaultPanelWidth = (containerWidth: number, leftInset: number): number =>
  clampPanelWidth((containerWidth - leftInset) * 0.4);

export type PanelLayout = {
  // The panel sits beside the content instead of over it.
  split: boolean;
  // The widest a resize may go without breaking the split.
  maxWidth: number;
  // How much of the content's header, from its right edge, the toggles cover.
  headerReserve: number;
};

export function panelLayout({ open, width, containerWidth, leftInset }: {
  open: boolean;
  width: number;
  containerWidth: number;
  leftInset: number;
}): PanelLayout {
  const available = containerWidth - leftInset;
  const split = open && available >= width + CONTENT_MIN_WIDTH;
  const maxWidth = split ? clampPanelWidth(available - CONTENT_MIN_WIDTH) : PANEL_MAX_WIDTH;
  // Open, the toggle's right edge meets the panel's outer edge; closed, it
  // sits beside the panel toggle. The content's own right edge is the panel's
  // edge only when split — in overlay the content runs under the panel.
  const toggleRight = open ? width : CLOSED_MODE_TOGGLE_RIGHT;
  const contentRight = split ? width : 0;
  return { split, maxWidth, headerReserve: toggleRight + MODE_TOGGLE_WIDTH + TITLE_CLEARANCE - contentRight };
}

// How far left of its closed position the mode toggle moves.
export const modeToggleShift = (open: boolean, width: number): number =>
  open ? width - CLOSED_MODE_TOGGLE_RIGHT : 0;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/renderer/right-panel-layout.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit (only under subagent-driven-development or on the user's request)**

```bash
git add src/components/mode-toggle.tsx src/renderer/right-panel-layout.ts src/renderer/right-panel-layout.test.ts
git commit -m "feat(right-panel): add panel geometry module"
```

---

### Task 2: Tool entries

**Files:**
- Create: `src/components/right-panel/tool-entries.tsx`
- Test: `src/components/right-panel/tool-entries.test.tsx`

**Interfaces:**
- Consumes: `DropdownMenuItem` from `@/components/ui/dropdown-menu`, `cn` from `@/lib/utils`.
- Produces: `ToolList({ onTerminal }: { onTerminal: () => void })` — the empty-state list, `role="menu"` labelled "Add a tool", each entry `role="menuitem"`. `ToolMenuItems({ onTerminal }: { onTerminal: () => void })` — the same entries as `DropdownMenuItem`s, to render inside a `DropdownMenuContent`. Entry accessible names are exactly their labels; Terminal carries `aria-keyshortcuts="Control+`"`.

- [ ] **Step 1: Write the failing test**

Create `src/components/right-panel/tool-entries.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolList } from './tool-entries';

afterEach(cleanup);

test('lists every tool in order with only Terminal available', async () => {
  const onTerminal = vi.fn();
  render(<ToolList onTerminal={onTerminal} />);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'ReviewSoon', 'TerminalCtrl+`', 'BrowserSoon', 'FilesSoon', 'Side chatSoon',
  ]);
  for (const name of ['Review', 'Browser', 'Files', 'Side chat']) {
    expect(screen.getByRole('menuitem', { name }).hasAttribute('disabled')).toBe(true);
  }
  const terminal = screen.getByRole('menuitem', { name: 'Terminal' });
  expect(terminal.hasAttribute('disabled')).toBe(false);
  expect(terminal.getAttribute('aria-keyshortcuts')).toBe('Control+`');
  await userEvent.setup().click(terminal);
  expect(onTerminal).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/components/right-panel/tool-entries.test.tsx`
Expected: FAIL — `Failed to resolve import "./tool-entries"`.

- [ ] **Step 3: Write the component**

Create `src/components/right-panel/tool-entries.tsx`:

```tsx
import { FileDiff, Folder, Globe, MessageCirclePlus, SquareTerminal, type LucideIcon } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ToolEntry = { id: 'review' | 'terminal' | 'browser' | 'files' | 'side-chat'; label: string; Icon: LucideIcon };

// Only Terminal exists so far; the others are listed so the panel shows its
// intended shape before they land.
const TOOL_ENTRIES: readonly ToolEntry[] = [
  { id: 'review', label: 'Review', Icon: FileDiff },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'side-chat', label: 'Side chat', Icon: MessageCirclePlus },
];

// The hint is decoration for sighted users; the shortcut itself is exposed
// through `aria-keyshortcuts` and unavailability through `disabled`.
function Hint({ available }: { available: boolean }) {
  return (
    <span aria-hidden className={cn('ml-auto rounded border border-sidebar-border px-1.5 text-[11px] leading-4 text-muted-foreground', available ? 'font-mono' : 'font-sans')}>
      {available ? 'Ctrl+`' : 'Soon'}
    </span>
  );
}

export function ToolList({ onTerminal }: { onTerminal: () => void }) {
  return (
    <div aria-label="Add a tool" className="w-full max-w-sm space-y-2" role="menu">
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const available = id === 'terminal';
        return (
          <button
            aria-keyshortcuts={available ? 'Control+`' : undefined}
            className={cn(
              'flex h-10 w-full items-center gap-3 rounded-lg bg-sidebar-accent/60 px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring',
              available ? 'hover:bg-sidebar-accent' : 'cursor-default text-muted-foreground',
            )}
            disabled={!available}
            key={id}
            onClick={available ? onTerminal : undefined}
            role="menuitem"
            type="button"
          >
            <Icon aria-hidden className="size-4" />
            {label}
            <Hint available={available} />
          </button>
        );
      })}
    </div>
  );
}

export function ToolMenuItems({ onTerminal }: { onTerminal: () => void }) {
  return (
    <>
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const available = id === 'terminal';
        return (
          <DropdownMenuItem
            aria-keyshortcuts={available ? 'Control+`' : undefined}
            // The menu item's default dims disabled entries to 50%; the spec
            // keeps them readable in the secondary text colour instead.
            className="gap-3 data-[disabled]:text-muted-foreground data-[disabled]:opacity-100"
            disabled={!available}
            key={id}
            onSelect={available ? onTerminal : undefined}
          >
            <Icon aria-hidden />
            {label}
            <Hint available={available} />
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/components/right-panel/tool-entries.test.tsx`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit (only under subagent-driven-development or on the user's request)**

```bash
git add src/components/right-panel/tool-entries.tsx src/components/right-panel/tool-entries.test.tsx
git commit -m "feat(right-panel): add tool entries list and menu items"
```

---

### Task 3: Terminal tabs

**Files:**
- Create: `src/components/right-panel/terminal-tabs.tsx`
- Test: `src/components/right-panel/terminal-tabs.test.tsx`

**Interfaces:**
- Consumes: `Tooltip`, `TooltipTrigger`, `TooltipContent` from `@/components/ui/tooltip` (the caller supplies a `TooltipProvider`).
- Produces: `type TerminalTab = { id: string; cwd: string | null; number: number; shell?: string; startedIn?: string; exited?: boolean }`, `terminalTabLabel(tab: TerminalTab): string`, `TerminalTabs(props: { tabs: TerminalTab[]; selectedId: string | null; onSelect: (id: string) => void; onClose: (id: string) => void })`. Each tab button has `id={tab.id}`, `role="tab"`, `aria-controls="terminal-panel-${tab.id}"`; the close button is labelled `Close ${label}`.

- [ ] **Step 1: Write the failing test**

Create `src/components/right-panel/terminal-tabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalTabs, terminalTabLabel, type TerminalTab } from './terminal-tabs';

afterEach(cleanup);

test('labels tabs by shell, numbering all but the first', () => {
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 1 })).toBe('Terminal');
  expect(terminalTabLabel({ id: 'a', cwd: null, number: 1, shell: 'zsh' })).toBe('zsh');
  expect(terminalTabLabel({ id: 'b', cwd: null, number: 2, shell: 'zsh' })).toBe('zsh 2');
  expect(terminalTabLabel({ id: 'c', cwd: null, number: 3 })).toBe('Terminal 3');
});

test('selects, closes, closes on middle-click, and marks exited shells', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const tabs: TerminalTab[] = [
    { id: 'a', cwd: '/repo', number: 1, shell: 'zsh' },
    { id: 'b', cwd: '/repo', number: 2, shell: 'zsh', exited: true },
  ];
  render(<TooltipProvider><TerminalTabs onClose={onClose} onSelect={onSelect} selectedId="a" tabs={tabs} /></TooltipProvider>);
  const user = userEvent.setup();
  expect(screen.getByRole('tab', { name: 'zsh' }).getAttribute('aria-selected')).toBe('true');
  const exited = screen.getByRole('tab', { name: 'zsh 2 (exited)' });
  expect(exited.getAttribute('aria-selected')).toBe('false');
  await user.click(exited);
  expect(onSelect).toHaveBeenCalledWith('b');
  await user.click(screen.getByRole('button', { name: 'Close zsh' }));
  expect(onClose).toHaveBeenCalledWith('a');
  fireEvent(exited, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith('b');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/components/right-panel/terminal-tabs.test.tsx`
Expected: FAIL — `Failed to resolve import "./terminal-tabs"`.

- [ ] **Step 3: Write the component**

Create `src/components/right-panel/terminal-tabs.tsx`:

```tsx
import { SquareTerminal, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type TerminalTab = {
  id: string;
  // The directory requested at creation; null lets the main process choose.
  cwd: string | null;
  // Creation order, never reused, so labels stay stable as tabs close.
  number: number;
  // The shell's name, once it has started.
  shell?: string;
  // The directory the shell actually started in, once known.
  startedIn?: string;
  exited?: boolean;
};

export function terminalTabLabel(tab: TerminalTab): string {
  const base = tab.shell ?? 'Terminal';
  return tab.number > 1 ? `${base} ${tab.number}` : base;
}

export function TerminalTabs({ tabs, selectedId, onSelect, onClose }: {
  tabs: TerminalTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div aria-label="Right workspace tabs" className="scrollbar-minimal flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
      {tabs.map((tab) => {
        const label = terminalTabLabel(tab);
        const selected = selectedId === tab.id;
        return (
          <div
            className="group flex h-8 shrink-0 items-center rounded-md border border-transparent text-xs text-muted-foreground hover:text-foreground data-[selected=true]:border-sidebar-border data-[selected=true]:bg-background data-[selected=true]:text-foreground"
            data-selected={selected}
            key={tab.id}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(tab.id);
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-controls={`terminal-panel-${tab.id}`}
                  aria-selected={selected}
                  className="flex h-full max-w-40 items-center gap-1.5 rounded-md pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-ring"
                  id={tab.id}
                  onClick={() => onSelect(tab.id)}
                  role="tab"
                  type="button"
                >
                  <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                  {tab.exited && (
                    <>
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
                      <span className="sr-only"> (exited)</span>
                    </>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tab.startedIn ?? tab.cwd ?? 'App working directory'}</TooltipContent>
            </Tooltip>
            <button
              aria-label={`Close ${label}`}
              className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100 group-data-[selected=true]:opacity-100"
              onClick={() => onClose(tab.id)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/components/right-panel/terminal-tabs.test.tsx`
Expected: PASS, 2 tests. If the exited tab's accessible name comes out without the space (`zsh 2(exited)`), the sr-only text lost its leading space — keep it on the same line as the opening tag.

- [ ] **Step 5: Commit (only under subagent-driven-development or on the user's request)**

```bash
git add src/components/right-panel/terminal-tabs.tsx src/components/right-panel/terminal-tabs.test.tsx
git commit -m "feat(right-panel): add compact terminal tab strip"
```

---

### Task 4: Terminal view: inset surface, focus requests, exit reporting

**Files:**
- Modify: `src/components/terminal-view.tsx`
- Test: `src/components/terminal-view.test.tsx`

**Interfaces:**
- Consumes: `window.fractal.terminals.create` resolving `{ shell: string; cwd: string }` (existing contract).
- Produces: `TerminalView` props become `{ id: string; cwd: string | null; visible: boolean; focusToken?: number; onShellReady: (started: { shell: string; cwd: string }) => void; onExitedChange?: (exited: boolean) => void }`. A changed, non-zero `focusToken` focuses the terminal as soon as it is visible; each token is honoured once. The xterm host carries `data-slot="terminal"`.

- [ ] **Step 1: Update the tests**

In `src/components/terminal-view.test.tsx`:

Add `focus: vi.fn()` to the hoisted mocks and `focus = mocks.focus;` to the mocked `Terminal` class:

```tsx
const mocks = vi.hoisted(() => ({
  write: vi.fn(), fit: vi.fn(), resize: vi.fn(), open: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
  onData: undefined as undefined | ((data: string) => void),
}));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {};
  write = mocks.write; open = mocks.open; dispose = mocks.dispose; focus = mocks.focus;
  loadAddon = vi.fn();
  onData(listener: (data: string) => void) { mocks.onData = listener; return { dispose: vi.fn() }; }
} }));
```

In the first test, change the `onShellReady` expectation to:

```tsx
  expect(onShellReady).toHaveBeenCalledWith({ shell: '/bin/sh', cwd: '/repo' });
```

Append two tests:

```tsx
test('focuses once per request, and only while visible', () => {
  const view = render(<TerminalView id="one" cwd="/repo" visible={false} focusToken={1} onShellReady={vi.fn()} />);
  expect(mocks.focus).not.toHaveBeenCalled();
  view.rerender(<TerminalView id="one" cwd="/repo" visible focusToken={1} onShellReady={vi.fn()} />);
  expect(mocks.focus).toHaveBeenCalledTimes(1);
  view.rerender(<TerminalView id="one" cwd="/repo" visible={false} focusToken={1} onShellReady={vi.fn()} />);
  view.rerender(<TerminalView id="one" cwd="/repo" visible focusToken={1} onShellReady={vi.fn()} />);
  expect(mocks.focus).toHaveBeenCalledTimes(1);
  view.rerender(<TerminalView id="one" cwd="/repo" visible focusToken={2} onShellReady={vi.fn()} />);
  expect(mocks.focus).toHaveBeenCalledTimes(2);
});

test('reports when its shell exits and when it restarts', async () => {
  const user = userEvent.setup();
  const onExitedChange = vi.fn();
  render(<TerminalView id="one" cwd="/repo" visible onShellReady={vi.fn()} onExitedChange={onExitedChange} />);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  act(() => listener?.({ type: 'exit', id: 'one', exitCode: 0 }));
  expect(onExitedChange).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole('button', { name: 'Restart terminal' }));
  await waitFor(() => expect(onExitedChange).toHaveBeenLastCalledWith(false));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/components/terminal-view.test.tsx`
Expected: FAIL — the first test sees `onShellReady` called with `'/bin/sh'`, and the focus test sees `focus` never called.

- [ ] **Step 3: Implement**

In `src/components/terminal-view.tsx`:

Replace the props signature:

```tsx
export function TerminalView({ id, cwd, visible, focusToken = 0, onShellReady, onExitedChange }: {
  id: string;
  cwd: string | null;
  visible: boolean;
  // Bumped by the panel to ask for keyboard focus; each value is honoured once.
  focusToken?: number;
  onShellReady: (started: { shell: string; cwd: string }) => void;
  onExitedChange?: (exited: boolean) => void;
}) {
```

After the existing `onShellReadyRef` lines, add:

```tsx
  const onExitedChangeRef = useRef(onExitedChange);
  onExitedChangeRef.current = onExitedChange;
  const terminalRef = useRef<Terminal | null>(null);
  const handledFocus = useRef(0);
```

Inside the main effect, directly after `terminal.open(host);`, add `terminalRef.current = terminal;`. Replace the theme function so the terminal matches its inset surface:

```tsx
    const applyTheme = () => {
      const style = getComputedStyle(host);
      terminal.options.theme = {
        background: style.getPropertyValue('--background').trim() || '#0a0a0a',
        foreground: style.getPropertyValue('--foreground').trim() || '#fafafa',
      };
    };
```

Replace the `creating.then` handler's head so the started directory is passed on:

```tsx
    void creating.then(({ shell, cwd: startedIn }) => {
      if (disposed) { void window.fractal.terminals.close(id).catch((): void => undefined); return; }
      started = true;
      onShellReadyRef.current({ shell, cwd: startedIn });
      if (!exited) setState('running');
      fitNow();
    }).catch(() => { if (!disposed) setState('error'); });
```

In the effect's cleanup, add `terminalRef.current = null;` before `terminal.dispose();`.

After the existing `useEffect(() => { if (visible) fitRef.current?.(); }, [visible]);`, add:

```tsx
  useEffect(() => { onExitedChangeRef.current?.(state === 'exited'); }, [state]);

  // Declared after the main effect so, on a tab's first mount, the terminal
  // exists by the time a focus request is honoured.
  useEffect(() => {
    if (!visible || focusToken === handledFocus.current) return;
    handledFocus.current = focusToken;
    terminalRef.current?.focus();
  }, [focusToken, visible]);
```

Replace the returned wrapper's surface classes and tag the host:

```tsx
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div aria-label="Terminal" className="h-full w-full" data-slot="terminal" ref={hostRef} />
      </div>
```

Leave the exit and error status blocks as they are, but change their `bg-sidebar` to `bg-background`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/components/terminal-view.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit (only under subagent-driven-development or on the user's request)**

```bash
git add src/components/terminal-view.tsx src/components/terminal-view.test.tsx
git commit -m "feat(terminal): support focus requests and report exits"
```

---

### Task 5: App-level panel container

**Files:**
- Modify (full rewrite): `src/components/right-workspace.tsx`
- Test (full rewrite): `src/components/right-workspace.test.tsx`

**Interfaces:**
- Consumes: Task 1's `clampPanelWidth`, `defaultPanelWidth`, `panelLayout`, `PANEL_MIN_WIDTH`; Task 2's `ToolList`, `ToolMenuItems`; Task 3's `TerminalTabs`, `TerminalTab`; Task 4's `TerminalView` props.
- Produces: `RightWorkspace(props: { open: boolean; onOpenChange: (open: boolean) => void; width: number | null; onWidthChange: (width: number) => void; onResizingChange: (resizing: boolean) => void; leftInsetRef?: RefObject<HTMLElement | null>; projectPath: string | null; children: ReactNode })`. It no longer renders its own toggle button. DOM contract used by Task 6's CSS and App: the content wrapper sets `--app-bar-reserve` in px; the gap is `data-slot="right-panel-gap"`; the panel is `aside[data-slot="right-panel"]` with `data-open` while open, `aria-hidden` and `inert` while closed.

- [ ] **Step 1: Write the failing tests**

Replace `src/components/right-workspace.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { RightWorkspace } from './right-workspace';

vi.mock('./terminal-view', () => ({
  TerminalView: ({ cwd, focusToken }: { cwd: string | null; focusToken?: number }) => (
    <div data-slot="terminal"><textarea aria-label="Terminal input" data-cwd={cwd ?? ''} data-focus-token={focusToken ?? 0} /></div>
  ),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const box = (left: number, width: number) => ({ left, width, x: left, y: 0, top: 0, right: left + width, bottom: 800, height: 800, toJSON: () => undefined });

function Harness({ withInset = false, onResizingChange = () => undefined }: { withInset?: boolean; onResizingChange?: (resizing: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <button onClick={() => setOpen(!open)} type="button">{open ? 'Close panel' : 'Open panel'}</button>
      <RightWorkspace leftInsetRef={withInset ? insetRef : undefined} onOpenChange={setOpen} onResizingChange={onResizingChange} onWidthChange={setWidth} open={open} projectPath="/repo" width={width}>
        <div data-inset={withInset || undefined} ref={insetRef}>Content</div>
      </RightWorkspace>
    </>
  );
}

const panel = () => screen.getByRole('complementary', { name: 'Right workspace', hidden: true });
const pressToggle = (target: Element) => fireEvent.keyDown(target, { key: '`', code: 'Backquote', ctrlKey: true });

test('opens empty, creates and closes tabs, and returns to the tool list', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(panel().hasAttribute('inert')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Add tool' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
  expect(screen.getByLabelText('Terminal input').getAttribute('data-cwd')).toBe('/repo');
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  expect(screen.getByRole('menuitem', { name: 'Side chat' }).getAttribute('aria-disabled')).toBe('true');
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
  await user.click(screen.getByRole('button', { name: 'Close Terminal' }));
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.getByRole('menu', { name: 'Add a tool' })).toBeTruthy();
});

test('hiding the panel keeps its tabs', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Close panel' }));
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
});

test('fixes the default width on first open and resizes by keyboard', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().style.width).toBe('320px');
  screen.getByRole('separator', { name: 'Resize right panel' }).focus();
  await user.keyboard('{ArrowLeft}');
  expect(panel().style.width).toBe('336px');
});

test('splits beside content right of the left inset and reserves header space', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.inset ? box(300, 1300) : box(0, 1600);
  });
  const user = userEvent.setup();
  render(<Harness withInset />);
  const content = screen.getByText('Content').parentElement as HTMLElement;
  const gap = document.querySelector('[data-slot="right-panel-gap"]') as HTMLElement;
  expect(content.style.getPropertyValue('--app-bar-reserve')).toBe('184px');
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().style.width).toBe('520px');
  expect(gap.style.width).toBe('520px');
  expect(content.style.getPropertyValue('--app-bar-reserve')).toBe('136px');
});

test('Ctrl+` opens and creates, focuses from elsewhere, and closes from inside a terminal', async () => {
  render(<Harness />);
  expect(pressToggle(document.body)).toBe(false);
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  const input = screen.getByLabelText('Terminal input');
  expect(input.getAttribute('data-focus-token')).toBe('1');

  const elsewhere = screen.getByRole('button', { name: 'Close panel' });
  elsewhere.focus();
  pressToggle(elsewhere);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(input.getAttribute('data-focus-token')).toBe('2');

  input.focus();
  expect(pressToggle(input)).toBe(false);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByRole('button', { name: 'Open panel' })).toBeTruthy();
});

test('ignores other modifier combinations', () => {
  render(<Harness />);
  fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(document.body, { key: '`', code: 'Backquote' });
  expect(panel().getAttribute('aria-hidden')).toBe('true');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/components/right-workspace.test.tsx`
Expected: FAIL — among others, `aria-hidden` is `"false"` in the first assertion because the current component ties it to `active`, and there is no `right-panel-gap` element.

- [ ] **Step 3: Rewrite the component**

Replace `src/components/right-workspace.tsx` with:

```tsx
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Plus } from 'lucide-react';
import { ToolList, ToolMenuItems } from '@/components/right-panel/tool-entries';
import { TerminalTabs, type TerminalTab } from '@/components/right-panel/terminal-tabs';
import { TerminalView } from '@/components/terminal-view';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PANEL_MIN_WIDTH, clampPanelWidth, defaultPanelWidth, panelLayout } from '@/renderer/right-panel-layout';

// An element's width and left edge, kept current. Falls back to window
// resizes where ResizeObserver is missing.
function useBox(ref: RefObject<HTMLElement | null> | undefined) {
  const [box, setBox] = useState({ width: 0, left: 0 });
  useEffect(() => {
    const element = ref?.current;
    if (!element) { setBox({ width: 0, left: 0 }); return; }
    const measure = () => {
      const { width, left } = element.getBoundingClientRect();
      setBox((previous) => (previous.width === width && previous.left === left ? previous : { width, left }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

/**
 * The right panel, rendered once around every mode. It measures itself and
 * the active mode's content inset here rather than in App, so a left-sidebar
 * animation re-renders only the panel: `children` arrives unchanged and React
 * skips it.
 */
export function RightWorkspace({ open, onOpenChange, width: chosenWidth, onWidthChange, onResizingChange, leftInsetRef, projectPath, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Controlled by App, which also places the mode toggle against it. Null
  // until the panel first opens.
  width: number | null;
  onWidthChange: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
  // The active mode's main content; its left edge is where the space beside
  // a left sidebar begins. Omitted in modes without one.
  leftInsetRef?: RefObject<HTMLElement | null>;
  projectPath: string | null;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const root = useBox(rootRef);
  const inset = useBox(leftInsetRef);
  const leftInset = leftInsetRef ? Math.max(0, inset.left - root.left) : 0;
  const width = chosenWidth ?? defaultPanelWidth(root.width, leftInset);
  const layout = panelLayout({ open, width, containerWidth: root.width, leftInset });

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextNumber = useRef(1);
  const nextFocus = useRef(1);
  const drag = useRef<{ x: number; width: number } | null>(null);

  // Fix the width the first time the panel opens, so later changes to the
  // left sidebar or the mode don't move it. A layout effect, so App places
  // the mode toggle before the first open paints.
  useLayoutEffect(() => {
    if (open && chosenWidth === null) onWidthChange(width);
  }, [open, chosenWidth, width, onWidthChange]);

  const focusTerminal = (id: string) => setFocusRequest({ id, token: nextFocus.current++ });
  const addTerminal = () => {
    const id = crypto.randomUUID();
    const number = nextNumber.current++;
    setTabs((previous) => [...previous, { id, cwd: projectPath, number }]);
    setSelectedId(id);
    focusTerminal(id);
  };
  const updateTab = (id: string, patch: Partial<TerminalTab>) => {
    setTabs((previous) => previous.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  };
  const closeTab = (id: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === id);
      const next = previous.filter((tab) => tab.id !== id);
      if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
      return next;
    });
  };
  const resize = (next: number) => onWidthChange(Math.min(layout.maxWidth, clampPanelWidth(next)));
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onResizingChange(false);
  };

  // Ctrl+` — VS Code's terminal toggle. Read through a ref so the listener,
  // registered once, always sees the latest tabs and open state.
  const toggleTerminal = useRef<() => void>(() => undefined);
  toggleTerminal.current = () => {
    const focused = document.activeElement;
    const focusInTerminal = focused instanceof Element
      && focused.closest('[data-slot="terminal"]') !== null
      && panelRef.current?.contains(focused) === true;
    if (open && focusInTerminal) { onOpenChange(false); return; }
    if (!open) onOpenChange(true);
    const selected = tabs.find((tab) => tab.id === selectedId);
    if (selected) focusTerminal(selected.id);
    else addTerminal();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Backquote' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      toggleTerminal.current();
    };
    // Capture phase, so a focused terminal never receives the keystroke.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={rootRef}>
      {/*
        Content headers read --app-bar-reserve to keep their titles clear of
        the mode and panel toggles, which float over the header row.
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ '--app-bar-reserve': `${layout.headerReserve}px` } as CSSProperties}>
        {children}
      </div>
      {/*
        The panel keeps its full width and slides; this in-flow gap is what
        narrows the content beside it, like the left sidebar's gap. Motion
        for both lives in index.css.
      */}
      <div aria-hidden className="shrink-0" data-slot="right-panel-gap" style={{ width: layout.split ? width : 0 }} />
      <aside
        aria-hidden={!open}
        aria-label="Right workspace"
        className="absolute inset-y-0 right-0 z-20 p-2"
        data-open={open || undefined}
        data-slot="right-panel"
        inert={!open}
        ref={panelRef}
        role="complementary"
        style={{ width, transform: open ? undefined : 'translateX(100%)', visibility: open ? 'visible' : 'hidden' }}
      >
        <TooltipProvider delayDuration={500}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm">
            {/*
              The tab row sits on the app bar's centerline, level with the
              mode toggle, the panel toggle, and Execute's title: the band's
              centre is --app-bar-offset + --app-bar-height / 2 below this
              panel's top, less the aside's 8px inset, plus half the 32px row
              because the row is bottom-aligned. pr-10 clears the panel
              toggle, which App floats over this corner.
            */}
            <div className="flex shrink-0 items-end gap-1 pr-10 pl-2" style={{ height: 'calc(var(--app-bar-offset) + var(--app-bar-height) / 2 + 8px)' }}>
              <TerminalTabs onClose={closeTab} onSelect={setSelectedId} selectedId={selectedId} tabs={tabs} />
              {tabs.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="Add tool" className="size-8 shrink-0" size="icon" variant="ghost"><Plus aria-hidden className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56"><ToolMenuItems onTerminal={addTerminal} /></DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {tabs.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <ToolList onTerminal={addTerminal} />
              </div>
            ) : (
              <div className="mx-2 mt-1 mb-2 min-h-0 flex-1 overflow-hidden rounded-md border border-sidebar-border">
                {tabs.map((tab) => (
                  <div aria-labelledby={tab.id} className="h-full" hidden={selectedId !== tab.id} id={`terminal-panel-${tab.id}`} key={tab.id} role="tabpanel">
                    <TerminalView
                      cwd={tab.cwd}
                      focusToken={focusRequest?.id === tab.id ? focusRequest.token : 0}
                      id={tab.id}
                      onExitedChange={(exited) => updateTab(tab.id, { exited })}
                      onShellReady={({ shell, cwd }) => updateTab(tab.id, { shell: shell.split(/[\\/]/).pop() || undefined, startedIn: cwd })}
                      visible={open && selectedId === tab.id}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </TooltipProvider>
        <div
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemax={Math.round(layout.maxWidth)}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuenow={Math.round(width)}
          className="absolute inset-y-2 left-0 z-30 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 hover:after:bg-sidebar-border focus-visible:after:bg-ring data-[dragging=true]:after:bg-sidebar-border"
          data-dragging={dragging}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); resize(width + 16); }
            if (event.key === 'ArrowRight') { event.preventDefault(); resize(width - 16); }
          }}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = { x: event.clientX, width };
            setDragging(true);
            onResizingChange(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }}
          onPointerUp={endDrag}
          role="separator"
          tabIndex={0}
        />
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/components/right-workspace.test.tsx`
Expected: PASS, 6 tests. If the split test sees `320px`, the inset box is being read before the ref attaches — confirm the harness child carries both `data-inset` and `ref`.

- [ ] **Step 5: Typecheck this file's consumers**

Run: `pnpm exec tsc --noEmit`
Expected: errors only in `src/components/execute-mode.tsx` (it still passes `active` and lacks the new props). Task 6 fixes them; no other errors.

- [ ] **Step 6: Commit (only under subagent-driven-development or on the user's request)**

```bash
git add src/components/right-workspace.tsx src/components/right-workspace.test.tsx
git commit -m "feat(right-panel): make the panel an app-level container"
```

---

### Task 6: Wire the panel into App and Execute

**Files:**
- Modify: `src/components/execute-mode.tsx` (imports; props; remove `rightOpen` and the `RightWorkspace` wrapper; `SidebarInset`; header)
- Modify: `src/App.tsx` (state; root attribute; corner strip; content wrapper)
- Modify: `src/index.css` (after the `[data-sidebar-resizing]` rules)
- Test: `src/components/execute-mode.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1's `modeToggleShift`; Task 5's `RightWorkspace` props and DOM contract.
- Produces: `ExecuteMode` gains `insetRef?: Ref<HTMLElement>` and `onProjectPathChange?: (path: string | null) => void`. Its header carries `data-slot="app-bar-reserve"` and `padding-right: var(--app-bar-reserve, 1rem)`.

- [ ] **Step 1: Write the failing tests**

In `src/components/execute-mode.test.tsx`, in the first test, render with a spy and assert it after the selection:

```tsx
  const onProjectPathChange = vi.fn();
  render(<ExecuteMode onOpenSettings={() => undefined} onProjectPathChange={onProjectPathChange} />);
  expect(onProjectPathChange).toHaveBeenLastCalledWith(null);
```

and after the existing `await waitFor(() => expect(api.open)...)` line:

```tsx
  expect(onProjectPathChange).toHaveBeenLastCalledWith('/work/fractal');
```

In `src/App.test.tsx`, replace the `TerminalView` mock so terminals expose their directory:

```tsx
vi.mock('@/components/terminal-view', () => ({ TerminalView: ({ cwd }: { cwd: string | null }) => <div data-cwd={cwd ?? ''} data-testid="terminal" /> }));
```

Move the `list`/`open`/`api` construction and the `window.fractal` definition from the existing test into a helper at module scope, so both tests share it:

```tsx
function installApi() {
  const list = vi.fn<ConversationApi['list']>(async () => ({ projects: [{ projectPath: ref.projectPath, displayName: 'Fractal', conversations: [{ ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }] }], providers: [] }));
  const open = vi.fn<ConversationApi['open']>(async () => ({ summary: { ref, title: 'Existing chat', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities }));
  const api: ConversationApi = {
    list, open, close: async () => undefined, create: async () => null, continue: async () => undefined,
    interrupt: async () => undefined, resolveRequest: async () => undefined, onEvent: () => () => undefined,
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api, settings: { get: async () => ({ theme: 'system', defaultCodingAgent: 'claude', sidebarOrder: emptyOrder }) } } });
  return { list, open };
}
```

and start the existing test with `const { list, open } = installApi();`. Append:

```tsx
test('keeps one right panel across modes and slides the mode toggle to its edge', async () => {
  installApi();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Fractal' }));
  await user.click(screen.getByRole('button', { name: /Existing chat, Codex conversation/ }));
  const shift = document.querySelector('[data-slot="mode-toggle-shift"]') as HTMLElement;
  expect(shift.style.transform).toBe('translateX(0px)');

  await user.click(screen.getByRole('button', { name: 'Open right panel' }));
  expect(shift.style.transform).toBe('translateX(-272px)');
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getByTestId('terminal').getAttribute('data-cwd')).toBe('/work/fractal');

  await user.click(screen.getByRole('radio', { name: 'Map' }));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(shift.style.transform).toBe('translateX(-272px)');
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByTestId('terminal').map((terminal) => terminal.getAttribute('data-cwd'))).toEqual(['/work/fractal', '/work/fractal']);

  await user.click(screen.getByRole('button', { name: 'Close right panel' }));
  expect(shift.style.transform).toBe('translateX(0px)');
  expect(screen.getByRole('button', { name: 'Open right panel' })).toBeTruthy();
});
```

The `-272px` is jsdom's zero-width layout: the default clamps to 320, less `CLOSED_MODE_TOGGLE_RIGHT` (48).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/components/execute-mode.test.tsx src/App.test.tsx`
Expected: FAIL — `onProjectPathChange` is never called, and there is no `mode-toggle-shift` element.

- [ ] **Step 3: Update Execute**

In `src/components/execute-mode.tsx`:

- Change the React import to `import { useEffect, useState, type CSSProperties, type Ref } from 'react';` and delete the `RightWorkspace` import.
- Add to the destructured props `insetRef,` and `onProjectPathChange,` and to the props type:

```tsx
  // Attached to the content beside the left sidebar, so the app-level right
  // panel can tell where the space beside that sidebar begins.
  insetRef?: Ref<HTMLElement>;
  // The selected conversation's project, where new terminals start.
  onProjectPathChange?: (path: string | null) => void;
```

- Delete `const [rightOpen, setRightOpen] = useState(false);`.
- After the `selectedRuntime` line, add:

```tsx
  useEffect(() => {
    onProjectPathChange?.(selectedRef?.projectPath ?? null);
  }, [selectedRef?.projectPath, onProjectPathChange]);
```

- Change `<SidebarInset className="min-h-0 overflow-hidden">` to `<SidebarInset className="min-h-0 overflow-hidden" ref={insetRef}>`, and delete the `<RightWorkspace ...>` opening line and its closing `</RightWorkspace>` so the header and content div are direct children of `SidebarInset` again.
- Replace the comment above `<header` and the header's opening tag with:

```tsx
        {/*
          The row's height comes from `--app-bar-height`, the same token App's
          corner strip uses, so the mode and panel toggles float over this
          row's right-hand side already on its baseline. `--app-bar-reserve`,
          set by the right panel, is how much of that side they cover; the
          title ellipsizes before it. index.css animates the padding on the
          toggles' curve so the two never meet mid-slide.
        */}
        <header
          className="flex shrink-0 items-center gap-2 pl-4"
          data-slot="app-bar-reserve"
          style={{
            height: 'var(--app-bar-height)',
            marginTop: 'var(--app-bar-offset)',
            paddingRight: 'var(--app-bar-reserve, 1rem)',
          }}
        >
```

- [ ] **Step 4: Update App**

In `src/App.tsx`:

- Change the React import to `import { useEffect, useRef, useState } from 'react';` and add:

```tsx
import { PanelRight } from 'lucide-react';
import { RightWorkspace } from '@/components/right-workspace';
import { Button } from '@/components/ui/button';
import { modeToggleShift } from '@/renderer/right-panel-layout';
```

- After the `settingsOpen` state, add:

```tsx
  // The right panel is app-level: one instance beside every mode, so its
  // tabs and shells survive mode changes. Width is null until first open.
  const [rightOpen, setRightOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  const [rightResizing, setRightResizing] = useState(false);
  // Execute's selected project; new terminals start there in any mode.
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const executeInsetRef = useRef<HTMLElement>(null);
```

- Change the root to `<div className="h-screen overflow-hidden bg-background text-foreground" data-right-panel-resizing={rightResizing || undefined}>`.
- Replace the whole mode-toggle strip block (its comment and `<div>`) with:

```tsx
      {/*
        The corner strip: the mode toggle, then the right-panel toggle in the
        far-right corner. Rendered once, outside the mode branch, and never
        moved in the tree — the toggle's sliding pill animates a transform and
        needs to survive a mode change to have something to animate from.

        The strip matches execute's header row: same height, same
        `items-center`, riding the same offset below the title bar, so both
        toggles sit on that row's baseline. It ignores pointer events so it
        doesn't swallow clicks across the full width; only the controls take
        them back.

        The corner inset is (--app-bar-height − 2rem) / 2, the 2rem being the
        panel toggle's own size, so that toggle is as far from the window edge
        as from the band's top and bottom. That inset, the 4px `gap-1`, and
        the 32px toggle are what CLOSED_MODE_TOGGLE_RIGHT in
        right-panel-layout.ts adds up; change them together.

        While the panel is open, the mode toggle is translated left to sit just
        outside the panel's edge. A transform rather than a layout move, so it
        never remounts; index.css animates it on the panel's curve.
      */}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex items-center justify-end gap-1"
        style={{
          top: 'calc(var(--titlebar-height) + var(--app-bar-offset))',
          height: 'var(--app-bar-height)',
          paddingRight: 'calc((var(--app-bar-height) - 2rem) / 2)',
        }}
      >
        <div
          className="pointer-events-auto"
          data-slot="mode-toggle-shift"
          style={{ transform: `translateX(${-modeToggleShift(rightOpen, rightWidth ?? 0)}px)` }}
        >
          <ModeToggle value={mode} onValueChange={setMode} />
        </div>
        <Button
          aria-expanded={rightOpen}
          aria-label={rightOpen ? 'Close right panel' : 'Open right panel'}
          className="pointer-events-auto size-8"
          onClick={() => setRightOpen((open) => !open)}
          size="icon"
          variant="ghost"
        >
          <PanelRight aria-hidden className="size-4" />
        </Button>
      </div>
```

- Replace the content wrapper's children (the `ExecuteMode` element and the `mode !== 'execute'` line) with:

```tsx
        <RightWorkspace
          leftInsetRef={mode === 'execute' ? executeInsetRef : undefined}
          onOpenChange={setRightOpen}
          onResizingChange={setRightResizing}
          onWidthChange={setRightWidth}
          open={rightOpen}
          projectPath={projectPath}
          width={rightWidth}
        >
          <ExecuteMode
            active={mode === 'execute'}
            insetRef={executeInsetRef}
            onProjectPathChange={setProjectPath}
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
            sidebarWidth={sidebarWidth}
            onSidebarWidthChange={setSidebarWidth}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {mode !== 'execute' && <main className="flex flex-1 items-center justify-center" />}
        </RightWorkspace>
```

- [ ] **Step 5: Add the motion rules**

In `src/index.css`, after the `[data-sidebar-resizing], [data-sidebar-resizing] *` rule, add:

```css
/*
 * Right panel motion, matched to the left sidebar's 200ms linear
 * expand/collapse (ui/sidebar.tsx). The panel keeps its width and slides;
 * the gap beside it widens so the content narrows in step; the mode toggle
 * and the header's reserved space move on the same curve, so a truncated
 * title never meets the toggle mid-slide.
 *
 * Closing holds `visibility` until the slide ends. Opening shows the panel
 * at once, so a terminal can take focus in the same frame.
 */
[data-slot='right-panel'] {
  transition: transform 200ms linear, visibility 0s linear 200ms;
}
[data-slot='right-panel'][data-open] {
  transition: transform 200ms linear;
}
[data-slot='right-panel-gap'] {
  transition: width 200ms linear;
}
[data-slot='mode-toggle-shift'] {
  transition: transform 200ms linear;
}
[data-slot='app-bar-reserve'] {
  transition: padding-right 200ms linear;
}

/* A resize drag tracks the pointer 1:1, as the left sidebar's does. */
[data-right-panel-resizing] [data-slot='right-panel-gap'],
[data-right-panel-resizing] [data-slot='mode-toggle-shift'],
[data-right-panel-resizing] [data-slot='app-bar-reserve'] {
  transition: none;
}
[data-right-panel-resizing],
[data-right-panel-resizing] * {
  user-select: none;
  cursor: col-resize;
}

@media (prefers-reduced-motion: reduce) {
  [data-slot='right-panel'],
  [data-slot='right-panel'][data-open],
  [data-slot='right-panel-gap'],
  [data-slot='mode-toggle-shift'],
  [data-slot='app-bar-reserve'] {
    transition: none;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run src/components/execute-mode.test.tsx src/App.test.tsx`
Expected: PASS, 3 and 2 tests.

- [ ] **Step 7: Full check**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: all test files pass — 52 files and 444 tests (the baseline before this plan was 49 files and 429 tests; this plan adds 3 test files and a net 15 tests) — lint reports no errors, and tsc prints nothing.

- [ ] **Step 8: Commit (only under subagent-driven-development or on the user's request)**

```bash
git add src/App.tsx src/App.test.tsx src/components/execute-mode.tsx src/components/execute-mode.test.tsx src/index.css
git commit -m "feat(right-panel): share the panel across modes and slide the mode toggle"
```

---

### Task 7: Drive the running app

**Files:** none changed unless a check fails; a failure goes back to the task that owns the behaviour.

- [ ] **Step 1: Launch**

Use the `run` skill to start the app with `pnpm start` and drive its window.

- [ ] **Step 2: Walk the flows and record what you observe**

1. With the panel closed, in each of Execute, Map, and Explain: the panel toggle is in the far-right corner and the mode toggle sits immediately left of it.
2. Open the panel from Execute with a conversation selected: the conversation narrows while the panel slides in from the right, the mode toggle slides to just outside the panel's left edge, and the panel toggle does not move. The empty state lists Review, Terminal, Browser, Files, and Side chat; only Terminal responds to hover.
3. Choose Terminal: a `zsh` (or your shell's) tab appears with the terminal focused and a prompt in the selected project's directory (`pwd`). Hover the tab: the tooltip shows that directory.
4. Switch to Map and back: the panel stays open, the tab and its scrollback are unchanged, and neither toggle moves.
5. `Ctrl+``: with focus in the terminal, the panel closes; pressed again, it reopens with the terminal focused; with focus on the mode toggle, it focuses the terminal without closing. Type `` ` `` alone in the terminal: it reaches the shell.
6. Add a second terminal with `+` and close it with a middle-click. Run `exit` in the first: its tab shows the muted dot; Restart clears it.
7. Drag the resize edge: the line shows while hovering and dragging, the mode toggle stays attached to the edge with no lag, and the width stops where the conversation would drop below 420px.
8. Select a conversation with a long title: it ends in an ellipsis before the mode toggle, both with the panel closed and open, including mid-slide.
9. Narrow the window until the panel overlays the conversation: the panel keeps its inset and the mode toggle still sits at its edge.
10. Collapse and expand the left sidebar with the panel open: the panel's width does not change.

- [ ] **Step 3: Package check**

Run: `pnpm package`
Expected: completes and writes the unpacked app under `out/`. Open it and repeat flow 3 once to confirm the terminal still starts in the packaged build.

- [ ] **Step 4: Report**

Report what each flow showed, any flow that could not be exercised and why, and hand the user only the judgement of how the panel and toggle motion feels.
