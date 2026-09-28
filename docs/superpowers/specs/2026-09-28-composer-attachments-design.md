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

A `path` attachment is a file the user picked or dropped that exists on disk; the path must be absolute. A `bytes` attachment is an image with no file behind it, typically a pasted screenshot; its data is base64 and its media type is one of `CONVERSATION_IMAGE_TYPES`. A prompt must have non-blank text or at least one attachment. At most 10 attachments per message. An image may be at most 20 MiB raw (`MAX_ATTACHMENT_IMAGE_BYTES`), so `bytes` data may be at most the base64 length of that. This cap is Fractal's own bound on IPC and memory, not a provider limit (see Spike findings). It is separate from `MAX_CONVERSATION_IMAGE_DATA_LENGTH`, which only governs rendering. Path attachments are not size-capped at the contract level because only the path crosses IPC; images among them are capped when main reads them.

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

Any failure here rejects the `continue` promise before the adapter is invoked, and the panel's existing `actionError` line shows the message. Resolution happens in the IPC layer, before `ConversationService.continue`. These failures throw an `AttachmentError`, which the IPC layer's error hiding passes through unchanged. It is a deliberate, narrow exception to the rule that failures inside a call reach the renderer only as "Conversation operation failed".

## Wire mapping per harness

Both harnesses express non-image files the same way: Fractal appends an attachments block to the end of the text the agent receives, one absolute path per line.

```
<attachments>
/abs/path/one.ts
/abs/path/two.log
</attachments>
```

The block is separated from the user's text by a blank line and omitted when there are no non-image files. When the user sent no text, the text is the block alone.

**Codex.** `turn/start` input becomes the text item (user text plus the block), omitted when that text is empty, followed by one `{ type: 'localImage', path }` item per image, in attachment order. Pasted images use their written path.

**Claude.** The runner stops passing the prompt as a `--print` argument and instead runs with `--print --input-format stream-json`, writing a single user message to stdin and then closing it. This applies to every turn, with or without attachments, so there is one input path. The message's content is a text block (user text plus the block), omitted when that text is empty, followed by one base64 image block per image, in attachment order. The adapter reads images from their resolved paths before starting the runner. stdin changes from `ignore` to `pipe`. The turn anchor compares against the composed text (user text plus the block), which is exactly what the history records (see Spike findings).

## Transcript

History normalization stays pure and synchronous: normalizers and the turn projector never touch the filesystem. A user message carries attachment paths only, and the renderer fetches contents and status lazily through the attachment preview call when a thumbnail or chip mounts. The timeline is virtualized, so only visible rows fetch.

`ConversationTurn.userMessage` gains `attachments?: Array<{ path: string; kind: 'image' | 'file' }>`, and the IPC stream parser validates each path with the same absolute-path rule used elsewhere. The existing inline `images` field is unchanged.

**Images.** Claude user-message image blocks are already inline base64 in history and keep rendering as thumbnails through `images`. The Codex normalizer turns `localImage` content into an `attachments` entry of kind `image`. The renderer shows it as a thumbnail loaded through the preview call. If the preview reports anything other than an image, it shows a file chip instead (missing, binary, or an image over the cap).

**Files.** When the text of a user message ends with an attachments block in exactly the format above, the turn projector strips it from the displayed text and adds each path as an `attachments` entry of kind `file`. This happens once, for both harnesses. A block that is malformed, or that is not at the end of the message, is left as ordinary text. A user who types a well-formed block by hand at the end of a message will also get chips; this is accepted. The normalizers still see the full text, so the Claude runner's turn anchor still matches the composed text.

A file chip shows a file icon and the filename, with the full path in a tooltip. On mount it asks the preview call for status. When the file is missing it renders dimmed and labelled "missing". It renders neutral until the answer arrives. Clicking a chip opens a dialog styled like the image dialog.

## Attachment preview

The dialog and lazy thumbnails are backed by a new IPC call, `conversations.previewAttachment(ref, path)`. The conversation must be open and owned by the calling renderer, as for every other conversation call. Main serves a path only if it appears in an `attachments` entry of a user message in that conversation's projected turns: the history and live turns `ConversationService` already holds in memory for the open conversation. Any other path is refused.

For an allowed path, main returns one of:

- `kind: 'image'` with a `ConversationImage`, for a file that sniffs as a supported image type and is within the image cap;
- `kind: 'text'` with the contents, for a file that decodes as UTF-8 without NUL bytes, truncated to the first 256 KiB with a `truncated` flag;
- `kind: 'binary'` for anything else, including images over the cap;
- `kind: 'missing'` when the file no longer exists.

Every kind except `missing` includes the file's size and modification time.

The dialog shows text contents syntax-highlighted by file extension using the transcript's existing highlighter, with a notice when truncated. It falls back to plain text when the extension is not a supported language. For binary files it shows name, size, and path. Every dialog offers "Open with default app" and "Show in folder". Main performs both through Electron `shell`, behind a second call, `conversations.openAttachment(ref, path, action)`, which is subject to the same allowed-path check. When the file's modification time is later than the message's timestamp, the dialog states "Modified since this message was sent", because the dialog shows the file as it is now, not as the agent read it.

## Spike findings

Run on 2026-09-28 against Claude Code 2.1.263, in a scratch directory outside any project.

1. `claude --resume <id> --print --input-format stream-json --output-format stream-json --verbose` accepts a single user message on stdin whose content is a text block followed by a base64 image block. The model answered correctly about the image.
2. The session history records that user message with its content array verbatim. The Claude normalizer builds the `turn-started` text by joining text blocks with a newline, so with one text block the anchor text equals the composed text exactly.
3. There is no hard size limit at this size. A 6.3 MB PNG (8.4 M base64 characters) was accepted; Claude Code downscaled it to a roughly 600 KB JPEG before recording it in history. The 20 MiB cap is therefore Fractal's own choice.

Also observed, for the slash commands spec: the stream-json `system`/`init` event carries `slash_commands`, `terminal_slash_commands`, and `skills` lists.

Codex was not probed. A `localImage` Codex rejects surfaces as a turn failure through the existing path.

## Verification

Unit tests, written before the implementation they cover:

- `parsePromptInput`: accepts text only, attachments only, and both; rejects relative paths, unsupported media types, over-cap image data, more than 10 attachments, and blank text with no attachments.
- Attachment resolution: `bytes` are written under the conversation's attachments directory with the right extension; missing paths and directories reject; image type comes from sniffed bytes, not the declared type.
- Codex adapter: images become `localImage` items after the text item; non-images become the attachments block.
- Claude runner: spawns with `--input-format stream-json` and piped stdin, writes one user message with text and image blocks, closes stdin; the turn anchor matches the recorded shape.
- History parsing: Codex `localImage` becomes an `image` attachment; a trailing well-formed block becomes `file` attachments with the block stripped from the text; malformed or mid-message blocks stay as text.
- Attachment preview: an attachment path is served; any other path is refused, including for open-in-app and show-in-folder; images, text over 256 KiB (truncated), binary, and missing are reported; the modified notice follows the message timestamp.
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
