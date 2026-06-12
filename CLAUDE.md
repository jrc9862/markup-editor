# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Markup — Google Docs for Markdown

Real-time multiplayer editing on plain `.md` files. The thing you collaborate
on in the browser is the actual file in your repo: a two-way CLI keeps the
browser, your file system, and git in sync with no copy-paste tax.

**Agents are a first-class audience, not an afterthought.** Markdown is the
language people use to brief AI agents (CLAUDE.md, AGENTS.md, READMEs), so
agents are designed-in collaborators: every human capability has a plain-REST
equivalent (see "Agent surface" below), locations can be addressed by quoting
text instead of computing offsets, and suggestions are the agent-native write
mode — an agent proposes, a human accepts, and the change lands in the real
file. When adding any new capability, ship the agent path with the human path.

## Architecture (the one idea that matters)

**The canonical document is the raw markdown string, held in a Yjs `Y.Text`
named `content`.** Everything else is a view of it:

- **Source mode** (CodeMirror 6) binds directly to the `Y.Text` via
  `y-codemirror.next` — byte-perfect, true char-level CRDT merging. This is
  the robust path and what guarantees clean git diffs.
- **Rendered mode** (TipTap) is a *projection*: remote `Y.Text` changes are
  re-parsed into the ProseMirror doc; local WYSIWYG edits are serialized back
  to markdown and minimal-diffed into the `Y.Text`.
- **The CLI daemon** is just another peer: disk changes are minimal-diffed
  into the `Y.Text`, and `Y.Text` changes are written back to the file.

The keystone utility is `applyStringToYText()` in
`packages/sync-core/src/ytext.ts` — it reconciles a `Y.Text` to a target
string using minimal char-level ops (via diff-match-patch) in one transaction,
so full-string writers (disk, WYSIWYG serializer) still merge cleanly with
concurrent peers instead of clobbering them. Transaction **origins** are how
each writer ignores the echo of its own edits; always tag writes with an
origin and check it in observers.

**Comments and suggestions** (`packages/sync-core/src/annotations.ts`) live in
the *same* Y.Doc as the text (`Y.Array`s named `comments` / `suggestions`), so
they sync, resolve, and persist exactly like edits. Ranges are anchored with
`Y.RelativePosition` (encoded base64 in `anchorStart`/`anchorEnd`), which
follows the anchored text through concurrent edits; `resolveAnchor()` returns
`null` when the text was deleted. Rendered-mode selections are translated to
markdown offsets with `mapOffsetThroughDiff()` (`sync-core/src/diff.ts`):
diff the rendered plain text against the markdown source and walk it —
syntax appears as source-only runs, skipped with directional bias so a
selection of "world" in `**world**` maps to exactly `world`. Suggestions are GitHub-style proposed
replacements (select range → propose text → accept/reject), not
keystroke-level tracked typing; `acceptSuggestion()` resolves anchors at
accept time and applies the replacement to the Y.Text. The CLI ignores these
fields entirely — it only mirrors `content` to disk, so annotations never
pollute the .md file.

**Edit history** is server-side: `onStoreDocument` snapshots the markdown into
`doc_versions` (debounced in `MetaStore.maybeAddVersion`, ≥60s apart and only
on change). REST: `GET .../versions`, `GET .../versions/:id`,
`POST .../restore` — restore reconciles the live doc via `applyStringToYText`,
so it propagates to all clients (and the CLI daemon writes it to disk) like a
normal edit.

## Layout

```
apps/server/        Hocuspocus WS server + Express REST + SQLite/Postgres persistence
apps/web/           Next.js editor (source + rendered modes, presence)
packages/sync-core/ applyStringToYText, shared types, presence helpers
packages/cli/       `markup` CLI: open/sync/status + two-way disk daemon
```

