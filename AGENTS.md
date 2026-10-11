# AGENTS.md

## What Fractal is

A desktop client for coding agents. Currently a UI wrapper around existing agents; it may grow into an agent itself.

The reason it exists is **cognitive debt** — when an agent writes the code, the developer stops building a mental model of their own system, and the cost surfaces later when that model is needed and missing. Fractal's job is to keep the model alive while the agent works. Judge features against that, not against "does this look like a chat app."

Three modes, three separate jobs:

- **Execute** — run the agent.
- **Map** — conversation management on a spatial canvas (branch, organise, navigate threads). Good ergonomics; it does *not* carry the cognitive-debt claim, and shouldn't be designed as if it does.
- **Explain** — AI-assisted diagramming, Eraser.io-style. Prompt-driven but grounded in the repo. This is where the thesis lives.

### Explain mode: the standing constraint

A diagram is a claim about the whole repo, but the agent only ever reads part of it. A missing edge and a nonexistent edge render identically, so a wrong diagram is worse than none — it looks authoritative and nothing on screen contradicts it.

So: **diagrams carry their own provenance.** Which files were read, which were skipped, what the agent was unsure about. Any work on explain mode that renders a graph without that trail is incomplete, not a first pass.

## Commands

```bash
pnpm start                # dev, hot reload; type `rs` to restart the main process
pnpm test                 # Vitest, single run; `pnpm test:watch` to watch
pnpm lint                 # ESLint over .ts, .tsx, .mts
pnpm exec tsc --noEmit    # typecheck — Vite emits, tsc only checks
pnpm package              # unpacked app into out/
pnpm make                 # distributables into out/make/
```

Run the tests, lint and the typecheck before calling work done. Tests sit next to the code as `*.test.ts` / `*.test.tsx` and run in Vitest's node environment (`vitest.config.ts`); `src/components/ai-elements/` is excluded from the run.

## Architecture

Electron 43 + Forge 7, Vite 5, React 19, TypeScript 5.9, Tailwind v4, shadcn/ui, Vitest. pnpm.

```
src/
  main.ts        Main process entry — creates the BrowserWindow and registers the IPC handlers
  preload.ts     contextBridge surface, exposed to the renderer as window.fractal
  renderer.tsx   Mounts React into #root
  App.tsx        Root component
  main/          Main-process services: agent harnesses (harness/claude, harness/codex), conversations, model choices, settings, terminals, files, attachments
  shared/        Contracts and IPC channel names and input parsers, used by both processes
  renderer/      Renderer state and hooks (conversation reducer, model choice, layout, shortcuts)
  components/    UI — app shell, title bar, conversation, right panel, ui/ (shadcn)
```

`contextIsolation` is on and `nodeIntegration` is off. The renderer reaches the main process only through `window.fractal`, which `preload.ts` exposes with `contextBridge` (conversations, models, settings, terminals, attachments, files). Each surface keeps its channel names and input parsers in `shared/` and its handlers in `main/`; the conversation, model, terminal and files handlers accept calls only from the app window's main frame, and new handlers should do the same. Add main-process capabilities that way rather than reaching for Node APIs in the renderer. Do not weaken either setting to make something work; the agent-driven filesystem access explain mode needs belongs behind a preload API, not in the renderer.

The window is frameless, and the app bar is the window frame: one `--app-bar-height` band across the top holds the sidebar toggle and breadcrumb from the far left (fixed in place, whatever the sidebar does), the right-panel toggle (shown only while a project is selected, since every panel tool works inside one), and the OS window controls (overlaid at its right end; `--window-controls-inset` is their width). The mode toggle floats below the bar, at the content area's top-right corner. `components/title-bar.tsx` makes the whole band a drag region behind its contents, so anything clickable placed in the band needs the `app-region-no-drag` utility or the drag region swallows its clicks.

## UI conventions

**Never show the OS default scrollbar, anywhere.** Every scrolling surface uses the thin, trackless thumb defined globally on `*::-webkit-scrollbar` in `src/index.css`. Don't add per-element scrollbar styling, and never set `scrollbar-width` or `scrollbar-color` on anything — Chromium drops the `::-webkit-scrollbar` rules on any element that sets either, which brings the default back.

**Tooltips use `components/ui/tooltip.tsx`, never a native `title` attribute.** Its styling is the app's one tooltip look (a rounded pill on our popover tokens, no arrow). Restyle it there rather than per call site, and don't use `title` for hover hints, since the OS draws those in its own style.

## Gotchas

Before touching the build config, read [docs/environment-notes.md](docs/environment-notes.md) — the version pins there are load-bearing and break in non-obvious ways. Most relevant: `vite.renderer.config.mts` is `.mts` deliberately (Tailwind v4's plugin is ESM-only), and `@vitejs/plugin-react` must stay on 4.x.
