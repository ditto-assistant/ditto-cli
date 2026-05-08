# Ditto CLI

`@heyditto/cli` — save, search, fetch, and traverse the [Ditto](https://heyditto.ai) memory graph from the shell.

```bash
npm install -g @heyditto/cli
export DITTO_API_KEY=ditto_mcp_…   # https://app.heyditto.ai/connect/openclaw

ditto save "I prefer TypeScript over JS for new projects"
ditto search "language preferences"
ditto subjects "memory architecture" --top-k 5
```

## Install

```bash
npm install -g @heyditto/cli
# or one-shot via npx
npx -y @heyditto/cli search "what did I say about X"
```

## Auth

Set `DITTO_API_KEY` in your environment. Get a key at **https://app.heyditto.ai/connect/openclaw**.

```bash
export DITTO_API_KEY=ditto_mcp_…
# add to ~/.zshrc / ~/.bashrc to persist
```

## Commands

```
ditto save <content> [--source <s>] [--source-context <c>]
ditto search <query>...
ditto fetch <pair-id>...
ditto subjects <query> [--top-k <n>]
ditto memories <subject-id>...
ditto network <pair-id> [--limit <n>]
ditto status
ditto config
ditto help
```

### `save`

Persist a memory pair from an external source.

```bash
ditto save "Project X uses Bun + SolidJS, deployed to Cloud Run"
ditto save "$(cat note.md)" --source document --source-context note.md
```

### `search`

Semantic search across memories. Multiple positional args become an array of queries.

```bash
ditto search "typescript preferences"
ditto search "typescript" "language choices"
```

### `fetch`

Fetch the full conversation text for memory pair ids (output of `search`).

```bash
ditto fetch 3a1084ae-235a-433d-9493-2335a0dfeb57
```

### `subjects`

Search the subject (topic) graph. Returns subject ids you can pass to `memories` or `network`.

```bash
ditto subjects "memory architecture"
ditto subjects "performance" --top-k 5
```

### `memories`

Fetch memory previews scoped to specific subjects.

```bash
ditto memories <subject-id>
```

### `network`

Traverse a memory's network (related memories via shared subjects).

```bash
ditto network <pair-id> --limit 30
```

### `status`

Print whether `DITTO_API_KEY` is set and the configured MCP endpoint resolves.

### `config`

Print a Claude Desktop / Cursor / generic-MCP-client config snippet for the Ditto memory server.

## Environment

- `DITTO_API_KEY` (required) — MCP API key. https://app.heyditto.ai/connect/openclaw
- `DITTO_API_BASE` (optional) — API base URL. Defaults to `https://api.heyditto.ai`. Useful for local dev (`http://localhost:3400`).

## Output

Defaults to JSON. Pipe through `jq` for filtering:

```bash
ditto search "X" | jq '.results[] | {id, similarity, preview: .userPreview}'
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
