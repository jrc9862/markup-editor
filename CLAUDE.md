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
                    (auth.ts principals/roles, oidc.ts, auth-routes.ts sign-in/tokens)
apps/web/           Next.js editor (source + rendered modes, presence)
packages/sync-core/ applyStringToYText, shared types, presence helpers
packages/cli/       `markup` CLI: open/sync/status + two-way disk daemon
packages/mcp-server/ `markup-mcp`: stdio MCP server over the agent REST surface
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
- `PATCH /api/docs/:id` `{name?,path?}` — rename/re-path (write; `markup mv`
  and the UI use this; path is sanitized — no leading slash / `..`)
- `PUT /api/docs/:id/content` `{content}` — direct write (minimal-diffed)
- `POST /api/docs/:id/edits` — multi-edits as ONE transaction: either
  `{find,replace,regex?,caseSensitive?}` or `{edits:[{from,to,insert}]}`
- `GET|POST /api/docs/:id/comments` · `POST .../comments/:tid/replies` ·
  `POST .../comments/:tid/resolve`
- `GET|POST /api/docs/:id/suggestions` · `PUT|DELETE .../suggestions/:sid`
  (author revises/withdraws while open; write capability may touch any) ·
  `POST .../suggestions/:sid/accept` · `POST .../suggestions/:sid/reject` ·
  `POST .../suggestions/:sid/replies` (review discussion on a suggestion) ·
  `POST .../suggestions/review` `{accept[],reject[]}` — PR-style batch review
- `GET .../events` — SSE stream of doc events (comments/suggestions/reviews/
  content/`mention`); agents subscribe instead of polling
- `GET .../versions` · `GET .../versions/:vid` · `PUT .../versions/:vid`
  `{name}` (name a version) · `POST .../restore`
- `GET /api/me` · `GET|POST /api/tokens` · `DELETE /api/tokens/:id`
- `GET|POST /api/docs/:id/permissions` · `DELETE .../permissions/:userId` ·
  `PUT .../permissions/link` (owner only)
- `GET /api/git/status` · `GET /api/git/branches` · `POST /api/git/commit`
  `{message,paths?}` · `POST /api/git/branch` `{name,checkout?}` ·
  `POST /api/git/checkout` `{name}` — only when `MARKUP_REPO_DIR` is set (404
  otherwise); git args passed as arrays (no shell)

Suggestion creation accepts an optional caller-supplied `id` (409 on
duplicate) — this is how optimistic clients reconcile the server echo.

Agents should run on a scoped API token (`suggest` is the agent-native
default: propose, never write); the route's required scope is enforced
server-side.

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

