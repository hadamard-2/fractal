# Model and effort picker design

## Intent

Let the user choose the model and reasoning effort for each conversation from the composer, for both the Claude and Codex harnesses. The choice belongs to the conversation: it applies to that conversation's following turns and is remembered. A new conversation starts from the last choice sent with that agent. The picker always shows what the next turn will actually run with.

## What exists today

Nothing in Fractal passes or displays a model or effort. The Claude runner spawns `claude --session-id|--resume <id> --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages` once per turn. The Codex adapter keeps one app-server process and sends `thread/resume` then `turn/start { threadId, input }` per turn. The only composer is the one in `conversation-panel.tsx`; new conversations are created first and then open in that same panel.

## Findings the design rests on

Verified against the installed CLIs on 2026-09-30 (Claude Code 2.1.263, codex-cli 0.149.1).

- **Codex model list.** `model/list` on the app-server returns `Model[]` with `id`, `displayName`, `description`, `hidden`, `isDefault`, `supportedReasoningEfforts: { reasoningEffort, description }[]` and `defaultReasoningEffort`. Efforts differ per model (here `gpt-5.6-terra` offers low through ultra, `gpt-5.5` stops at xhigh). It is part of the generated app-server schema in `src/main/harness/codex/generated/v2`.
- **Codex selection.** `TurnStartParams` accepts `model` and `effort`, documented as overriding "this turn and subsequent turns". `ThreadResumeResponse` returns the thread's `model` and `reasoningEffort`. `thread/read` does not carry the model.
- **Claude model list.** Sending `{"type":"control_request","request_id":…,"request":{"subtype":"initialize"}}` on stdin in stream-json mode returns a `control_response` whose `models` entries carry `value` (an alias such as `opus`, `default`, or a full id), `displayName`, `description`, `supportsEffort` and `supportedEffortLevels`. Haiku reports no effort support. No default effort is reported. This is the control protocol the Agent SDK uses; it is not a documented CLI contract, so the parser must tolerate its absence or change.
- **Claude probe cost.** About 1.65s. It runs the user's hooks unless started with `--settings '{"disableAllHooks":true}'`, which still returns all models.
- **Claude selection.** `claude --help` lists `--model <model>` (alias or full name) and `--effort <level>`.
- **Claude history.** Assistant records carry `message.model` as a full id (for example `claude-opus-5-5`), and records carry `effort`. The full id need not appear in the probe's list, whose `opus` resolved to `claude-opus-5` here.
- Codex threads can also be on a model `model/list` does not return (`gpt-6-sol` in the local state database).

Not verified: whether `claude --resume` without `--model` keeps the session's last model or falls back to the configured default. The design does not depend on it, because once a conversation shows a model Fractal passes it explicitly.

## Main process

### Model catalogs

`HarnessAdapter` gains an optional `listModels(): Promise<AgentModel[]>`:

```ts
interface AgentModel {
  id: string;            // the value passed back to the agent
  label: string;
  description?: string;
  efforts: string[];     // empty when the model takes no effort
  defaultEffort?: string;
}
```

- Codex maps `model/list` (following `nextCursor`), dropping `hidden` models.
- Claude uses a new `claude-models.ts` that spawns the Claude executable with `--print --input-format stream-json --output-format stream-json --verbose --settings '{"disableAllHooks":true}'`, writes the `initialize` control request, reads NDJSON until the matching `control_response`, and kills the process. It times out after 10s. `defaultEffort` is left unset.

Main fetches both catalogs once, in the background, at startup and keeps them in memory for the app's lifetime. A failed or timed-out fetch yields an empty list for that agent. A CLI update is picked up on the next launch.

### Last run

`HarnessAdapter` gains an optional `readLastRun(ref): Promise<{ model: string; effort?: string } | undefined>`:

- Claude reads the conversation's transcript: `message.model` of the last assistant record and the last `effort` value.
- Codex sends `thread/resume` and reads `model` and `reasoningEffort` from the response. It does not unsubscribe: Fractal shares one app-server connection, `continueConversation` already resumes without unsubscribing, and an unsubscribe would likely stop live notifications for a turn Fractal is streaming on that thread. The thread stays loaded for the session.

### Stored choice

`FractalSettings` gains:

```ts
modelChoices: Record<string, ModelChoice>;         // keyed by conversationKey
lastModelChoice: Partial<Record<ProviderId, ModelChoice>>;
interface ModelChoice { model: string; effort?: string }
```

Both are coerced on read like the other settings: non-object values and entries with a non-string or empty `model` are dropped.

