# Right sidebar and terminal design

## Intent

Give Fractal a secondary workspace beside the main content in every mode, following the supplied Codex screenshots while retaining Fractal's own floating sidebar treatment. The panel starts closed. Its first working tool is an interactive terminal; Review, Browser, Files, and Side chat are shown as upcoming entries that cannot be opened yet.

## One panel across modes

There is a single right panel, rendered once at the app level and never unmounted. It sits beside whichever mode is active — Execute, Map, or Explain — and its open state, width, tabs, and running terminals are the same in all three. Changing modes neither closes the panel nor recreates its terminals; a terminal view is never remounted just because the mode changed, so its scrollback survives.

Because the panel wraps all modes, its open state and width live in `App` alongside the left sidebar's state, rather than inside Execute. The selected conversation's project path, which new terminals use as their working directory, is likewise made available at the app level; Execute stays mounted while inactive, so its last selection remains the source in Map and Explain.

## Panel surface and layout

The panel's outer 8px inset, sidebar background, rounded corners, border, and subtle shadow match the existing left sidebar. Its top edge sits at the same inset below the title bar in every mode.

When the panel first opens, its width is set to 40% of the space to the right of the left sidebar (the full content width when the left sidebar is not present), clamped between 320px and 720px. From then on the width changes only by resizing, and it is the same in every mode; toggling the left sidebar or changing modes does not recompute it. A drag handle on its left edge changes its width; a keyboard-operable separator changes width in 16px steps. The handle shows a thin line on hover, on keyboard focus, and while dragging, and is otherwise invisible.

The main content beside the panel must keep at least 420px. In Execute, that 420px is measured after the left sidebar's current width; in Map and Explain, which have no left sidebar, it is measured against the full content area. When the available width cannot fit both the minimum panel and the minimum content width, the panel overlays the content while retaining its floating outer inset. Resizing in split layout cannot reduce the content below its minimum.

## Header, panel toggle, and mode toggle

The app bar's right-hand corner holds two controls, rendered once at the app level in the same fixed strip as today: the mode toggle, and to its right the panel toggle. The panel toggle is present in every mode and always occupies the far-right corner, inset from the window edge exactly as the mode toggle is today. Its screen position does not change when the panel opens or closes: closed, it ends the app bar; open, it sits in the top-right corner of the panel's header.

When the panel is closed, the mode toggle sits immediately left of the panel toggle. When the panel is open, the mode toggle moves left so that it sits just outside the panel's left edge, at the right end of the content area's header row, and it follows that edge while the panel is resized. Because the panel persists across modes, switching modes never moves the mode toggle.

Content-area headers reserve space on their right for whichever controls occupy the header row: the mode toggle and panel toggle when the panel is closed, the mode toggle alone when it is open. Execute's conversation title truncates with an ellipsis at that reserved space rather than running under the controls, and the reserved space tracks the toggle's move so the title never overlaps it mid-animation.

## Motion

Opening and closing the panel use the left sidebar's expand/collapse motion: a 200ms linear transition. In split layout, the content area's width shrinks or grows over that transition while the panel slides in from or out to the right edge; in overlay layout, the panel slides without the content changing width. The mode toggle's move uses the same duration and easing, so it stays attached to the panel's edge throughout. Drag-resizing updates the panel width, content width, and toggle position directly with no easing. With reduced motion requested, open and close are immediate.

While the panel is animating, visible terminals do not refit or resize their PTY on every frame, so shells are not sent a burst of size changes. The panel keeps its full width while it slides and only the content area's width animates, so a terminal's size is already final when the panel starts to open and it fits once.

The panel's header carries the tab row on the same horizontal centerline as the app bar, so the tabs, the mode toggle, the panel toggle, and Execute's conversation title share one line. The header has no bottom border and no reserved space for the mode toggle; the tab row runs from the panel's left padding to the panel toggle. The tool content begins directly beneath the tab row on its own inset surface, which marks the end of the header.

## Tabs

Each tab shows a terminal icon and a short label. The label is the shell's name once known (`zsh`), followed by the tab's creation number when that number is greater than one (`zsh 2`); before the shell is known it reads `Terminal`. Hovering a tab shows its working directory as a tooltip. The active tab has a raised surface with a hairline border; inactive tabs are muted text without a surface. The close button is visible on the active tab and on a hovered or focused tab. Middle-clicking a tab closes it. A tab whose shell has exited shows a small muted dot until it is restarted or closed. The `+` button follows the last tab and opens a menu of the same tool entries as the empty state. Tabs scroll horizontally when they overflow.

Choosing Terminal creates and activates a new closable tab. Multiple terminal tabs can coexist. Closing the last tab returns to the empty state without closing the panel. Hiding the panel or changing modes preserves tabs and running processes.