Auth (Phase 1, see PHASE1_IDENTITY.md): three principal kinds — session
cookie (signed-in human; OIDC via `OIDC_ISSUER`/`OIDC_CLIENT_ID`/
`OIDC_CLIENT_SECRET`, or zero-setup dev sign-in `POST /auth/dev` when OIDC is
unset), `mkp_`-prefixed API tokens (per-user/per-agent, scoped
read<comment<suggest<write, managed via `/api/tokens`, hashes only in DB —
this is also CLI auth: set `MARKUP_TOKEN=mkp_...`), and the legacy shared
`MARKUP_TOKEN` (default `dev-token`, full access unless `MARKUP_REQUIRE_AUTH=1`).
Scope checks guard every REST route (`needs()` in `index.ts`). Per-doc roles
(milestone 2): docs carry `owner_id` + `link_role` and a `doc_acl` table maps
user→role (owner/editor/suggester/commenter/viewer; 'none' link role =
private). Effective capability = weaker of token scope and doc role
(`docAccess()` per route); owners manage grants via
`GET|POST /api/docs/:id/permissions`, `DELETE .../permissions/:userId`,
`PUT .../permissions/link`. WS connections below write capability are
read-only (Hocuspocus drops their updates); suggester/commenter act through
REST. Permission changes take effect live: the server closes the doc's WS
connections (`closeConnections(docId)`), providers reconnect and re-resolve
the role, and the web client refetches `myRole` on every `synced` event
(revoked users land on an access-revoked screen). `MARKUP_REQUIRE_AUTH=1` disables the legacy shared token entirely.
Legacy principals and pre-identity (unowned) docs behave as before: full
access, open collaboration. Signed-in humans are stamped with real name + `authorId` on
comments/suggestions; self-reported names are ignored. Web uses
`NEXT_PUBLIC_MARKUP_TOKEN` as fallback plus the session cookie
(`credentials: 'include'`; CORS locked to `MARKUP_WEB_ORIGIN`, default
`http://localhost:3000`). Other env:
`PORT`, `MARKUP_DATA_DIR`, `DATABASE_URL` (server — Postgres when set, SQLite
otherwise), `MARKUP_REPO_DIR` (server — enables the git-native flow routes
against that working tree; unset = those routes 404); `MARKUP_SERVER`,
`MARKUP_WEB` (CLI); `NEXT_PUBLIC_MARKUP_SERVER`
(web). Phase 2 observability/limits env (all optional, sane defaults):
`LOG_LEVEL` (default `info`), `LOG_PRETTY` (`0` forces JSON outside
production), `MARKUP_METRICS_TOKEN` (when set, `GET /metrics` requires that
bearer), `MARKUP_RATE_WINDOW_MS`/`MARKUP_RATE_MAX` (`/api`+`/auth` rate limit,
per-principal else per-IP; `MARKUP_RATE_MAX=0` disables), `MARKUP_MAX_DOC_BYTES`
(reject content-growing writes over this, default 2 MB; `0` disables),
`MARKUP_MAX_CONNECTIONS_PER_USER` (WS cap per authenticated principal, default
20; `0` = unlimited), `MARKUP_VERSION_RETENTION_MAX` (max `doc_versions`
snapshots kept per doc, default 500; `0` disables the count cap) /
`MARKUP_VERSION_RETENTION_DAYS` (prune versions older than N days, default `0`
= off) — retention never drops a user-named version or a doc's most-recent
snapshot, and runs after each new snapshot plus a one-shot startup sweep.
Phase 2 multi-node env (optional): `REDIS_URL` (when set, enables the
cross-node layer — Hocuspocus Redis extension for Yjs/awareness fan-out, the
`docEvents` SSE bus bridged onto Redis pub/sub, and the `lastEditor`
attribution store moved into Redis; unset = single-node in-process, unchanged)
and `MARKUP_TRUST_PROXY` (trusted reverse-proxy hop count, default `0`; `>0`
makes Express derive the real client IP from `X-Forwarded-For` so rate limiting
keys per client behind the LB). See `apps/server/src/redis.ts`,
`docker-compose.scale.yml`, `deploy/nginx.conf`.
`NEXT_PUBLIC_*` values are inlined into the web bundle at
**build time** — for a deployed web image they are Docker build args, not
runtime env.
The web app builds with `output: 'standalone'`; its Docker image runs the
traced server (`node apps/web/server.js`), and the server image runs
`node apps/server/dist/index.js` with graceful SIGTERM shutdown (flushes
`onStoreDocument` via `hocuspocus.destroy()` before exit). CI builds both
images on every push. Observability (Phase 2, `apps/server/src/{logger,
metrics,connections,limits}.ts`): pino structured logs (`pino-http` stamps
each request with the resolved principal), Prometheus `GET /metrics`
(`markup_*` series: ws connections, docs loaded, update throughput,
persistence + REST latency histograms), and a liveness/readiness split —
`/healthz` = process up, `/readyz` = `MetaStore.ping()` ok and not shutting
down (so the LB drains a node before its connections close; compose's `server`
healthcheck probes it).

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
- **Suggestions** float as review cards in *both* modes (author, original →
  proposed, time, accept/reject for write capability, and a comment thread —
  `replies` on the suggestion, `addSuggestionReply` in sync-core). The only
  inline rendering is display: in source mode a strikethrough mark over the
  original + the proposed text (`suggestionField` in `SourceEditor.tsx`); in
  rendered mode a strikethrough range highlight plus a green proposed-text
  widget (`pm-suggestion-proposed`) at the range end / insertion point. No
  inline accept/reject buttons.
