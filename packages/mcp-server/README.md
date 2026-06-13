# @markup/mcp

An [MCP](https://modelcontextprotocol.io) server that exposes the Markup agent
REST surface as native tools, so Claude Code and other MCP clients can read
docs, comment, and propose suggestions without hand-rolled curl.

It is a thin wrapper over `apps/server`'s REST API (see the "Agent surface"
section of the repo `CLAUDE.md`): each tool is one route, called over a bearer
token. **The server enforces token scope and per-doc role**, so the
agent-native default is a `suggest`-scoped token — propose, never write.

## Configuration (env)

| Var             | Default                  | Meaning                                         |
| --------------- | ------------------------ | ----------------------------------------------- |
| `MARKUP_SERVER` | `http://localhost:4000`  | Base URL of the markup REST API.                |
| `MARKUP_TOKEN`  | `dev-token`              | Bearer token: an `mkp_` API token or the legacy shared token. |
| `MARKUP_AUTHOR` | _(unset)_                | Fallback display name on comments/suggestions, used **only** with the legacy shared token (signed-in users and per-agent tokens are attributed server-side). |

## Tools

Discovery: `whoami`, `list_docs`, `get_doc`, `read_doc`, `list_versions`.
Comments: `list_comments`, `add_comment`, `reply_comment`, `resolve_comment`.
Suggestions: `list_suggestions`, `suggest`, `update_suggestion`,
`withdraw_suggestion`, `accept_suggestion`, `reject_suggestion`,
`reply_suggestion`. Write (needs write capability): `write_doc`.

Range-taking tools (`add_comment`, `suggest`) accept either character offsets
(`from`/`to`) or a quoted `anchorText` (+ optional 1-based `occurrence`) —
quote the text you mean and the server finds it.

## Run

```bash
# build, then point an MCP client at the binary:
npm run build --workspace @markup/mcp

# stdio MCP server (Claude Code config example):
#   command: node
#   args:    ["packages/mcp-server/dist/index.js"]
#   env:     { "MARKUP_SERVER": "...", "MARKUP_TOKEN": "mkp_..." }

# or run from source during development:
npm run start --workspace @markup/mcp
```
