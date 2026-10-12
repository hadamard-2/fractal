# Known issues

Problems we know about but can't fix from Fractal's side yet. Each entry says what happens, why, and what would close it.

## Stopping a Codex conversation leaves its running command alive

**What happens.** Pressing Stop in a Codex conversation while a command is running interrupts the turn, but the command keeps running in the background until it finishes on its own.

**Why.** Fractal stops a Codex turn with `turn/interrupt`. Codex reports the turn as `interrupted` but does not terminate the command process it started. Observed with codex-cli 0.160.0 and 0.162.0-alpha.17.2 on Linux (2026-10-12): the command runs under `codex-linux-sandbox` in its own session, so it is not in the app-server's process group either. One app-server serves every Codex conversation, and Codex reports no OS process id per command, so Fractal cannot tell which process belongs to which conversation; ending the whole tree would kill other conversations' commands.

**What Fractal already covers.** Quitting Fractal, restarting the Codex server, the server exiting on its own, and Fractal crashing all end the server's commands (`CodexCommandReaper` in `src/main/harness/codex/codex-app-server.ts`, plus `src/main/process-watchdog.ts`). Only the per-conversation Stop is open.

**What would close it.** Codex terminating a turn's commands on `turn/interrupt` (to be reported upstream), or Codex exposing the OS process id of each command so Fractal can end just that one.