- One document = one Yjs room; `docId` (uuid) is the room name and URL slug.
- The CLI records `path -> docId` in a repo-local `.markup/manifest.json`.
- Storage is selected by `DATABASE_URL`: when set, Postgres holds both Yjs
  state (`documents` table via the Hocuspocus Database extension) and doc
  metadata (`apps/server/src/db-postgres.ts`, ordered migrations under an
  advisory lock). When unset (zero-setup local dev), SQLite: Yjs updates in
  `markup-docs.sqlite` (Hocuspocus SQLite extension), metadata in
  `markup-meta.sqlite` (`apps/server/src/db.ts`). Both meta stores implement
  the async `MetaStore` interface in `db.ts`. `docker-compose.yml` provides a
  local Postgres; CI runs the server tests against a Postgres service
  container (the Postgres half of the suite skips when `DATABASE_URL` is
  unset).

## Agent surface (REST)

Everything in the UI is reachable with curl + the bearer token; routes operate
on the live Y.Doc through a server-side direct connection, so agent actions
reach every connected human (and the CLI daemon → disk) in realtime:

- `GET /api/docs` · `GET /api/docs/:id` · `GET /api/docs/:id/snapshot`
- `PUT /api/docs/:id/content` `{content}` — direct write (minimal-diffed)
- `GET|POST /api/docs/:id/comments` · `POST .../comments/:tid/replies` ·
  `POST .../comments/:tid/resolve`
- `GET|POST /api/docs/:id/suggestions` · `POST .../suggestions/:sid/accept` ·
  `POST .../suggestions/:sid/reject`
- `GET .../versions` · `GET .../versions/:vid` · `POST .../restore`

Range-taking routes accept `{from,to}` offsets **or** `{anchorText,
occurrence?}` — quote the text you mean, the server finds it. Suggestion
creation derives `original` server-side from the resolved range.

## Commands

```bash
npm install
npm run dev:server     # ws + REST on :4000 (tsx watch)
npm run dev:web        # editor UI on :3000 (next dev)
npm run cli -- open path/to/file.md   # or: npx tsx packages/cli/src/index.ts open ...
npm test               # all unit tests (vitest, in sync-core)
npm run build          # build every workspace

# Single test file / single test (script is `vitest run`, args append):
npm run test --workspace @markup/sync-core -- src/ytext.test.ts
npm run test --workspace @markup/sync-core -- -t "accepts a suggestion"

# Type-check without emitting (no lint setup; tsc is the checker):
npx tsc -p packages/sync-core/tsconfig.json --noEmit
npx tsc -p packages/cli/tsconfig.json --noEmit
npx tsc -p apps/server/tsconfig.json --noEmit
cd apps/web && npx tsc -p tsconfig.json --noEmit

# Add a dependency to one workspace (never bare `npm install <pkg>` at root):
npm install --workspace @markup/web <pkg>

# Production stack: Postgres + server + web as Docker images (compose `app`
# profile; Dockerfiles in apps/server and apps/web, built from repo root):
docker compose --profile app up -d --build
```

To exercise a full end-to-end loop: start server + web, then
`markup open /tmp/somewhere/test.md --no-browser` and open the printed URL in
two tabs; edits must converge in both tabs *and* the file on disk. The REST
agent surface can be smoke-tested with curl + `Authorization: Bearer dev-token`.

Auth is a single shared bearer token for now: `MARKUP_TOKEN` (default
`dev-token`) on server and CLI, `NEXT_PUBLIC_MARKUP_TOKEN` on web. Other env:
`PORT`, `MARKUP_DATA_DIR`, `DATABASE_URL` (server — Postgres when set, SQLite
otherwise); `MARKUP_SERVER`, `MARKUP_WEB` (CLI); `NEXT_PUBLIC_MARKUP_SERVER`
(web). `NEXT_PUBLIC_*` values are inlined into the web bundle at **build
time** — for a deployed web image they are Docker build args, not runtime env.
The web app builds with `output: 'standalone'`; its Docker image runs the
traced server (`node apps/web/server.js`), and the server image runs
`node apps/server/dist/index.js` with graceful SIGTERM shutdown (flushes
`onStoreDocument` via `hocuspocus.destroy()` before exit). CI builds both
images on every push.

## Gotchas (learned the hard way)

