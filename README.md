# fractal

An Electron desktop app built with React, TypeScript and Tailwind CSS, packaged by Electron Forge.

## Stack

| | |
|---|---|
| Shell | Electron 43 + Electron Forge 7 |
| Bundler | Vite 5 (`@electron-forge/plugin-vite`) |
| UI | React 19, TypeScript 5.9 |
| Styles | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Packages | pnpm |

## Getting started

```bash
pnpm install
pnpm start
```

### One-time setup on Linux

The first `pnpm start` will abort with a message about `chrome-sandbox` not being owned by root. Electron's sandbox helper needs to be setuid-root, and an unprivileged `pnpm install` cannot create a root-owned setuid file — so the permission is dropped when the Electron binary is unpacked. Fix it once:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat this after anything that reinstalls Electron (deleting `node_modules`, bumping the Electron version, a fresh clone). This affects **development only** — the `.deb` and `.rpm` installers ship the helper with the correct ownership and mode already set, so end users never see it.

## Scripts

| Command | Does |
|---|---|
| `pnpm start` | Dev mode with hot reload. Type `rs` in the terminal to restart the main process. |
| `pnpm package` | Build an unpacked app into `out/`. |
| `pnpm make` | Build distributables into `out/make/`. |
| `pnpm lint` | ESLint over `.ts`, `.tsx`, `.mts`. |
| `pnpm exec tsc --noEmit` | Typecheck. Vite does the emit; `tsc` only checks. |

Building the RPM target needs `rpmbuild` on `PATH` (`sudo apt install rpm`). To skip it: `pnpm exec electron-forge make --targets @electron-forge/maker-deb`.

## Layout

```
src/
  main.ts        Main process — creates the BrowserWindow
  preload.ts     contextBridge surface (currently empty)
  renderer.tsx   Mounts React into #root
  App.tsx        Root component
  index.css      @import 'tailwindcss'
forge.config.ts             Forge plugins, makers, fuses
vite.main.config.ts         Main process bundle
vite.preload.config.ts      Preload bundle
vite.renderer.config.mts    Renderer bundle — React + Tailwind plugins
```

`contextIsolation` is on and `nodeIntegration` is off. `preload.ts` is currently empty, so the renderer has no channel to the main process yet — expose one through `contextBridge` before reaching for Node APIs in the renderer.

## Notes on version pins

A few versions are deliberate rather than incidental; changing them tends to break the build in non-obvious ways.

- **`@vitejs/plugin-react` is pinned to 4.x.** Version 6 requires Vite 8 and is ESM-only, which Vite 5 cannot load from a CommonJS config.
- **The renderer config is `.mts`, not `.ts`.** Tailwind v4's Vite plugin is ESM-only with no CommonJS build. The `.mts` extension makes Vite load the config as ESM. The main and preload configs stay `.ts`.
- **TypeScript is 5.9, not the template's 4.5.** React 19's types need a modern compiler.
- **`.npmrc` sets `node-linker=hoisted`.** Forge crawls `node_modules` on disk when packaging and does not follow pnpm's symlinks. Without this, `pnpm start` works while `pnpm package` quietly ships an app missing dependencies.
