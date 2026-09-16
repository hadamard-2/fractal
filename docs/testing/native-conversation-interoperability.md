# Native conversation interoperability

These manual smoke tests verify that Fractal can read and continue conversations owned by the installed Codex and Claude Code harnesses, and that each native CLI can subsequently resume the same conversation. They are opt-in because they launch provider processes, use the operator's existing authentication, and may consume model usage.

Do not run either procedure without explicit authorization. Fractal does not need, request, copy, or log provider credentials. Use only disposable repositories and non-sensitive fixture text.

## Safe test record

Record only this metadata for each run:

```text
provider:
provider version:
native session ID:
date:
approval exercised: yes | inconclusive | unsupported
question exercised: yes | inconclusive | unsupported
external ownership enforced: pass | fail
native resume after Fractal: pass | fail
history entries present once: pass | fail
overall: pass | fail
notes (metadata only):
```

Never paste credentials, prompts, responses, source text, command output, raw provider events, or transcript excerpts into the test record or a bug report. A failure report should identify only the provider/version, native session ID, failed step, displayed runtime or capability state, and whether the failure reproduced.

## Common setup

1. Confirm that the provider CLI is already installed and authenticated by the user. Do not authenticate through Fractal.
2. Create a temporary directory, initialize an empty Git repository in it, and add a named fixture file containing harmless, non-secret text. Keep the path and fixture name available for the test.
3. Launch Fractal only after the native CLI portion says to do so. In Fractal, use the project group for the temporary repository and match the exact native session ID.
4. Treat native history as authoritative. Do not edit provider history files or create a second transcript for comparison.

Example local setup (replace the directory shown by `mktemp -d` in later steps):

```bash
SMOKE_REPO="$(mktemp -d)"
git -C "$SMOKE_REPO" init
printf '%s\n' 'harmless interoperability fixture' > "$SMOKE_REPO/fractal-smoke-fixture.txt"
cd "$SMOKE_REPO"
```

Delete the temporary repository after recording metadata, according to the local environment's normal cleanup policy.

## Codex

1. Record the installed version with `codex --version`.
2. From the temporary repository, run `codex` and start a harmless conversation. Ask it to acknowledge the task without changing files. Note the native session ID, then wait until the run is idle before leaving the CLI.
3. Start Fractal. Under the temporary project, open the Codex conversation with that exact native session ID. Confirm that the native user prompt and response each appear once.
4. In Fractal, send one prompt whose only requested action is to read `fractal-smoke-fixture.txt` and report completion. If Codex requests read approval, exercise the normal allow-once path and record that approval was exercised. Do not approve writes, network access, or commands outside the temporary repository.
5. Wait until Fractal reports the conversation as idle. Confirm that the new prompt, response, and any approval audit entry appear once.
6. Exit Fractal so it no longer owns the run.
7. From the same temporary repository, run `codex resume <native-session-id>`. Confirm that both user prompts and both agent responses are present exactly once, then send no further work and exit.
8. Record only the safe metadata listed above.

### Codex external-ownership check

While a turn is actively running in a separately launched Codex process, open the same conversation in Fractal. Fractal must label it `active-externally` or otherwise show that external ownership is proven, keep the composer read-only, and refuse continuation. If ownership cannot be established, it must use `unknown` and remain read-only. It must never offer a force-write bypass.

## Claude Code

1. Record the installed version with `claude --version`.
2. From the temporary repository, run `claude` and start a harmless conversation. Ask it to acknowledge the task without changing files. Note the native session ID, then wait until the run is idle before leaving the CLI.
3. Start Fractal. Under the temporary project, open the Claude conversation with that exact native session ID. Confirm that the native user prompt and response each appear once.
4. Check the capabilities Fractal reports in the conversation header, directly below the provider/runtime/capture line. When routing is unavailable, this visible status names approval routing, question routing, or both and states that Fractal will not bypass native permissions.
5. Exercise the capabilities reported for this installed Claude version:
   - If approvals are supported, first inspect the installed CLI's current help and permission settings using the commands documented by that installed version. Record the original permission configuration outside the test log, configure a temporary-repository operation to require an approval, and restore the original configuration when the test ends. Provider versions differ, so this guide intentionally does not prescribe a universal permission flag.
   - Ask Claude to perform that known approval-requiring operation: harmlessly create `claude-approval-fixture.txt` inside the temporary repository with non-sensitive disposable text. Exercise allow-once in Fractal. Do not approve deletion, network access, or any operation outside the temporary repository. If no approval is requested, record the approval check as `inconclusive`, recheck the installed CLI help/settings, safely configure the named operation to require approval, and retry; never count a no-request run as a pass.
   - If questions are supported, send a prompt that asks Claude to use `AskUserQuestion` for one harmless choice, answer it in Fractal, and confirm that the resolved question remains visible as an audit entry.
   - If either capability is unsupported, confirm that Fractal reports that exact capability gap and does not offer a bypass. Record the capability as `unsupported`; do not try to manufacture the missing interaction.
6. Wait until Fractal reports the conversation as idle. Confirm that each prompt and response appears once.
7. Exit Fractal so it no longer owns the run, then restore any permission configuration changed for the approval check.
8. From the same temporary repository, run `claude --resume <native-session-id>`. Confirm that the native CLI shows the original native turn and every completed Fractal turn exactly once, then send no further work and exit.
9. Record only the safe metadata listed above.

### Claude external-ownership check

Start a turn in a separately launched `claude` process and keep that run active. Open the same conversation in Fractal. Fractal must remain read-only while the external process owns the session. It must label the session `active-externally` when ownership is proven, or `unknown` when it cannot prove the state, and it must not offer continuation or a bypass. After the native process becomes idle, refresh or reopen the conversation before continuing in Fractal.

## Pass criteria

A provider passes only when all applicable checks succeed:

- Native history is discovered under the correct canonical project and native session ID.
- Native and Fractal turns appear once, in provider order, without a parallel Fractal-owned transcript.
- The provider CLI can resume the completed Fractal turn.
- `active-externally` and `unknown` sessions stay read-only.
- Supported approvals and questions route through the visible Fractal request UI and remain auditable after resolution.
- Unsupported approval or question routing is identified as a capability gap with no bypass.
- The test record contains metadata only and no conversation or credential-adjacent content.