- **`next build` clobbers a running dev server.** Both write `apps/web/.next`;
  building while `next dev` runs leaves the dev server 500ing with
  MODULE_NOT_FOUND. Rely on `tsc --noEmit` + the dev compiler during work, or
  restart `next dev` (rm -rf .next) after a production build.
- **TipTap must stay on v2.** Bare `npm install @tiptap/extension-*` resolves
  v3, which peer-conflicts with `@tiptap/core@2` / `tiptap-markdown`. Always
  pin `@^2`.
- **Yjs provider lifecycle lives inside one `useEffect`** (see `Editor.tsx`).
  Creating the HocuspocusProvider in `useMemo` and destroying it in an effect
  cleanup breaks under React 18 StrictMode's dev double-mount: the remount
  re-attaches listeners to a destroyed provider and the doc never syncs.
- **Schema changes are additive migrations** — local/production databases
  persist across restarts, so never assume a fresh schema. SQLite:
  `SqliteMetaStore.init()` (`PRAGMA table_info` guard + `ALTER TABLE ADD
  COLUMN`). Postgres: append a new entry to the `MIGRATIONS` array in
  `db-postgres.ts`; never edit a shipped entry.
- CI (GitHub Actions, `.github/workflows/ci.yml`) runs build, tests, and
  per-workspace `tsc --noEmit` on every push/PR to `main`.

## Conventions

- npm workspaces; packages are ESM (`"type": "module"`), TS strict, built with
  `tsc` (web uses Next's compiler).
- `sync-core` stays dependency-light (yjs + diff-match-patch only) — it is
  shared by server, web, and CLI. Editor-specific code (ProseMirror, TipTap,
  CodeMirror) lives in `apps/web`.
- Markdown serialization in rendered mode must stay deterministic — config
  lives in `RenderedEditor.tsx` (`tiptap-markdown`); don't change list/marker
  options casually, it reflows users' files and pollutes git diffs.

## UI conventions (apps/web)

Google-Docs layout with a terminal aesthetic: dark slate-grey theme
throughout (darkest-slate chrome topbar, slate canvas, slightly lighter
centered "page"), straight edges everywhere (no border-radius — keep it that
way), mono accents (CSS vars in `globals.css`).

- **Floating comments** (`FloatingAnnotations.tsx`): cards live in a margin
  gutter right of the page, vertically aligned with their anchored text and
  pushed down to avoid overlap (two-pass measure in `useLayoutEffect`).
  Position comes from the active editor's `measurer.topOfOffset(mdOffset)`
  (`EditorHandle` in `format.ts`) — CodeMirror uses `lineBlockAt`+
  `documentTop`, TipTap maps md→plain→PM pos (binary search on `textBetween`
  length) then `coordsAtPos`. Cards collapse/expand; composers float too.
- **Inline suggestions**: in source mode, open suggestions render in the text
  flow — strikethrough mark over the original + a widget with the proposed
  text and ✓/✕ buttons (`suggestionField` in `SourceEditor.tsx`). In rendered
  mode the range is highlighted inline (see below) and the accept/reject UI
  lives in the floating cards.
- **Realtime suggesting mode** (`suggestMode.ts` + toolbar toggle): an
  Editing/Suggesting toggle (source mode only). While Suggesting, a CodeMirror
  `transactionFilter` intercepts user `input`/`delete` transactions, drops the
  doc change, and folds the edit into a suggestion object instead — the same
  objects select-and-propose and the REST surface create. A local "session"
  ({suggestion id, caret-in-proposed}) coalesces a run of keystrokes into one
  reviewable suggestion: typing splices into `proposed`, backspace un-types
  pending proposed text before widening into a real deletion, moving the
  cursor away starts a new suggestion, fully-un-typed suggestions are removed.
  `updateSuggestion()` (sync-core) re-anchors and refreshes `original` from
  the live text. Remote Yjs transactions pass through untouched (they are not
  user events), so sync keeps working while suggesting.
- **Rendered-mode annotation highlights** (`annotationsPlugin` in
  `RenderedEditor.tsx`): comment/open-suggestion ranges render as PM inline
  decorations (md→plain→PM, the inverse of the selection mapping); fresh sets
  are pushed via `setMeta` on every snapshot refresh and mapped through local
  edits in between. Jumping from a floating card scrolls/selects in place in
  either mode (`focusRange` prop on both editors).
- **Remote cursors** are terminal-style blinking blocks in both modes. Source
  mode is y-codemirror.next's awareness cursors (restyled via
  `.cm-ySelectionCaret`). Rendered mode publishes/consumes the *same*
  awareness `cursor` field (Y.RelativePosition anchor/head on the canonical
  Y.Text, mapped md→plain→PM), so presence is cross-mode: source-mode peers
  see rendered-mode carets and vice versa.