A conversation's resolved choice is, in order: its `modelChoices` entry; for a conversation with no turns yet, `lastModelChoice[provider]`; `readLastRun(ref)`; otherwise "Default", meaning no model or effort is passed and the agent's own configuration decides.

### Sending

`PromptInput` (the IPC contract) and `AgentPrompt` gain optional `model` and `effort` strings. `parsePromptInput` accepts each only as nonblank text of at most 200 characters. The Claude runner appends `--model <model>` and `--effort <effort>` when present. The Codex adapter passes them as `model` and `effort` on `turn/start`.

On each send the renderer's choice is written to `modelChoices[conversationKey]` and `lastModelChoice[provider]`.

### IPC

A new `fractal:conversations:models` invoke channel takes a `ConversationRef` and returns `{ models: AgentModel[]; choice: ModelChoice | null }`, where `models` is the provider's catalog (possibly still empty if the startup fetch has not finished) and `choice` is the resolved choice (`null` for "Default"). Picking in the composer saves through the existing settings `set`.

## Renderer

Two compact ghost-style selects sit in the composer footer to the right of the attach button, built on the existing `PromptInputSelect` wrappers.

- **Model.** Items show the label with the description beneath. When the resolved model is not in the catalog, it is listed first under its raw id. "Default" is shown when there is no choice.
- **Effort.** Lists only the selected model's efforts. Hidden when the model has none, or when the model is unknown to the catalog and no effort is recorded. With no stored effort it reads "Default" for Claude and the model's `defaultEffort` for Codex; there is no separate "Default" item.

Until the catalog arrives, each select shows the current choice and opens to that single item.

### Behaviour

- **Switching to a model that lacks the current effort** resets effort to the new model's `defaultEffort`, or to "Default" (no flag) when it has none.
- **Changing the selection during a running turn** is allowed. It is saved immediately and applies to the next turn.
- **`lastModelChoice`** updates on send, not on pick, so browsing options does not change what new conversations start with.
- A conversation reopened later shows its saved choice without waiting for `readLastRun`.

## Out of scope

Settings-screen defaults, Codex service tiers and personality, Claude fast mode, and refreshing catalogs while the app is running.

## Testing

- `claude-models`: parses a recorded `control_response` into `AgentModel[]`; returns an empty list on timeout, early exit, or a response with no `models`; passes the hook-disabling settings.
- Codex adapter: `listModels` maps and pages `model/list` and drops hidden models; `readLastRun` resumes and never unsubscribes; `turn/start` carries `model` and `effort` only when set.
- Claude runner: spawn arguments include `--model` and `--effort` only when set.
- Claude history: `readLastRun` returns the last assistant model and last effort from the fixture transcripts.
- `conversation-ipc`: `parsePromptInput` accepts and bounds `model` and `effort`.
- Settings store: coercion of `modelChoices` and `lastModelChoice`.
- Choice resolution order, including the new-conversation seed.
- Composer: model and effort selects render the resolved choice, list an off-catalog model, hide effort for effortless models, reset effort on an incompatible switch, and send the choice with the prompt.

## As built (history, 2026-10-03)

This records where the shipped feature departed from the design above. The design text is left as written; where the two disagree, the code is the authority.

- **Storage.** Choices live in `<userData>/model-choices.json` (`ModelChoiceStore`), not in `FractalSettings`, so a renderer settings patch cannot overwrite them. An unreadable file reads as empty.
- **IPC.** Two channels, `fractal:models:list` (catalog plus resolved choice) and `fractal:models:choose`, exposed as `window.fractal.models`, instead of `fractal:conversations:models` plus settings `set`.
- **Sending waits for the choice.** The composer cannot submit until the conversation's choice has loaded, so an early send cannot run on the agent default and clear the last-used choice.
- **Last run is read once per launch** per conversation, so opening the picker does not repeat a Codex `thread/resume`.
- **Claude catalog.** The `default` entry is dropped (no choice already means the agent's default). Names carry the version: the display name when it includes one, else the head of the description ("Opus 5.5 · …"). `resolvedModel` is read as `resolvesTo`, so a conversation on a full id such as `claude-opus-5-5` shows as the alias that resolves to it while still sending its exact id.
- **Picker.** Two matching dropdown menus that open above the composer, with the current option in the primary colour. The model menu shows each family's newest version up front (Claude: Fable, Opus, Sonnet, Haiku; Codex: by variant, in the order Codex lists them) and older versions under a "More models" submenu, grouped the same way, newest first. Efforts are listed from most to least; there is no "Default" effort item.
