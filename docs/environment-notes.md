# Environment notes

Three things about this repo's toolchain that are deliberate rather than incidental. All bite in non-obvious ways, which is why they live here instead of in someone's memory.

## One-time setup on Linux

The first `pnpm start` will abort with a message about `chrome-sandbox` not being owned by root. Electron's sandbox helper needs to be setuid-root, and an unprivileged `pnpm install` cannot create a root-owned setuid file — so the permission is dropped when the Electron binary is unpacked. Fix it once:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat this after anything that recreates `node_modules` — a version bump, a fresh clone, **or answering Yes to a pnpm purge prompt** (see the pnpm 11 section: settings drift makes pnpm offer exactly that purge). If `node_modules/electron/dist` is missing entirely after an install, Electron's postinstall didn't run; `pnpm rebuild electron` is a no-op when pnpm's side-effects cache believes the build already happened — run `node node_modules/electron/install.js` instead. This affects **development only** — the `.deb` and `.rpm` installers ship the helper with the correct ownership and mode already set, so end users never see it.

## Notes on version pins

A few versions are deliberate rather than incidental; changing them tends to break the build in non-obvious ways.

- **`@vitejs/plugin-react` is pinned to 4.x.** Version 6 requires Vite 8 and is ESM-only, which Vite 5 cannot load from a CommonJS config.
- **The renderer config is `.mts`, not `.ts`.** Tailwind v4's Vite plugin is ESM-only with no CommonJS build. The `.mts` extension makes Vite load the config as ESM. The main and preload configs stay `.ts`.
- **TypeScript is 5.9, not the template's 4.5.** React 19's types need a modern compiler.
- **The terminal's `node-pty` package must stay external to the main Vite bundle.** Its JavaScript loads a native `.node` file and a helper relative to the package directory; bundling the JavaScript into `.vite/build/main.js` leaves those files behind. `vite.main.config.ts` externalizes `node-pty`, and `forge.config.ts` copies `node-pty` plus its build-time `node-addon-api` dependency into the package and unpacks the PTY directory. A successful Vite build alone does not verify this boundary; run `pnpm package` and check a terminal from the packaged files.

## pnpm 11 reads its settings from pnpm-workspace.yaml only

pnpm 11 stopped reading the `pnpm` field in `package.json` **and** its own keys in `.npmrc`. Both silently stop working — no error, just a WARN at the top of the next run — and the failures surface far from the cause:

- `node-linker = hoisted` lived in `.npmrc`. With it ignored, pnpm installs the default isolated (symlinked) layout, and Forge's start check refuses: *"When using pnpm, `node-linker` must be set to 'hoisted'"*. The setting is now `nodeLinker: hoisted` in pnpm-workspace.yaml. Forge crawls `node_modules` on disk and does not follow pnpm's symlinks — without hoisting, `pnpm start` works while `pnpm package` quietly ships an app missing dependencies.
- `pnpm.onlyBuiltDependencies` (the dependency build-script allowlist: electron, electron-winstaller, esbuild, plus unrs-resolver) lived in `package.json`. With it ignored, dependency install scripts are blocked and pnpm scaffolds `allowBuilds` entries into pnpm-workspace.yaml set to the literal placeholder `set this to true or false` — they must be flipped to real booleans. Until then the install exits `ERR_PNPM_IGNORED_BUILDS` and **no** lifecycle scripts run, including Electron's binary download.

Any edit to these settings can make pnpm consider the modules directory stale, which triggers the remove-and-reinstall purge prompt on the next run. Answering Yes is fine (the store makes it fast), but it recreates Electron — so the chrome-sandbox fix above needs re-applying afterwards.
