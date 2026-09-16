# fractal

A desktop client for coding agents... for now.

It exists so developers can ride along with an agent instead of waking up to a codebase they no longer recognise — the problem being **cognitive debt**: when the agent writes everything, you stop building a mental model of your own system, and the cost only shows up later, when you need that model and don't have it.

Three modes carry that:

| Mode | Does |
|---|---|
| **Execute** | Run the agent. The normal thing. |
| **Map** | Conversation management on a spatial canvas — branch, organise, and navigate threads instead of scrolling one long transcript. |
| **Explain** | AI-assisted diagramming, Eraser.io-style. Prompt-driven, but grounded in the repo: the agent reads the actual files and the diagram carries its own provenance — what was read, what was skipped, what it was unsure about. A diagram that quietly omits a call path is worse than no diagram, so it says what it looked at. |

Explain mode is where the cognitive-debt claim actually lives. Map mode is good chat ergonomics and doesn't pretend to be more.

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

Execute mode uses the Codex and Claude Code harnesses already installed and authenticated on your machine. Install and sign in with each provider's native CLI before starting Fractal; Fractal does not provide provider login or handle provider credentials.

Codex and Claude Code remain the authority for conversation history. Fractal discovers their native sessions and writes continuations through the corresponding harness instead of maintaining a parallel transcript. Continuation is disabled whenever a session is active in another process or Fractal cannot prove that it is idle.

Not yet supported: full-text transcript search, attachments, forks, deletion, archival, and Claude mid-turn steering. See [the opt-in interoperability guide](docs/testing/native-conversation-interoperability.md) for credential-safe manual verification.

## Scripts

| Command | Does |
|---|---|
| `pnpm start` | Dev mode with hot reload. Type `rs` in the terminal to restart the main process. |
| `pnpm package` | Build an unpacked app into `out/`. |
| `pnpm make` | Build distributables into `out/make/`. |
| `pnpm lint` | ESLint over `.ts`, `.tsx`, `.mts`. |
| `pnpm exec tsc --noEmit` | Typecheck. Vite does the emit; `tsc` only checks. |

Building the RPM target needs `rpmbuild` on `PATH` (`sudo apt install rpm`). To skip it: `pnpm exec electron-forge make --targets @electron-forge/maker-deb`.

See [docs/environment-notes.md](docs/environment-notes.md) for the one-time Linux sandbox fix and the reasoning behind the version pins.