- **Realtime suggesting mode** (`suggestMode.ts` + toolbar toggle): an
  Editing/Suggesting toggle, available in **both** modes. While Suggesting, a
  user edit never touches the doc — it is intercepted and folded into a
  suggestion object instead (the same objects select-and-propose and the REST
  surface create). Source mode uses a CodeMirror `transactionFilter` on
  `input`/`delete` transactions; rendered mode uses a ProseMirror plugin
  `filterTransaction` that vetoes the edit, serializes the *would-be* doc to
  markdown (`editor.storage.markdown.serializer`), and diffs it against the
  current markdown (`singleRegionDiff`) to recover the change in markdown
  coordinates. Both feed the shared `recordSuggestionEdit`/`recordRenderedEdit`
  coalescer. A local "session" ({suggestion id, caret-in-proposed}) coalesces a
  run of keystrokes into one reviewable suggestion: typing splices into
  `proposed`, backspace un-types pending proposed text before widening into a
  real deletion, moving the cursor away starts a new suggestion, fully-un-typed
  suggestions are removed. Toolbar formatting routes through the same path
  (source tags dispatches `userEvent: 'input.format'`; rendered's TipTap
  commands are vetoed and serialized like any edit); a multi-range change
  becomes one discrete suggestion covering the whole span. Remote transactions
  pass through untouched (source: not user events; rendered: guarded by the
  `applyingRemote` flag), so sync keeps working while suggesting.
- **Suggestion stores** (`SuggestionStore` in `suggestMode.ts`): intercepted
  edits land in a store. Editors write straight into the shared Y.Doc
  (`localStore` in `Editor.tsx`). The **suggester role is an editor locked
  into Suggesting**: its WS connection is read-only, so its store
  (`restStore`) keeps an optimistic local overlay (merged into the
  `suggestions` prop) and syncs through REST — create with a client-supplied
  id, debounced `PUT` updates, `DELETE` on un-type — reconciling the overlay
  when the server echo arrives over the wire.
- **Rendered-mode annotation highlights** (`annotationsPlugin` in
  `RenderedEditor.tsx`): comment ranges and open-suggestion ranges render as PM
  inline decorations (md→plain→PM, the inverse of the selection mapping), and
  each open suggestion also gets a proposed-text widget at its range end (or,
  for a zero-width insertion, at the insertion point); fresh sets are pushed via
  `setMeta` on every snapshot refresh and mapped through local edits in between. Jumping from a floating card scrolls/selects in place in
  either mode (`focusRange` prop on both editors).