- **History** (`HistoryPanel.tsx`): togglable right panel from the topbar.
- **Toolbar** (`Toolbar.tsx`): formatting for non-technical users — heading
  select, bold/italic/underline, inline code, code block, quote, list, HR,
  insert table (rows×cols popover). Both modes implement `FormatTarget`
  (`format.ts`): source rewrites markdown text in CodeMirror, rendered drives
  TipTap commands. Underline emits inline HTML `<u>` (markdown has none), so
  the tiptap-markdown serializer runs with `html: true`.
- Components take plain-data snapshots (`snapshotComments`/
  `snapshotSuggestions`, refreshed on every `ydoc.on('update')`) — never hand
  Y types to React state. Floating-card layout recomputes via a debounced
  `layoutTick` counter bumped on doc updates and window resize.

## Known soft spots (MVP trade-offs)

- Rendered-mode cursor preservation across remote re-parses is best-effort
  (clamped text offset). Source mode is the guaranteed-robust path.
- Rendered mode normalizes markdown it touches (that's inherent to
  WYSIWYG-over-text); source mode and CLI never reflow anything.
- Rendered-mode selection→offset mapping is diff-based and heuristic: exact
  for normal prose, but a selection of text that repeats verbatim elsewhere
  in syntax-heavy surroundings can land slightly off. Source mode is exact.
- Realtime suggesting intercepts plain typing/deleting; IME composition and
  exotic input paths fall back to direct edits. The coalescing session is
  local to one editor instance (two devices suggesting the same spot create
  two suggestions — which is also the correct review granularity).
- `markup open` startup reconciliation: server state wins for an
  already-mapped doc; brand-new docs are seeded from the file.
- Restoring an old version doesn't remap comment anchors created after that
  version; anchors whose text disappears show "(referenced text was deleted)".

## Roadmap (not yet built)

1. **Multi-edits** — batch find/replace and multi-range operations that apply
   as one undoable transaction.
2. **Accounts & sharing permissions** — real user accounts (email/OAuth
   sign-in, persistent identity replacing the localStorage guest name),
   per-doc sharing: owner/editor/suggester/commenter/viewer roles, share
   links with role baked in, workspace-level membership, and CLI auth via
   per-user API tokens (replaces the single shared `MARKUP_TOKEN`).
   Enforcement lives server-side: Hocuspocus `onAuthenticate` resolves
   identity + role and read-only connections reject writes.
3. **Git-native flows** — commit/branch from the UI, PR-style review of
   suggestion batches.
4. **Conflict-free offline `sync`** — persist the CLI's Yjs state vector in
   `.markup/` so offline edits three-way-merge instead of server-wins.
5. **Named versions + per-author attribution** in history.
6. **MCP server** — wrap the agent REST surface in an MCP server
   (`markup-mcp`) so Claude Code / other agents get native tools
   (read_doc, comment, suggest, accept, list_docs) without hand-rolled curl.
7. **Agent identity & events** — distinguish agent principals from humans
   (presence badges, per-agent tokens), plus webhooks/SSE so agents can
   subscribe to mentions, new comments, or suggestion reviews instead of
   polling.
8. **Realtime suggesting in rendered mode** — the Suggesting toggle currently
   covers source mode only; rendered mode needs the equivalent interception
   at the ProseMirror transaction level.

Shipped from the original roadmap: togglable realtime suggestion mode
(source), in-rendered-view annotation highlights, cross-mode presence
(terminal-style remote cursors in both modes).
