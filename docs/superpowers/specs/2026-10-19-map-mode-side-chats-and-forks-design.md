# Map mode, side chats and forks design

## Intent

Conversations with an agent are linear, and people don't think linearly. Partway through a conversation the user wants to go down a rabbit hole: ask about a term, chase a tangent, learn the thing the agent just glossed over. Then they want to keep that detour or throw it away, without the main conversation getting bent out of shape. A linear chat keeps you focused, but when it's the only option it's limiting and frustrating.

This design adds two primitives and one view:

- **Side chat:** a read-only branch of a conversation. It starts after any agent reply, carries the conversation's history up to that point, and can read files and run read-only commands but never change anything. Side chats are the rabbit holes.
- **Fork:** a full, separate conversation that picks up from a point in another one. It shows up in the sidebar nested under its parent.
- **Map mode:** a spatial canvas of one conversation. Its main line runs down the canvas, and its side chats branch off to the right. You can read the conversation, and start and continue side chats, directly on the canvas.

Per AGENTS.md, Map mode is about ergonomics: branching, organizing and navigating threads. It doesn't carry the cognitive-debt claim and shouldn't be designed as if it does.

The user arrived at this shape by walking back from a first idea, which was a DAG with movable start/end nodes, rewireable edges, and merges that would pull a side branch's content into the main line. The reason for the walk-back matters for every later decision. **These are agentic conversations with side effects on the user's files, not plain chats.** An edge on the map is a record of what the agent actually had in its history. If edges could be rewired, the map would show a history that never happened. If branches could write, they would collide on disk.

## Goals

- Start a rabbit hole from any agent reply without disturbing the main line, and keep it or delete it later.
- See a conversation and all its side chats on one canvas, and work with side chats there.
- Fork a conversation from any earlier point into a real, separate conversation whose lineage is visible.
- Keep the map's look and feel Fractal's own, not stock React Flow.

## Non-goals (for now)

- **Merging or "including" branch content into the main line.** This is set aside, not rejected. The user's thinking so far is that the agent should only ever see one path, plus at most one included node. If it comes back, an include can only ever be text handed over with the user's next message at the join point. The agent's past can't be rewritten.
- Start and end nodes, user-chosen active paths, and rewiring edges.
- Giving forks their own worktrees or restoring files to a past state. A fork works in the same project folder as everything else, as forks in Claude Desktop do.
- Writing to files from the map. Every node created on the map is a side chat.
- Showing side chats in the sidebar.
- Anything in Explain mode.

## Anti-goals (a failure even if it works)

- The map showing a history the agent didn't have.
- A side chat that manages to change a file or run a non-read-only command. Read-only has to be enforced by the agent's own permission or sandbox machinery, not by asking it nicely.
- An agent's context holding two separate paths.
- A canvas that looks like a React Flow demo: stock node chrome, stock controls, default blue handles, or the OS's own scrollbars or tooltips.

## Decided

### The tree

A conversation and its side chats form a tree. Every node has exactly one parent, and that parent is the history the agent actually had. The **main line** is the conversation itself. It's the only active path, it never changes, and it's what execute mode shows. On the map it's drawn with primary-colored (`--primary`) edges and node borders. There are no special start or end nodes. You can drag nodes anywhere, but that only changes the layout, never the tree.

Forks are not on the canvas. A fork is its own conversation with its own map.

### Nodes

- **One node per message**, alternating between your messages and agent replies. The user chose this over one node per turn, and may switch to per-turn later if per-message doesn't feel right, so keep that change cheap.
- Nodes start at a fixed size. A **Preview / Full** toggle on the canvas controls how text shows. Preview cuts each message to a couple of lines. **Full grows each node to fit its whole message**, so you read by panning the canvas.
- Nodes can be resized by dragging.

### Canvas

- An infinite canvas you can pan and zoom, like Figma, with zoom-in, zoom-out and fit-to-view controls.
- Nodes snap to a grid while you drag them.
- Edges are bezier curves.
- The main line runs top to bottom. Side chats branch out to the right, from a handle on the right edge of an agent reply. Side-chat edges are grey (a neutral like `--muted-foreground` at reduced strength); only the main line is teal.
- The look is the app's own: the dotted background on `--background`, nodes on `--card` with `--border`, Geist, and teal as the only color. The mockups from the session are in `.superpowers/brainstorm/` (gitignored): `node-granularity.html` and `full-mode.html`.

### Side chats

**What one is.** A side chat is a native fork of its parent's agent session, cut off after one agent reply and run read-only. Its parent is either the main conversation or another side chat, so side chats can nest. Both installed CLIs support forking at a point:

- **Claude:** the Agent SDK's `forkSession(sessionId, { upToMessageId })`, or a query with `resume` + `resumeSessionAt` + `forkSession`.
- **Codex:** the app server's `thread/fork` with `lastTurnId`, which also accepts `sandbox`, `approvalPolicy`, `cwd` and `developerInstructions` overrides.

Both harnesses report `fork: false` today (`claude-adapter.ts`, `claude-probe.ts`, `codex-adapter.ts`), so phase 1 is about adding fork support to them.

