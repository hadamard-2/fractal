# Composer attachments design

## Intent

Let the user attach images and arbitrary files to a message in the conversation composer, for both the Claude and Codex harnesses. Images reach the model as native image input. Every other file is handed to the agent by its absolute path, so the agent reads the real file with its own tools and that read appears in the transcript like any other. After sending, the transcript shows image thumbnails and file chips, and clicking either opens a larger view.

Slash commands are a separate feature with their own spec; this one only has to leave the prompt contract in a shape they can extend.

## What exists today

The composer is the vendored ai-elements `PromptInput`. It already implements a file picker, drag-and-drop, paste, accept/size/count limits, and blob-to-data-URL conversion on submit, but `conversation-panel.tsx` discards everything except `message.text`. New conversations carry no prompt (`create` takes only provider and project path), so every message, including the first, goes through `continue`, whose prompt is validated by `parsePromptInput` as `{ text }` only.

The Claude runner spawns `claude --resume <id> --print "<text>" --output-format stream-json` per turn with stdin ignored, and anchors the live turn by matching the prompt text against the `turn-started` event read back from history. The Codex adapter sends `turn/start` with a single `text` input item; the installed app-server (codex-cli 0.149.1) also accepts `localImage { path }` items. Claude history already parses inline base64 image blocks in user messages into `ConversationImage`s. Codex history turns any non-text user-message content into an "unsupported" event.

## Prompt contract

`continue` takes a prompt of this shape, validated by `parsePromptInput`:

```ts
type PromptInput = {
  text: string;
  attachments?: Array<
    | { kind: 'path'; path: string }
    | { kind: 'bytes'; name: string; mediaType: ConversationImage['mediaType']; data: string }
  >;
};
```

A `path` attachment is a file the user picked or dropped that exists on disk; the path must be absolute. A `bytes` attachment is an image with no file behind it, typically a pasted screenshot; its data is base64 and its media type is one of `CONVERSATION_IMAGE_TYPES`. A prompt must have non-blank text or at least one attachment. At most 10 attachments per message. The per-image size cap is set from the spike (see Open questions resolved by the spike); until then the existing `MAX_CONVERSATION_IMAGE_DATA_LENGTH` applies to `bytes` data. Path attachments are not size-capped at the contract level because only the path crosses IPC; images among them are capped when main reads them.

`ConversationApi.continue` changes its prompt parameter type accordingly. `{ text }` alone stays valid, so existing callers are unaffected.

## Renderer and preload

The renderer never touches Node. Preload exposes one new helper, `attachments.pathFor(file: File): string`, a thin wrapper over Electron's `webUtils.getPathForFile`, which returns an empty string for a file with no disk location.

`PromptInput` is modified so that when a file is added (picker, drop, or paste) it records the file's disk path alongside the existing `FileUIPart`, calling the preload helper while it still holds the `File`. On submit, items with a path skip the blob-to-data-URL conversion, so a large file is never read into renderer memory. Items without a path keep the conversion, and only images are accepted without a path; a pathless non-image (rare, e.g. some clipboard sources) is rejected with the composer's inline error.

The conversation panel maps the submitted items to the contract: items with a path become `path` attachments, the rest become `bytes` attachments with the data URL's base64 payload.

## Composer

A paperclip button in the composer footer opens the native file picker. Drop onto the composer and paste into the textarea also attach. Each pending attachment is a chip above the textarea: a small thumbnail for an image, a file icon and filename for anything else, and a remove button. The send button is enabled when there is non-blank text or at least one attachment. Attachments, like the draft text, are cleared only when the send succeeds; on failure both stay so the user can retry.

Type, size, and count violations detected in the composer are shown as an inline message beneath it via `PromptInput`'s `onError`, and nothing is sent.

## Main process: resolving attachments

Main turns every attachment into a resolved file `{ path, mediaType, isImage }` before any adapter sees it.

- A `bytes` attachment is written to `<userData>/attachments/<conversationKey>/<uuid>.<ext>`, the extension derived from its media type, and its resolved path is that file. The directory lives outside every project and persists, so paths recorded in native history stay valid; it grows until the user clears it through the existing data-folder setting.
- A `path` attachment is `stat`ed. Missing, unreadable, or non-regular files (including directories) reject the whole send with an error naming the file. Main determines the media type itself by sniffing the file's leading bytes for the supported image signatures; the renderer's claim is not trusted. A file is an image only if it sniffs as one of `CONVERSATION_IMAGE_TYPES`.

Any failure here rejects the `continue` promise before the adapter is invoked, and the panel's existing `actionError` line shows the message.

## Wire mapping per harness

Both harnesses express non-image files the same way: Fractal appends an attachments block to the end of the text the agent receives, one absolute path per line.

```
<attachments>
/abs/path/one.ts
/abs/path/two.log
</attachments>
```

The block is separated from the user's text by a blank line and omitted when there are no non-image files. When the user sent no text, the text is the block alone.

