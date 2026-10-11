# Access picker design

## Intent

Let the user see and choose how much each agent may do without asking, per conversation, from the composer. Claude Code and Codex model this differently (Claude: a permission mode that decides when to ask; Codex: an OS sandbox plus an approval policy), so the picker offers each agent's own levels, ordered from least to most autonomy, rather than a shared scale whose steps would mean different things per agent. The picker always shows what the next turn will run with.

Out of scope for this spec: switching level from an approval card ("Allow, and switch to…"), choosing a level when approving a plan, a per-action record of who approved what (user, mode, or reviewer), permission rule editing, and Codex network or permission-profile settings.

## What exists today

Fractal passes no permission setting to either agent. The Claude runner spawns `claude --session-id|--resume <id> --print … [--mcp-config … --permission-prompt-tool …] [--model …] [--effort …]` once per turn, so the mode comes from the user's Claude settings or Claude's built-in default. The Codex adapter sends `thread/start { cwd }`, then per turn `thread/resume` and `turn/start { threadId, input, model?, effort? }`, so the thread inherits `config.toml`. Approval prompts already reach the UI for both agents (Claude through `claude-permission-bridge.ts`, Codex through app-server requests). The composer footer is `[Attach] [Model · Effort] … [Stop] [Send]`.

## Findings the design rests on

Verified on 2026-10-07 against Claude Code 2.1.291 and codex-cli 0.160.0.