**Read-only.** A side chat runs in the same project folder as the conversation. It can read files and run read-only commands, and it can't write. On Codex this is the `read-only` sandbox. On Claude it should be a permission setup that refuses edits and non-read-only commands. Plan mode is the nearest preset, but it pushes the agent toward writing plans, so a tool or permission restriction is probably the better fit. Choosing which is the builder's call.

**No escalation.** A side chat never asks for permission to do more. Requests beyond read-only are refused automatically, with no approval prompt. One click on an approval would otherwise turn a side chat into a writer. On Codex that means forking with `approvalPolicy: 'never'` on top of the `read-only` sandbox, not the existing `read-only` access level, whose `on-request` policy asks before doing more. On Claude, the permission handler refuses on its own instead of routing the request to the UI. Agent questions (Claude's `AskUserQuestion`) are switched off in side chats too, so canvas nodes never need the blocking-request UI. *Claude's call, following the user's "limited to reads".*

**Files may have moved on.** A side chat sees today's files, not the files as they were at its branch point. When a side chat starts, Fractal tells the agent that the project's files may have changed since that point in the conversation, and that it should trust what it reads over what its history implies. Claude can take this as an appended system prompt, and Codex as `developerInstructions`.

**Running.** A side chat is a separate session, so it can run while the main line or other side chats are running.

**Four ways to start one.** All four create the same record and show up on the canvas.

1. **Map, drag a handle:** drag from the handle on any agent reply, on the main line or in a side chat, and drop on empty canvas. You get a new, empty node to type into.
2. **Map, select text:** select text in any message, and a small floating menu appears with a single entry, "Side chat". Choosing it drops a new node beside that message, with the selected text already quoted.
3. **Execute, select text:** the same menu. The side chat opens in the right panel.
4. **Execute, right-panel tab:** the right panel already lists a disabled "Side chat" entry (`right-panel/tool-entries.tsx`, hint "Soon"). Opening it starts a side chat that branches from the latest agent reply on the main line. `renderer/panel-tabs.ts` gains a side-chat tab kind next to terminal, file and changes.

**Selected text** is quoted at the top of the side chat's first message as a markdown blockquote, so both you and the agent can see what the question is about.

**Typing on the map.** A new side-chat node is an inline composer. You type into the node itself and press **Ctrl+Enter** to send. A new node for the reply appears underneath and streams in. To continue a side chat, drag from its latest reply.

A side chat stays attached to the reply it branched from, even after the main line has moved on.

**Kept wherever it was made.** The user asked that a record of every side chat be kept and shown on the canvas, wherever it was started. So closing a right-panel side-chat tab only closes the view. The side chat stays on the map, and getting rid of it means deleting it. *Claude's calls:*
- Any side chat on the map can be reopened in the right panel ("Open in panel").
- The native session is only created on the first send, so a tab or node you abandon before sending leaves nothing behind.

**Branch point gone.** The main conversation can be rewound or rolled back outside Fractal, which removes the reply a side chat hangs off. In that case the side chat stays on the map where it was, shown as detached and labelled to say its branch point is no longer in the conversation. It's never re-attached somewhere else, because that would show a history the agent didn't have. The side-chat record therefore stores the branch-point id and the branch-point text it was cut from. *Claude's call.*

### Forks

- You create a fork from a **"Fork from here"** action that sits with the copy button already shown on hover (`conversation/conversation-turn.tsx`).
- **On an agent reply**, the fork carries the history up to and including that reply.
- **On one of your own messages**, the fork carries the history up to just *before* that message, and opens with your message already in the composer (text, and attachments where possible), so you can rewrite it and send it differently. This is the "what if I'd asked it differently" feature. The divider sits at the end of the inherited history. *Decided by the user.*
- **A side chat can be forked into a full conversation.** This is how a rabbit hole that turned out to matter gets kept and acted on. "Fork from here" is available in side chats, both in the right-panel tab and on the map. The fork is a normal, writable conversation with the main conversation's access. Since side chats aren't in the sidebar, it nests under the main conversation the side chat came from. Its lineage record still stores the side chat it was forked from. *Decided by the user.*
- A fork is a native fork with the parent's full access, opened as a new conversation in the same project folder.
- In the sidebar, a fork appears **nested under its parent with lineage lines**. The reference is Claude Desktop's sidebar, where forks sit indented under the parent with tree connectors and are titled "<parent title> (fork)", the Claude SDK's default fork title. Today the sidebar hides every summary with a `parentId` (`sidebar-03/sidebar-order.ts`), because `parentId` currently means a subagent conversation, which is read-only (`conversation-service.ts`, `claude-adapter.ts`). Fork lineage needs its own field, not a reuse of `parentId`.
- In execute mode, a forked conversation shows a **primary-colored divider** where the fork happened. Above it are the inherited messages, below it the fork's own.
- *Claude's calls on the sidebar:* forks nest to any depth and always sit under their parent. They can't be dragged out from under it. If the parent is archived and the fork isn't, the fork shows at the top level of its project.
- When a fork is made from a message that isn't the latest, the agent is told the same thing a side chat is told: the files may have moved on since that point.
- Two conversations writing at once can overwrite each other's edits. That's accepted. The user decides what runs when.

## Calls Claude made (the user may want to check these)

- **Where forks are made:** a "Fork from here" action next to the copy button that shows on hover, on any message in execute mode or in a side-chat tab, and on any node on the map.
- **Agent-reply node content:** an agent-reply node covers the whole reply for a turn: prose, plans and tool work. Preview shows the start of the prose. Full shows the prose, with tool work collapsed the same way execute mode shows it.
- **Text selected inside one of your own messages** starts a side chat that branches after that turn's reply, since side chats only branch from replies.
- **Resizing in Full:** a node's width can still be dragged, and its height follows its text.
- **Layout:** a new node gets an automatic position (below its parent if it continues a line, to the right if it starts a branch). From then on it stays where you put it. Positions, sizes and the Preview/Full setting are saved per conversation.
- **Deleting a side chat** removes it and everything branched from it, after you confirm. Because a side chat is a real native session that would otherwise show up in the agent's own history and in Fractal's sidebar, deleting it also deletes those native sessions (Codex `thread/delete`, Claude's SDK session deletion). This can't be undone, which is why it asks first.
- **Side chats stay out of the sidebar.** Native side-chat sessions turn up in each CLI's own conversation list, so Fractal keeps its own record of which sessions are side chats and filters them out of the sidebar. They will still appear in the CLIs' own resume pickers, and Fractal doesn't try to hide them there.
- **Subagent conversations** (read-only today) get a map but no side chats or forks.
- **Library:** use `@xyflow/react` (12.12.0 at the time of writing, which supports React 19) in place of the `reactflow` 11.11.4 dependency that's installed but unused. `reactflow` was last published in June 2024 and is the predecessor package. Nothing imports it, so the swap is free.
- **Map mode without a selected conversation** shows an empty canvas with a short hint to pick a chat.

## Constraints

- Everything the renderer needs goes through `window.fractal` via `preload.ts`, with channel names and input parsers in `shared/` and handlers in `main/`. Handlers accept calls only from the app window's main frame (AGENTS.md). Forking, side chats, and loading and saving map layout are all main-process capabilities exposed that way.
- Fractal's own records go in the userData directory as JSON stores, following `settings-store.ts`, `model-choice-store.ts` and `access-choice-store.ts`. That covers which sessions are side chats, their parent and branch point, fork lineage and fork points where the native history doesn't record them, and node positions and sizes. The agent's history stays in the agent's own files.
- Fractal never handles API keys and drives only the user's installed CLIs (AGENTS.md).
- **UI conventions from AGENTS.md apply on the canvas too.** No OS default scrollbars, so don't set `scrollbar-width` or `scrollbar-color` anywhere, and don't let React Flow's stylesheet add either. Tooltips come from `components/ui/tooltip.tsx`, never a `title` attribute. React Flow's stock `Controls` render native `title` hints, so build the canvas controls from our own components.
- Mode toggle and app bar rules: the mode toggle floats at the content area's top-right corner, so canvas controls must not sit under it. Anything clickable in the app-bar band needs `app-region-no-drag`.
- Build config pins in `docs/environment-notes.md` are load-bearing. Read them before adding the dependency.

## Phases

The user agreed to this order:

1. **Fork support in both harnesses.** Fork at a given point, with an access override (read-only for side chats, the parent's access for forks) and the "files may have moved on" note. Set `fork: true` where it works.
2. **Side chats and the map.** The side-chat record and store, the canvas, map-side creation (drag handle and text selection), inline composer and streaming nodes, layout persistence, and deleting.
3. **Side chats from execute mode.** The text-selection menu, and the right-panel side-chat tab, which branches from the latest reply.
4. **Forks.** "Fork from here" on replies and on your own messages (with the composer pre-filled), forking a side chat into a full conversation, lineage in the sidebar, and the divider in execute mode.

## Left to the builder

- Exactly how Claude side chats are made read-only, as long as the agent's own machinery refuses writes.
- Whether Claude's fork history records its parent. If it doesn't, Fractal's store records the lineage for forks made in Fractal. Forks made outside Fractal show lineage only when the native history carries it, for example Codex's `Thread.forkedFromId`.
- Which native message or turn id is the branch point for each provider (Claude's `upToMessageId` / `resumeSessionAt` UUID, Codex's `lastTurnId`), and the edge cases the Claude SDK documents for `resumeSessionAt`.
- Grid size, default node size, how many lines Preview shows, zoom limits, and the exact automatic layout.
- How the right-panel side-chat tab reuses the execute-mode conversation view.

## Verification

Run the tests, lint and typecheck (`pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`). These are behavior changes, so also drive the real app (`pnpm start`) for each phase, with real Claude and Codex conversations:
- Start a side chat each of the four ways.
- Confirm a side chat refuses a write.
- Send from an on-canvas node and watch the reply stream in.
- Delete a side chat and confirm it's gone from both the map and the sidebar.
- Fork from an earlier message and check the sidebar nesting and the divider.