## Empty state and tool entries

When open with no tabs, the panel shows a vertical list of tool entries, centred in the panel, as in the supplied screenshot. The entries, in order, are Review, Terminal, Browser, Files, and Side chat. Each is a full-width rounded row with an icon, a label, and a right-aligned hint on a subtle surface. Terminal is available and its hint is its shortcut, `Ctrl+``. The other four are unavailable: their hint reads `Soon`, their labels use the secondary text colour rather than reduced opacity, they do not respond to hover, and they are announced as disabled. The `+` menu uses the same entries, hints, and states.

## Keyboard

`Ctrl+`` toggles the terminal in any mode, matched on the physical key so it survives keyboard layouts:

- If the panel is closed, it opens the panel and focuses the active terminal tab, creating one if there are no tabs.
- If the panel is open and focus is inside a terminal, it closes the panel.
- If the panel is open and focus is elsewhere, it focuses the active terminal tab, creating one if there are no tabs.

When a non-terminal tab is active (once other tools exist), "the active terminal tab" is the most recently active terminal. The shortcut is intercepted before a focused terminal receives the keystroke, so the shell never sees it.

## Terminal behavior

Each tab is a real interactive terminal. The renderer uses xterm.js and its fit addon for display, input, selection, and resize measurements. Electron's main process owns a pseudoterminal and shell process for each tab through node-pty. Shell selection follows the platform's user shell (`SHELL` on Unix, `ComSpec` on Windows) with a platform default if unset. Creating a terminal uses the project path of the conversation selected in Execute at that moment, whichever mode is active. If no conversation is selected, it uses the app process's working directory. Selecting a different conversation does not change the working directory of existing terminals; newly created tabs use the newly selected project.

The terminal remains alive when hidden or while another mode is active. Fitting and PTY resizing occur when the panel or tab becomes visible and when its dimensions change. Closing a terminal tab terminates its process. Renderer navigation, window destruction, and app shutdown also terminate owned terminal processes. A shell that exits on its own leaves an exit message and a Restart action in its tab; restarting creates a fresh process in that tab's original working directory. A failed start shows a concise error and retry action without leaking native exception details.

## Process boundary

The preload exposes a typed terminal API with create, write, resize, close, and event subscription operations. The renderer never receives Node APIs or a direct process handle. The main process validates request shapes, accepts calls only from the app window's main frame, validates that the requested working directory is an existing absolute directory, and associates each terminal ID with its owning WebContents. Data and exit events go only to that owner. Input is sent as PTY data, never interpolated into a shell command. Process and listener cleanup is idempotent so close, exit, reload, and quit can race safely.

The main-process session manager, IPC adapter, shared contract, and renderer component are separate units. The existing conversation contract is only read to obtain the selected project path; terminal lifecycle does not depend on the conversation service. Keep `contextIsolation` enabled and `nodeIntegration` disabled.

## Visual language

Use Fractal's existing Geist typography and light/dark sidebar theme tokens. There is no new accent palette and no motion beyond that described under Motion. Focus indicators and labels remain visible to keyboard and assistive-technology users.

## Dependencies and packaging

Add xterm.js, its fit addon, and node-pty. The native module must be rebuilt for Electron and included in unpacked runtime resources as needed by Forge's packaging. Update pnpm's build-script allowlist only for the new dependency that actually requires it. Verify both development use and a locally packaged app; document any platform that cannot be exercised on the current host. Do not change the load-bearing Vite and plugin version pins described in `docs/environment-notes.md`.

## Verification

Add focused tests for panel open/close in each mode, preservation of tabs and terminals across mode changes, the empty state and `+` menu entries and their availability, tab labels, middle-click close, the exited indicator, each branch of the `Ctrl+`` shortcut, and the mode toggle's placement relative to the panel's open state and width. Test IPC argument validation, owner isolation, session create/write/resize/close, process exit, and cleanup using a fake PTY so tests do not launch a user's shell. Run the relevant tests, `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm package`.

Drive the running app to confirm the behavioral flows: opening the panel in each mode, switching modes with terminals running, `Ctrl+`` from each state including with focus inside a terminal, the mode toggle following a drag-resize, a long conversation title truncating before the toggles in both panel states, a terminal fitting once after the open transition, and the overlay layout at narrow window widths. Use a local packaged-app terminal smoke check for the native dependency. How the panel and toggle motion feels is left to human review.

## Out of scope

Review, Browser, Files, and Side chat functionality; an expand control that gives the panel the full width; separate panels or tab sets per mode; terminal session restoration after an app restart; persistence of right-panel width across app restarts; terminal commands or agent actions initiated automatically by Fractal.