- **Claude flag values.** `claude --help` lists `--permission-mode` choices `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` is also accepted (it ran without error); an unknown value is rejected with a usage error.
- **Claude records the mode it ran in.** Each turn's `user` transcript record carries `permissionMode`. Passing `plan`, `acceptEdits`, `auto`, `bypassPermissions` records that value; passing `manual` or `default` records `default`. This works without an active Claude subscription (the session file is written before the API call fails), so the Claude side can be checked end to end without a plan.
- **Claude does not keep the mode across resume.** A session run with `--permission-mode plan` and then resumed without the flag recorded `auto` (Claude's default in that environment) for the second turn; resuming with `--permission-mode acceptEdits` recorded `acceptEdits`. So the mode must be passed on every turn.
- **Claude's built-in default varies.** With no flag, a logged-out `-p` run recorded `auto`; Claude's docs say `-p` sessions that fetch feature flags start in `default`. Fractal therefore never predicts Claude's default and shows what the transcript reports.
- **Codex per-turn overrides.** `TurnStartParams` accepts `approvalPolicy: AskForApproval`, `approvalsReviewer: ApprovalsReviewer` and `sandboxPolicy: SandboxPolicy`, each documented as overriding "this turn and subsequent turns". `ThreadResumeResponse` returns `approvalPolicy`, `approvalsReviewer` and `sandbox: SandboxPolicy`. Types are in `src/main/harness/codex/generated/v2`.
- **Codex shapes.** `AskForApproval = "untrusted" | "on-request" | { granular: … } | "never"`; `ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent"`; `SandboxPolicy = { type: "dangerFullAccess" } | { type: "readOnly", networkAccess: boolean } | { type: "externalSandbox", networkAccess: "restricted" | "enabled" } | { type: "workspaceWrite", writableRoots, networkAccess: boolean, excludeTmpdirEnvVar, excludeSlashTmp }`. These fields are unchanged in the stable bindings generated from codex-cli 0.160.0, although Fractal's checked-in bindings predate it.
- **Codex applies the overrides and keeps them.** Probed against an isolated `CODEX_HOME` (no login, so the turn itself failed): after `turn/start` with `sandboxPolicy`, `approvalPolicy` and `approvalsReviewer`, `thread/resume` reported the new values, and still did after restarting the app server. Codex stores them with the thread, so a level only needs sending when it changes.
- **The override replaces a permission profile.** On a thread whose config selected a custom profile (`default_permissions = "netprofile"`, extending `:workspace` with network enabled), the same override switched the thread to the plain sandbox policy, dropping the profile and its network access. The stable API cannot see profiles: `thread/resume` reports a profile thread only as its legacy projection (here `workspaceWrite` with `networkAccess: true`, which reads as Auto). Profile provenance (`activePermissionProfile`) and a profile-selecting `permissions` field on `turn/start` exist only behind the experimental API, which Fractal does not opt into.
- **Claude records a fallback, not the request.** With `--permission-mode auto` while Auto was unavailable (turned off through `--settings` `disableAutoMode`, or with `--model haiku`), the transcript recorded `default`. So comparing the recorded mode with the one sent detects a fallback.

Not verified:

- How a Codex combination forbidden by managed requirements fails on `turn/start` (no managed policy was available to test against).

Known limitation, accepted for v1: a Codex thread running a custom permission profile shows as the preset its legacy projection matches (or Custom), and picking any level on it replaces the profile, including its filesystem and network rules. Picking nothing leaves it untouched.

Known limitation, accepted for v1: `dangerFullAccess` carries no network setting, so going from Full access back to Read-only, Auto or Auto-review sets `networkAccess` to Codex's default (`false`), even if the thread had network on before Full access. Confirmed end to end on codex-cli 0.160.0.

Known limitation: a Claude conversation whose recorded mode cannot be passed back to the CLI (not letters only, or over 32 characters) reads back as no state, so the picker shows Claude's default, which is what the next turn runs with.

## Levels

One shared module, `src/shared/access-levels.ts`, lists each agent's levels in order of increasing autonomy, as `{ id, label, description, dangerous }`. How a level maps to an agent's controls, and how the agent's reported state maps back, lives with that agent's harness (`harness/claude/claude-access.ts`, `harness/codex/codex-access.ts`), since only the harness knows its agent's wire format.

### Claude Code

| id | Label | Sent as | Dangerous |
|---|---|---|---|
| `plan` | Plan | `--permission-mode plan` | |
| `default` | Ask | `--permission-mode default` | |
| `acceptEdits` | Accept edits | `--permission-mode acceptEdits` | |
| `auto` | Auto | `--permission-mode auto` | |
| `bypassPermissions` | Bypass | `--permission-mode bypassPermissions` | yes |

Reading back: the `permissionMode` of the last transcript record that carries one. A listed value maps to its level; any other value (for example `dontAsk`) is Custom with that raw value as its `mode`, which is passed back unchanged on the next turn.

### Codex

| id | Label | `sandboxPolicy.type` | `approvalPolicy` | `approvalsReviewer` | Dangerous |
|---|---|---|---|---|---|
| `read-only` | Read-only | `readOnly` | `on-request` | `user` | |
| `auto` | Auto | `workspaceWrite` | `on-request` | `user` | |
| `auto-review` | Auto-review | `workspaceWrite` | `on-request` | `auto_review` | |
| `full-access` | Full access | `dangerFullAccess` | `never` | `user` | yes |

Sending: all three fields on `turn/start`, only for a level the user picked. `sandboxPolicy` is built from the thread's current policy (the `thread/resume` response `continueConversation` already fetches), changing only `type`: `networkAccess` carries over from a `readOnly` or `workspaceWrite` policy, and from an `externalSandbox` one as `true` when it is `"enabled"`; `writableRoots`, `excludeTmpdirEnvVar` and `excludeSlashTmp` carry over from a `workspaceWrite` one. Coming from `dangerFullAccess`, which has none of these, they default to `networkAccess: false`, `writableRoots: []`, and both excludes `false`, matching Codex's defaults. Fractal never turns network access on or off itself.

Reading back: from `thread/resume`. A combination matching a row is that level; anything else is Custom with a label built from the parts (for example "read-only · never ask") and no `mode`. A Custom state whose sandbox is `dangerFullAccess` is marked `dangerous`, whatever its approval policy: with no sandbox, any command Codex runs unasked can do anything, so it is gated like Full access. A read-back state is never sent, whether it matches a level or not: Codex already keeps the thread's settings, and re-sending them would replace a permission profile the user never chose to change.

## Main process

### Shared types

In `conversation-contract.ts`:

```ts
type AccessState =
  | { kind: 'level'; level: string }                 // an id from accessLevels(provider)
  | { kind: 'custom'; label: string; mode?: string; dangerous?: boolean }; // mode: Claude's raw permission mode, sent back unchanged; dangerous: as open as the agent's dangerous level

interface AccessLevel { id: string; label: string; description: string; dangerous: boolean }

/** What a turn is sent with. picked: the user chose it in Fractal, rather than it being read back from history. */
interface TurnAccess { state: AccessState; picked: boolean }
```

`AgentPrompt` gains `access?: TurnAccess`. Each adapter decides what reaches its agent, because the two agents differ in whether a mode persists:

- Claude falls back to its default on resume, so it passes every state, picked or read back: the level id, or a custom `mode`, as `--permission-mode`. A custom state without `mode` sends nothing.
- Codex keeps a thread's settings, so it sends the three fields only for a picked level, and nothing for a read-back state.

### Adapters

`HarnessAdapter` gains an optional `readAccess(ref): Promise<AccessState | undefined>`.

- Claude reads the last `permissionMode` from the conversation's transcript, alongside the existing history reading.
- Codex reads `approvalPolicy`, `approvalsReviewer` and `sandbox` from `thread/resume`. `readLastRun` and `readAccess` share a private `resumeThread(ref)` that coalesces concurrent calls for the same thread into one request; it does not cache settled results. As with `readLastRun`, it does not unsubscribe.

### Choice store

`AccessChoiceStore` keeps `access-choices.json` in the app data folder as `{ conversations: Record<conversationKey, { state: AccessState; sent: boolean }> }`, holding only levels the user picked, written atomically through a temp file and rename. `sent` is false when a level is picked and true once a turn has been sent with it. An unreadable file or an invalid entry reads as absent and is replaced on the next write. There is no last-used entry: a new conversation passes nothing and runs with the agent's default.

### AccessChoices service

- `levels(provider)` returns that agent's level list.
- `resolve(ref)` returns `{ access, observed? }`. `access` is the saved pick (`picked: true`), else the state read back from history (`picked: false`; adopted, so continuing a Claude conversation keeps the mode it last ran in even though Claude would otherwise fall back on resume), else `null`, which means the agent's default and only occurs before a conversation's first turn. `observed` is the read-back state when a saved pick has been sent and the read-back differs from it, for example when Claude was asked for Auto and ran in Ask. An unsent pick never produces `observed`, since the history cannot have run with it yet.
- Read-back results are cached per conversation. The entry is dropped whenever the history may have changed: when a turn is sent in that conversation, and when its history finishes loading or gains a turn from anywhere (Fractal or the agent run elsewhere, such as the terminal). The conversation IPC drops it before passing those events to the renderer, so the renderer's next listing reads fresh. A read that one of these overtakes is used by its caller but not cached. Both agents record the new mode as soon as a turn starts (Claude writes the turn's `user` record, carrying `permissionMode`, before calling its API; Codex applies the override at `turn/start`), so the next read after a send sees it.
- `choose(ref, state)` saves a pick with `sent: false`. Only a level can be chosen; custom states come from read-back, never from the picker.
- `recordSend(ref, access)` saves a picked state a turn was sent with, with `sent: true`, so a pick still in flight when the user sends is not lost. Read-back states and `null` save nothing.