- **Remote presence** is rendered by our own code in both modes (yCollab gets
  `null` awareness — y-codemirror's built-in cursors are not used). Both
  modes publish/consume the same awareness `cursor` field (Y.RelativePosition
  anchor/head on the canonical Y.Text; rendered mode maps md→plain→PM), so
  presence is cross-mode. Rendering rule: a peer with a non-empty selection
  shows only the color highlight; the terminal-style blinking caret renders
  only for an empty selection.
- **Cursor-in-range highlight**: both editors report the cursor head as a
  markdown offset (`onCursorChange`); cards whose anchored range contains it
  get the `active` accent outline (`activeIds` → `FloatingAnnotations`).
- **Sharing UI** (`SharePanel.tsx`): Share popover in the topbar — copy link
  for everyone; owners set the link role and manage per-user grants by email.
  `UserMenu.tsx` handles sign-in/out (dev prompts or OIDC redirect; reloads
  the page on identity change). Restricted users see a role badge; the
  editor is read-only below editor role (commenter/viewer) with
  comment/suggest/reply/resolve going through REST.
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
  exotic input paths fall back to direct edits. The suggester role's
  REST-backed overlay holds plain offsets while a session is active, so
  concurrent remote edits in the same spot can shift a pending suggestion's
  range slightly. Rendered-mode realtime suggesting recovers the edit by
  serializing the vetoed doc to markdown and diffing — exact for prose, but it
  inherits rendered mode's heuristic md↔plain mapping, and a vetoed edit keeps
  the selection (rather than collapsing the caret) so the on-screen highlight
  during a select-then-type run differs cosmetically from source mode; the
  resulting suggestion text is the same. The coalescing session is local to one
  editor instance (two devices suggesting the same spot create two suggestions
  — which is also the correct review granularity).
- `markup open` startup reconciliation: server state wins for an
  already-mapped doc; brand-new docs are seeded from the file.
- Restoring an old version doesn't remap comment anchors created after that
  version; anchors whose text disappears show "(referenced text was deleted)".

## Roadmap (not yet built)

1. **Accounts & sharing permissions** — milestones 1+2 shipped (OIDC/dev
   sign-in, sessions, scoped tokens, attribution, per-doc roles + ACL with
   server-side REST/WS enforcement, MARKUP_REQUIRE_AUTH; see
   PHASE1_IDENTITY.md), plus the role-aware web UI (Share popover, role
   badge, read-only editor below editor role with REST-backed annotations).
   Remaining: workspace membership, SAML/SCIM.
2. **Enterprise Phase 2 (scale/ops)** — observability + self-protection
   limits shipped (structured logs, `/metrics`, `/readyz`, REST rate limiting,
   per-user WS caps, doc byte-size guard); plus history retention + backups
   (`doc_versions` count/age caps that spare named + latest snapshots,
   `scripts/backup.sh` for pg_dump/SQLite `.backup`). Yjs state is a single
   GC'd snapshot per doc (no update log to compact). Plus Redis multi-node
   (gated by `REDIS_URL`): Hocuspocus Redis extension for Yjs/awareness
   fan-out, with the in-process `docEvents` SSE bus and `lastEditor`
   attribution map moved onto Redis (`apps/server/src/redis.ts`), and an LB
   topology in `docker-compose.scale.yml` + `deploy/nginx.conf`. Plus k6 load
   testing (`k6/` — `ws.js` connection-capacity + `rest.js` throughput, sharing
   a minimal Hocuspocus wire codec in `k6/lib/hocuspocus.js`; manual CI in
   `.github/workflows/loadtest.yml`). Phase 2 is complete (see PHASE2_OPS.md).

Shipped from the original roadmap: togglable realtime suggestion mode
(both source and rendered modes), in-rendered-view annotation highlights,
cross-mode presence (terminal-style remote cursors in both modes), the
**MCP server** (`packages/mcp-server` → `markup-mcp`, a stdio wrapper over the
agent REST surface), plus the full user-feature sweep:

- **Multi-edits** — `POST /api/docs/:id/edits` (find/replace or explicit
  ranges) and a web Find & Replace panel, applied as one transaction via
  sync-core `applyEdits`/`findReplaceEdits`.
- **Git-native flows** — server GitBridge (`apps/server/src/git.ts`, gated by
  `MARKUP_REPO_DIR`) with commit/branch/checkout REST + web Git panel, and
  PR-style batch suggestion review (`POST .../suggestions/review` + web Review
  panel).
- **Conflict-free offline sync** — CLI persists each doc's Yjs state under
  `.markup/state/<docId>.bin` (`packages/cli/src/state.ts`) and folds offline
  edits in before connecting, so reconnect CRDT-merges instead of server-wins.
- **Named versions + per-author attribution** — `doc_versions.name/author/
  author_id`, `PUT .../versions/:vid`, attribution captured from the last
  editor (WS context + REST writers) into the history snapshot.
- **Agent identity & events** — server event bus + SSE `GET .../events`
  (comments/suggestions/reviews/content/`mention`), an `agent` flag on events,
  agent presence badges (`PresenceUser.kind`), and MCP `watch_events`.
- **File rename handling** — `PATCH /api/docs/:id`, `markup mv`, click-to-
  rename in the topbar and doc-list tree.
- **Live, grouped history** + **local version preview** — the HistoryPanel
  hot-reloads, groups snapshots into author/burst sessions, and previews a
  version read-only to just the selecting user (no diff, restore is explicit).
