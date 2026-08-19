# Environment notes

Two things about this repo's toolchain that are deliberate rather than incidental. Both bite in non-obvious ways, which is why they live here instead of in someone's memory.

## One-time setup on Linux

The first `pnpm start` will abort with a message about `chrome-sandbox` not being owned by root. Electron's sandbox helper needs to be setuid-root, and an unprivileged `pnpm install` cannot create a root-owned setuid file — so the permission is dropped when the Electron binary is unpacked. Fix it once:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat this after anything that reinstalls Electron (deleting `node_modules`, bumping the Electron version, a fresh clone). This affects **development only** — the `.deb` and `.rpm` installers ship the helper with the correct ownership and mode already set, so end users never see it.

## Notes on version pins

A few versions are deliberate rather than incidental; changing them tends to break the build in non-obvious ways.

- **`@vitejs/plugin-react` is pinned to 4.x.** Version 6 requires Vite 8 and is ESM-only, which Vite 5 cannot load from a CommonJS config.
- **The renderer config is `.mts`, not `.ts`.** Tailwind v4's Vite plugin is ESM-only with no CommonJS build. The `.mts` extension makes Vite load the config as ESM. The main and preload configs stay `.ts`.
- **TypeScript is 5.9, not the template's 4.5.** React 19's types need a modern compiler.
- **`.npmrc` sets `node-linker=hoisted`.** Forge crawls `node_modules` on disk when packaging and does not follow pnpm's symlinks. Without this, `pnpm start` works while `pnpm package` quietly ships an app missing dependencies.