### Sending a turn

The renderer sends the resolved `TurnAccess` with each prompt, as it does the model choice. Main validates it whether picked or read back, since the renderer is untrusted and Claude passes read-back states to its CLI: a level must be a known level for that agent; a level that is dangerous, a custom state whose `mode` names a dangerous level, or a custom state marked `dangerous`, is rejected while that agent's `allowDangerousAccess` setting is off; a picked state must be a level. So a conversation last run in Bypass or Full access outside Fractal, or a Codex thread with no sandbox under any approval policy, fails to send with "Bypass is turned off in Settings" (or "Full access…") until the user turns the setting on or picks another level. It then calls `recordSend` and passes it to the adapter, which applies the rules above. A rejected state fails the send with an error rather than running the turn without it.

### IPC

`ACCESS_CHANNELS.list(ref)` returns `{ levels: AccessLevel[]; access: TurnAccess | null; observed?: AccessState; allowDangerous: boolean }`, where `allowDangerous` is that agent's `allowDangerousAccess` setting. `ACCESS_CHANNELS.choose(ref, state)` accepts only a level state, validates it as above, and saves. Both authorize the sender the same way `model-ipc.ts` does, and the preload exposes them as `window.fractal.access`.

### Settings

`FractalSettings` gains `allowDangerousAccess: Partial<Record<ProviderId, boolean>>`, absent meaning off. Since this setting gates the dangerous levels, the settings IPC handler gains the same sender check the conversation, model, terminal and files handlers already have (only the app window's main frame).

## Renderer

### Composer footer

`[Access] [Attach] … [Model · Effort] [Stop] [Send]`. The access picker is the leftmost control; the model and effort picker moves into the right-hand group, before the interrupt and send buttons.

### AccessPicker

`components/conversation/access-picker.tsx`, using the model picker's quiet trigger and option styling (current option in the primary colour with a checkmark), opening above the composer.

- Items are the agent's levels in order, each with its label and one-line description. Dangerous levels appear only when that agent's `allowDangerousAccess` is on.
- With no state, the trigger reads "Claude's default" or "Codex's default".
- A custom state appears as an extra, checked item ("Custom: dontAsk", "Custom: read-only · never ask"); it disappears once a level is picked.
- When `observed` is present, the trigger shows a warning icon with a tooltip (from `components/ui/tooltip.tsx`), and the menu shows one line stating what the last turn ran in, for example "Last turn ran in Ask; Claude didn't accept Auto".
- Picking a dangerous level opens a confirmation `Dialog` that states what it removes (for example "Codex will run any command with no sandbox and never ask"). The pick saves only on confirm. While a dangerous level, or a custom state marked `dangerous`, is the state, the trigger uses the destructive colour and a warning icon.

### useAccessChoice

Mirrors `useModelChoice`: loads `{ levels, access, observed, allowDangerous }` for the conversation, saves a pick immediately (as `picked: true`), and lets a pick made while the load is in flight win. It reloads when a turn in the conversation ends, when the picker opens, once the history has loaded, and whenever the history gains a new latest turn, wherever that turn ran. A listing asked for before the user's latest pick does not replace the mismatch state that pick cleared.

### Shift+Tab

In the message box, Shift+Tab moves to the next level in order, wrapping around; from the agent's default or a custom state it moves to the first level. It skips dangerous levels and never lands on custom. It is inactive while a turn runs, leaving Shift+Tab's usual focus movement.

### Settings dialog

Each agent's group gains a switch, "Allow bypass permissions" for Claude and "Allow full access" for Codex, with a one-line warning that the level removes the agent's safety checks.

## Error handling

- A read-back that throws resolves to `null`, and the picker shows the agent's default. Lookup failures never block the composer.
- A send whose access state is rejected fails with a visible error.
- A Codex `turn/start` that rejects the access fields (for example a combination a managed policy forbids) surfaces as a failed turn with Codex's error.

## Testing

Vitest (`pnpm test`), plus `pnpm lint` and `pnpm exec tsc --noEmit`.

- `access-levels`: each level's Claude argument and Codex fields; read-back mapping for every level, custom, and `manual`/`default`; Codex sandbox construction carrying `networkAccess` and `writableRoots` over (including `externalSandbox`'s `"enabled"` as `true`), and the defaults when coming from full access.
- Claude: the runner adds `--permission-mode` for a picked level, a read-back level and a custom `mode`, and nothing otherwise; transcript read-back picks the last `permissionMode`, using trimmed real transcripts as fixtures.
- `codexAccessState` marks every custom combination with a `dangerFullAccess` sandbox as `dangerous`, and nothing else.
- Codex adapter: `turn/start` carries the fields only for a picked level; read-back states, level or custom, send none; concurrent `resumeThread` calls make one request.
- `AccessChoiceStore` and `AccessChoices`: saved pick, then read-back, then `null`; only picked states are saved; cache dropped on send; `observed` only for a sent pick that differs; dangerous levels rejected when not allowed; unreadable file reads as empty.
- IPC: sender authorization and input validation.
- Renderer: picker states (default, level, custom, mismatch, dangerous), the confirmation dialog, Shift+Tab order and skips, and footer order.
- Manual: for Claude, choose each level and confirm the transcript records it (works without a subscription); for Codex, choose each level and confirm `thread/resume` reports it. Codex overrides apply even when the turn fails for lack of a login, so this also works against an isolated `CODEX_HOME`.
