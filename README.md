# Ditto CLI

`@heyditto/cli` — save, search, fetch, and traverse the [Ditto](https://heyditto.ai) memory graph from the shell.

```bash
npm install -g @heyditto/cli
heyditto init --agent --json

heyditto save "I prefer TypeScript over JS for new projects"
heyditto search "language preferences"
heyditto fetch <id> --memory-format outline
heyditto subjects "memory architecture" --top-k 5
```

## Install

```bash
npm install -g @heyditto/cli
# or one-shot via npx
npx -y @heyditto/cli search "what did I say about X"
```

The package installs two equivalent binaries: `ditto` and `heyditto`. They run the same CLI — use whichever you prefer. We recommend **`heyditto`** on macOS because Apple ships `/usr/bin/ditto` (a file-copy utility) that can shadow the npm CLI.

### macOS: name collision with Apple's `/usr/bin/ditto`

On macOS, Apple ships `/usr/bin/ditto` (a file-copy utility). On a default `PATH` that puts `/usr/bin` ahead of `/opt/homebrew/bin`, plain `ditto` will run Apple's tool instead of this one — which produces confusing errors like `unrecognized option '--output'`.

Two ways to disambiguate:

```bash
# 1. Use the alias bin shipped by this package:
heyditto status

# 2. Or check which 'ditto' binary your shell resolves first:
type -a ditto
# /usr/bin/ditto                    ← Apple's tool
# /opt/homebrew/bin/ditto           ← @heyditto/cli (use this)
```

You can also reorder your `PATH` so the npm global bin comes before `/usr/bin`, or invoke `@heyditto/cli` directly via its full path.

## Auth

Agents can self-provision without a browser, email, or OTP:

```bash
heyditto init --agent --json
```

The command creates a free claimable agent account, stores the key in
your CLI config directory (defaults to `~/.config/heyditto/cli/config.json`;
override with `DITTO_CONFIG_DIR`), and prints the agent key plus a claim URL.
Humans claim the account later from `claimURL`; agents should share that link,
not the `ditto_mcp_...` API key. The claim token is carried in the query string
(`?t=...`).

For a human-owned key, get one at **https://app.heyditto.ai/mcp/newkey**.

```bash
export DITTO_API_KEY=ditto_mcp_…
# add to ~/.zshrc / ~/.bashrc to persist
```

## Commands

```
heyditto save <content> [--source <s>] [--source-context <c>]
heyditto search <query>... [--include-public] [--filter-username <u>]
heyditto fetch <id>... [--memory-format full|outline|blocks]
heyditto list [--username <u>] [--limit <n>] [--offset <n>] [--source <s>]
heyditto update <id> [--content <text>|--content-file <path>] [--title <t>]
             [--source-context <c>] [--edits-json <json>|--edits-file <path>]
             [--base-revision <n>]
heyditto publish <id> [--title <t>] [--privacy-mode <mode>]
heyditto unpublish (--memory-id <id>|--share-id <id>|<id>)
heyditto subjects <query> [--top-k <n>]
heyditto memories <subject-id>... [--query <q>]
heyditto network <pair-id> [--limit <n>]
heyditto init --agent [--agent-caller <name>] [--json]
heyditto status
heyditto config
heyditto help
```

### `save`

Persist a memory pair from an external source.

```bash
heyditto save "Project X uses Bun + SolidJS, deployed to Cloud Run"
heyditto save "$(cat note.md)" --source document --source-context note.md
```

### `search`

Semantic search across memories. Multiple positional args become an array of queries.
Use `--include-public` to also search public DittoHub memories, optionally scoped
with `--filter-username <u>`.

```bash
heyditto search "typescript preferences"
heyditto search "typescript" "language choices"
heyditto search "launch notes" --include-public --filter-username peyton
```

### `fetch`

Fetch memory content for private pair ids or public share ids. The default
`--memory-format full` returns the full body. Use `outline` to get stable block
ids before a structured `update`, or `blocks` when you need each block body.

```bash
heyditto fetch 3a1084ae-235a-433d-9493-2335a0dfeb57
heyditto fetch 3a1084ae-235a-433d-9493-2335a0dfeb57 --memory-format outline --output json
```

### `list`

List saved memories, or public DittoHub publishes for a username.

```bash
heyditto list --limit 10
heyditto list --username peyton --limit 10 --output json
```

### `update`

Edit a saved memory in place. Replace the full body with `--content` or
`--content-file`, or use block edits after fetching `--memory-format outline`.
Block edits require the current revision returned by `save` or a previous
`update`.

```bash
heyditto update <memory-id> --content-file revised.md --output json
heyditto fetch <memory-id> --memory-format outline --output json
heyditto update <memory-id> \
  --edits-json '[{"op":"replace_text","blockId":"2","find":"old","replace":"new","expectedCount":1}]' \
  --base-revision 3 \
  --output json
```

### `publish` / `unpublish`

Publish a saved memory to the user's public DittoHub profile, or disable an
existing share without deleting the private memory.

```bash
heyditto publish <memory-id> --title "Launch notes" --privacy-mode scan_and_block --output json
heyditto unpublish --share-id abc123def4 --output json
```

### `subjects`

Search the subject (topic) graph. Returns subject ids you can pass to `memories` or `network`.

```bash
heyditto subjects "memory architecture"
heyditto subjects "performance" --top-k 5
```

### `memories`

Fetch memory previews scoped to specific subjects.

```bash
heyditto memories <subject-id>
heyditto memories <subject-id> --query "deployment tradeoffs"
```

### `network`

Traverse a memory's network (related memories via shared subjects).

```bash
heyditto network <pair-id> --limit 30
```

### `status`

Print whether `DITTO_API_KEY` is set and the configured MCP endpoint resolves.

### `init --agent`

Create a free claimable agent account and save its key locally. Use `--json` for
machine-readable output that includes `apiKey`, `userID`, and `claimURL`.
Share `claimURL` with the human owner; keep `apiKey` local to the agent. The
claim URL uses a `?t=...` query parameter.

### `config`

Print a Claude Desktop / Cursor / generic-MCP-client config snippet for the Ditto memory server.

## Environment

- `DITTO_API_KEY` (optional) — MCP API key override. Agents can instead run `heyditto init --agent --json` for no-human setup.
- `DITTO_API_BASE` (optional) — API base URL. Defaults to `https://api.heyditto.ai`. Useful for local dev (`http://localhost:3400`).

## Output

Every data command and `status` accepts `--output <format>`, where `<format>` is one of:

- `json` — guaranteed structured JSON (parses the server text block, re-emits pretty-printed JSON).
- `text` — the server's text block as-is (the default; for data commands this is already JSON).
- `markdown` — same as `text`; reserved for future markdown rendering.
- `raw` — the full MCP response envelope as JSON.

```bash
heyditto search "X" --output json | jq '.results[] | {id, similarity, preview: .userPreview}'
heyditto status --output json | jq '.tools'
```

## Related

- **[`@heyditto/mcp`](https://github.com/ditto-assistant/ditto-mcp)** — local stdio MCP bridge with OAuth (different surface; pair with Claude Desktop / Cursor).
- **[ditto-clawhub](https://github.com/ditto-assistant/ditto-clawhub)** — the ClawHub / OpenClaw skill that ships alongside this CLI.
- **Web app:** https://app.heyditto.ai

## Development

```bash
just install
just check       # tsc --noEmit
just build       # tsc to dist/
just verify      # check + build + pack --dry-run
```

Releases are automated via [semantic-release](https://github.com/semantic-release/semantic-release) on push to `main`. npm provenance is enabled — every published version is signed by the GitHub Actions OIDC identity. Trusted publishing is configured at the npm registry.

## License

MIT — see [LICENSE](LICENSE).