**Codex.** `turn/start` input becomes the text item (user text plus the block) followed by one `{ type: 'localImage', path }` item per image, in attachment order. Pasted images use their written path.

**Claude.** The runner stops passing the prompt as a `--print` argument and instead runs with `--print --input-format stream-json`, writing a single user message to stdin and then closing it. The message's content is a text block (user text plus the block) followed by one base64 image block per image, in attachment order; images are read from their resolved paths. stdin changes from `ignore` to `pipe`. The turn anchor is updated to match whatever `turn-started` text the history records for such a message, as established by the spike.

## Transcript

**Images.** Claude user-message image blocks already render as thumbnails. Codex history gains handling for `localImage` content: main reads the file at that path and emits it as a `ConversationImage` on the user message. If the file is missing, unreadable, not a supported image, or over the image cap, it is shown as a file chip instead (see Files below).

**Files.** When a user message's text ends with an attachments block in exactly the format above, the history parsers strip it from the displayed text and expose its paths as file attachments on the user message, rendered as chips beneath the message alongside any images. A block that is malformed, or that is not at the end of the message, is left as ordinary text. A user who types a well-formed block by hand at the end of a message will also get chips; this is accepted.

`ConversationTurn.userMessage` gains `files?: Array<{ path: string; missing?: true }>` and the IPC stream parser validates it with the same absolute-path rule used elsewhere. Main sets `missing` when it `stat`s the path while building the turn and finds nothing there; a Codex `localImage` that cannot be shown as an image is emitted as a `files` entry, with `missing` set if the file is gone.

A file chip shows a file icon and the filename, with the full path in a tooltip; a missing chip is dimmed and labelled "missing". Clicking a chip opens a dialog styled like the image dialog.

## Attachment preview

The dialog is backed by a new IPC call, `conversations.previewAttachment(ref, path)`. Main only serves a path that appears in that conversation's native history as an attachment: a path inside an attachments block on a user message, or a Codex `localImage` path. Any other path is refused. Main reads the conversation's history to check, and may cache the allowed set per conversation, invalidated when that conversation's history is re-read.

For an allowed path, main returns:

- `kind: 'text'` with the contents, for a file that decodes as UTF-8 without NUL bytes, truncated to the first 256 KiB with a `truncated` flag;
- `kind: 'binary'` with size only, for anything else;
- `kind: 'missing'` when the file no longer exists;

each with the file's size and modification time.

The dialog shows text contents syntax-highlighted by file extension using the transcript's existing highlighter, with a notice when truncated. For binary files it shows name, size, and path. Every dialog offers "Open with default app" and "Show in folder", performed by main through Electron `shell` and subject to the same allowed-path check. When the file's modification time is later than the message's timestamp, the dialog states "Modified since this message was sent", because the dialog shows the file as it is now, not as the agent read it.

## Open questions resolved by the spike

Before implementation, a spike runs real `claude` turns (with the user's approval, since they create sessions in native history) to establish:

1. That `--resume` together with `--print --input-format stream-json` accepts one user message on stdin containing text and a base64 image block, on the installed Claude Code 2.1.263.
2. How that turn is recorded in the session history, specifically the `turn-started` text the normalizer derives from it, so the runner's turn anchor can match it.
3. Claude's per-image size limit, which becomes the image cap for both `bytes` attachments and images read from paths.

The findings are written into this spec, replacing this section, before the implementation plan is written.

## Verification

Unit tests, written before the implementation they cover:

- `parsePromptInput`: accepts text only, attachments only, and both; rejects relative paths, unsupported media types, over-cap image data, more than 10 attachments, and blank text with no attachments.
- Attachment resolution: `bytes` are written under the conversation's attachments directory with the right extension; missing paths and directories reject; image type comes from sniffed bytes, not the declared type.
- Codex adapter: images become `localImage` items after the text item; non-images become the attachments block.
- Claude runner: spawns with `--input-format stream-json` and piped stdin, writes one user message with text and image blocks, closes stdin; the turn anchor matches the recorded shape.
- History parsing: Codex `localImage` becomes an image or a missing chip; a trailing well-formed block becomes file chips; malformed or mid-message blocks stay as text.
- Attachment preview: an attachment path is served; any other path is refused, including for open-in-app and show-in-folder; text over 256 KiB is truncated; binary and missing are reported; the modified flag follows the message timestamp.
- Composer: chips appear on pick, drop, and paste; remove works; send is enabled with attachments and no text; attachments survive a failed send.

Then, in the running app, for both Claude and Codex: attach a project file and a pasted screenshot, send, confirm the agent received both (it references the file's contents and describes the image), reopen the conversation from history, and open each thumbnail and chip.

`pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm test` pass.

## Out of scope

- Slash commands (separate spec).
- Attaching directories.
- Storing a snapshot of a file's contents at send time; the preview shows the current file and flags modification instead.
- Cleaning up or quota-limiting `<userData>/attachments`.
- Audio input, although Codex accepts it.
- Previewing files the agent read, as opposed to files the user attached.
