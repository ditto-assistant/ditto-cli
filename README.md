# Ditto CLI

`@heyditto/cli` — save, search, fetch, and traverse the [Ditto](https://heyditto.ai) memory graph from the shell.

```bash
npm install -g @heyditto/cli
heyditto init --name "NAME_OF_AGENT" --json   # the name is set once, here

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

Humans sign in through the browser:

```bash
heyditto login
```

This prints a short code, opens `https://heyditto.ai/device` (pre-filled with the
code), and saves the resulting key to your CLI config directory once you approve
it. Pass a key as an argument (`heyditto login ditto_mcp_…`), pipe it with
`--stdin`, or use `--paste` for the older copy-a-key page.

Agents can self-provision without a browser, email, or OTP:

```bash
heyditto init --json
```

The command creates a free claimable agent account, stores the key in
your CLI config directory (defaults to `~/.config/heyditto/cli/config.json`;
override with `DITTO_CONFIG_DIR`), and prints a claim URL without printing the
agent key. Humans claim the account later from `claimURL`; agents should share
that link. The claim token is carried in the query string (`?t=...`).

### Name the agent at init

Decide the agent's name **before** you run `init` and pass it with `--name`:

```bash
heyditto init --name "NAME_OF_AGENT" --json
```

The caller name is set **once, at account creation**, and it labels everything
the agent saves: after a human claims the account, the agent's memories show up
in the owner's graph as an *external agent thread* titled by this name. If you
init without `--name`, the name defaults to `agent` and every memory is
labeled `agent` — generic and hard to tell apart from other agents.

So: use the agent's own name, or a name the user has already chosen, and set it
up front. Renaming after init is not yet supported from the CLI (it currently
requires backend support — see
[ditto-assistant/backend#1199](https://github.com/ditto-assistant/backend/issues/1199)),
so picking the right name at init avoids a stuck label.

### Humans: sign in through the browser

```bash
heyditto login
```

opens the Ditto web app with a one-time device code (sign in with Google, X, Apple
or GitHub, or create an account), approves it, and hands the key back to the CLI —
nothing to copy. `heyditto claude` / `heyditto codex` run the same flow
automatically on first use, and the web page lets you pick or create the
inference endpoint to launch through, so a fresh machine needs exactly one
command:

```bash
npx @heyditto/cli@latest claude --yolo --worktree
```

You can still paste a key from **https://app.heyditto.ai/mcp/newkey**
(`heyditto login <key>`, `--paste`, or `--stdin`), or set it in the environment:

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
heyditto my-memories [--limit <n>] [--offset <n>] [--source <s>]
heyditto update <id> [--content <text>|--content-file <path>] [--title <t>]
             [--source-context <c>] [--edits-json <json>|--edits-file <path>]
             [--base-revision <n>]
heyditto publish <id> [--title <t>] [--privacy-mode <mode>]
heyditto unpublish (--memory-id <id>|--share-id <id>|<id>)
heyditto delete <memory-id> --confirm
heyditto subjects <query> [--top-k <n>]
heyditto subject-edges <subject-id> [--limit <n>] [--min-weight <n>] [--kg <alias>]
heyditto memories <subject-id>... [--query <q>]
heyditto network <pair-id> [--limit <n>]
heyditto friends
heyditto knowledge-graphs
heyditto graph-sharing (--enable|--disable) [--title <t>] [--description <d>]
heyditto graphs create <name>
heyditto graphs list
heyditto graphs available
heyditto graphs add <@username>
heyditto graphs remove <@username>
heyditto graphs subscribers
heyditto graphs sharing (--enable|--disable) [--title <t>] [--description <d>]
heyditto init [--name <name>] [--subscribe <@graph>]... [<@graph>...] [--json]
heyditto login [<key>] [--paste] [--stdin]
heyditto endpoints [--set-default <slug>] [--clear-default]
heyditto apps list [--company <id>]
heyditto apps create <name> [--gh-secret NAME --repo o/r | --gcp-secret NAME | …]
heyditto apps show|update|oidc|icon set|origins verify|secret rotate|consent set …
heyditto apps endpoints list|attach|billing|detach <app> [<endpoint>]
heyditto receipts [--leg ditto|byok|covered] [--app <app_id>] [--days <n>]
heyditto claude [options] [-- <claude args>]
heyditto codex  [options] [-- <codex args>]
heyditto sessions [--json] [--all]
heyditto sessions rm <id>
heyditto session new [<name>...] [--id <id>]
heyditto session list [--all]
heyditto session use <id>
heyditto session current
heyditto session end
heyditto agents [--output <format>]
heyditto logout
heyditto status [--output <format>]
heyditto config
heyditto help [command]
```

### Help

Use `-h` or `--help` globally or after any command:

```bash
heyditto --help
heyditto search --help
heyditto graphs add --help
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
heyditto my-memories --source cli --limit 10 --output json
```

`my-memories` is the CLI wrapper for `list_my_memories`. It only lists your
saved memories, while `list --username <u>` can switch to public DittoHub
publishes for another user.

### `update`

Edit a saved memory in place. Replace the full body with `--content` or
`--content-file`, or use block edits after fetching `--memory-format outline`.
Block edits require the current revision returned by `save` or a previous
`update`.

```bash
heyditto update <memory-id> --content-file revised.md --output json
heyditto fetch <memory-id> --memory-format outline --output json
heyditto update <memory-id> --edits-file edits.json --base-revision 3 --output json
```

### `publish` / `unpublish`

Publish a saved memory to the user's public DittoHub profile, or disable an
existing share without deleting the private memory.

```bash
heyditto publish <memory-id> --title "Launch notes" --privacy-mode scan_and_block --output json
heyditto unpublish --share-id abc123def4 --output json
```

### `delete`

Permanently delete a saved memory. This is destructive, so the CLI requires
`--confirm`.

```bash
heyditto delete <memory-id> --confirm --output json
```

### `subjects`

Search the subject (topic) graph. Returns subject ids you can pass to `memories` or `network`.

```bash
heyditto subjects "memory architecture"
heyditto subjects "performance" --top-k 5
heyditto subject-edges <subject-id> --limit 10 --min-weight 0.5 --output json
```

`subject-edges` is the CLI wrapper for `get_subject_edges`.

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

### `friends`

List Ditto friends for commands that need usernames.

```bash
heyditto friends --output json
```

### `graphs`

Manage the public knowledge graphs you're subscribed to. Subscribed graphs are
folded into your `search`/`fetch` read paths (read-only). Subscriptions only ever
cover **other** users' public graphs by `@username` — this command can't touch
your own graph or an app's graph, since those aren't subscriptions.

```bash
heyditto graphs create feedback-triager  # create a NEW dedicated graph you own (mint its CI key in the Ditto UI)
heyditto graphs list              # graphs you're subscribed to
heyditto graphs available         # readable knowledge graphs, including main/app graphs
heyditto graphs add @minos        # subscribe to @minos's public graph
heyditto graphs remove @minos     # unsubscribe
heyditto graphs subscribers       # who's subscribed to your graph
heyditto graphs sharing --disable # disable public subscriptions to your graph
```

Top-level aliases are also available:

```bash
heyditto knowledge-graphs --output json
heyditto graph-sharing --enable --title "Support Graph" --description "Public support notes"
```

### `apps` — developer apps ("Sign in with Ditto")

Everything the developer console (developer.heyditto.ai) does for an app, from the
shell, so an agent can set an app up end to end. The client secret follows the same
rule as endpoint keys: it is **forwarded straight into a secret store** over that
store CLI's stdin and never printed.

```bash
heyditto apps create "DittoBench" --gh-secret DITTO_OIDC_CLIENT_SECRET --repo ditto-assistant/ditto-subnet
heyditto apps origins verify dittobench-3f9a https://dittobench.ai            # serve the token, then:
heyditto apps origins verify dittobench-3f9a https://dittobench.ai --confirm
heyditto apps consent set dittobench-3f9a credits:spend "Pays for the inference your miner uses."
heyditto apps icon set dittobench-3f9a ./logo.png
heyditto apps oidc dittobench-3f9a --callback https://dittobench.ai/auth/ditto/callback >> .env
heyditto apps endpoints attach dittobench-3f9a screener --billing sponsor
heyditto apps endpoints attach dittobench-3f9a competition --billing user
heyditto endpoints keys create competition --gh-secret DITTO_ROUTER_KEY --repo ditto-assistant/ditto-subnet
```

- `create` mints the app and its secret. With a store flag the secret is stored and
  never shown; without one it is minted but hidden — rotate it into a store later
  with `apps secret rotate` (the previous secret stops working).
- `oidc` prints the non-secret OIDC configuration (`DITTO_OIDC_ISSUER`,
  `DITTO_OIDC_CLIENT_ID`, authorization/token/userinfo/JWKS endpoints) as env lines
  or `--output json`. `client_id` is the app id; redirect URIs must live on a
  verified callback origin.
- `consent set <app> <scope> "<why>"` sets the app's own reason under each requested
  permission on the consent screen; `consent show` renders the public consent
  profile (`GET /api/v5/consent-profile/<app>`).
- `endpoints attach <app> <endpoint> --billing user|sponsor` makes a Router endpoint
  app-owned: the app's users get inference through it (never keys or edits). `user`
  bills the consenting user under their `credits:spend` grant to this app
  (`X-Ditto-On-Behalf-Of: <ditto uid>` from your server, 402 when not authorized);
  `sponsor` bills the endpoint owner and only records the user for attribution.
- `apps` commands use your first-party key against `/api/v5/admin/apps`; pass
  `--company <id>` to act on an organization's apps.

### `receipts`

Your receipts for the last 30 days by billing leg (`ditto` = your balance, `byok` =
your own provider keys, no Ditto charge, `covered` = paid by Ditto) and by the app
that spent under your consent; sponsored app calls show up on the sponsor's account.

```bash
heyditto receipts
heyditto receipts --leg byok --days 7
heyditto receipts --app dittobench-3f9a --output json
```

### `status`

Print whether `DITTO_API_KEY` is set and the configured MCP endpoint resolves.

### `init`

Create a free claimable agent account and save its key locally. Use `--json` for
machine-readable output that includes `apiKeyStored`, `userID`, and `claimURL`.
Share `claimURL` with the human owner. The CLI stores the generated key locally
without printing it. The claim URL uses a `?t=...` query parameter.

Pass `--name <name>` to set the agent's name. This is set once at init,
defaults to `agent`, labels every memory the agent saves, and (after the account
is claimed) becomes the title of the agent's external thread in the owner's
graph. Choose it up front — renaming after init isn't yet supported. See
[Name the agent at init](#name-the-agent-at-init).

`--agent-caller <name>` is still accepted as a backward-compatible alias.

### `config`

Print a Claude Desktop / Cursor / generic-MCP-client config snippet for the Ditto memory server.

## Coding agents

`heyditto claude` and `heyditto codex` launch Claude Code or Codex through one of
your Ditto **inference endpoints** (managed at https://developer.heyditto.ai/endpoints;
the Ditto app's Settings → Developer page still works too). Each launch:

1. signs you in through the browser if this machine has no key yet, then uses
   the endpoint you picked there, `--endpoint`, the saved default, or a picker,
2. mints a temporary endpoint key (optionally capped with `--budget <tokens>`),
3. starts the agent with that key and a fresh `X-Ditto-Session-Id`, so the
   session becomes its own thread with full traces under the endpoint,
4. **revokes the key when the agent exits** (Ctrl+C included). The thread and
   traces are kept; `--keep-key` opts out, `--expires` sets a server-side
   safety expiry (default `1mo`, so a session left open for days keeps
   working; the key is still revoked on exit).

```bash
npx -y @heyditto/cli login
npx -y @heyditto/cli claude --endpoint my-endpoint

heyditto endpoints --set-default my-endpoint   # skip the picker next time
heyditto claude                                # interactive Claude Code
heyditto codex --yellow                        # Codex, auto-accept edits
heyditto claude --yolo --worktree fix-login    # bypass prompts in <repo>/.worktrees/fix-login
heyditto codex -p "summarize this repo" --json # headless (codex exec)
heyditto claude -p "list TODOs" --output-format json --max-turns 3
heyditto claude --resume                       # reopen the last session in the same thread
heyditto claude -- --verbose                   # anything after -- goes to the agent
```

Options shared by both commands:

| Flag | Meaning |
| --- | --- |
| `-e, --endpoint <slug>` | endpoint to route through (default: saved default, else a picker) |
| `--budget <tokens>` | spend cap for this session's key, in Ditto tokens |
| `--expires <1h…never>` | server-side key expiry; the key is still revoked on exit unless `--keep-key` |
| `--session <id>` | reuse a Ditto session id so traces land in an existing thread |
| `--resume [id]` / `-c, --continue` | resume a local session (`heyditto sessions`) / the agent's most recent conversation |
| `--yolo` / `--yellow` / `--plan` | bypass permissions / auto-accept edits / plan mode (Claude only) |
| `-p, --prompt <text>` | headless run: `claude -p` or `codex exec` |
| `-m, --model <id>` | model to request (default: the agent's own model id passes through and the endpoint routes it) |
| `-w, --worktree [name]` | run inside `<repo>/.worktrees/<name>` on a branch of that name; `.worktrees/` is added to `.gitignore` |
| `--name <label>` | key name shown in the app (default `cli:<agent>:<hostname>`) |
| `--dry-run` | print the command, args and env with the key masked; mints nothing |

Unknown flags and everything after `--` are forwarded to the agent, so Claude's
and Codex's own options keep working.

How the wiring works:

- **Claude Code** gets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (a bearer
  token, which skips Claude's "use this API key?" prompt) and
  `ANTHROPIC_CUSTOM_HEADERS` with the session id. Any inherited
  `ANTHROPIC_API_KEY` is removed from the child environment.
- **Codex** speaks the Responses API only, so the endpoint is injected as a
  `ditto` model provider via `-c` overrides (nothing is written to
  `~/.codex/config.toml`) with the key in `DITTO_INFERENCE_API_KEY`.

### `endpoints`

Manage the inference endpoints the launchers route through — a CLI mirror of
the developer console at https://developer.heyditto.ai/endpoints (`open` takes
you to an endpoint's page there; set `DITTO_DEVELOPER_BASE` to point elsewhere):

```
heyditto endpoints [--set-default <slug>] [--clear-default]   list (* = default)
heyditto endpoints create [--name <n>] [--slug <s>] [--model <id>] [--default]
heyditto endpoints show <endpoint>
heyditto endpoints use <endpoint>          make it the default
heyditto endpoints pick                    choose the default interactively
heyditto endpoints open [endpoint]         open the editor in the Ditto app
heyditto endpoints set <endpoint> [settings flags — see the table below]
heyditto endpoints delete <endpoint> [--yes]
heyditto endpoints keys <endpoint>         list keys
heyditto endpoints keys create <endpoint> --store <destination> --secret <NAME> [scoping flags]
                                   [--name <label>] [--expires <1h…never>] [--budget <tokens>]
                                   [--spend-period <p>] [--yes]
heyditto endpoints keys stores              which destinations this machine can write to
heyditto endpoints keys revoke <endpoint> <keyId> [--yes]
```

Endpoints spend your Ditto credits, so deleting one, revoking a key or raising a
spend limit asks you to type the slug back; pass `--yes` in scripts. `--output
json` is available everywhere and includes the gateway base URL.

#### `endpoints set` — every setting the console has

`set` is a full mirror of the endpoint editor at
https://developer.heyditto.ai/endpoints: anything the web form can change, this
can change. `heyditto endpoints show <endpoint>` prints all of it back, and
`--output json` gives the raw fields.

| Flag | What it does |
| --- | --- |
| `--name <name>` / `--model <id>` | display name / default model id |
| `--system-prompt <text>` | prompt prepended to every request |
| `--spend-limit <tokens\|none>` `--spend-period <daily…never>` | spend cap and the window it resets on |
| `--recall on\|off` `--record on\|off` `--memory-depth <0-25>` | memory recall and recording |
| `--record-trace on\|off` `--record-attachments on\|off` | store raw traces / store images sent on the user turn |
| `--trace-retention <days>` | days traces are kept; `0` = forever. Clamped to your plan — the CLI says so when it was |
| `--context-compaction off\|light\|balanced\|aggressive` | how eagerly finished tool results are digested |
| `--result-compression off\|conservative\|grouped` | compress tool results at ingestion |
| `--tool-compression on\|off` | swap harness tool descriptions for stored condensed rewrites |
| `--precompact-at <tokens>` | start a background compaction snapshot at this prompt size; `0` = off |
| `--routing cheap\|fast\|balanced` | how a provider is picked for a model |
| `--model-mode default\|passthrough` | what happens to a request model that is neither alias, route nor provider id |
| `--billing-mode ditto\|byok\|both` | whose provider keys pay for requests |
| `--stream-granularity final\|tool\|full` | how much server-side tool activity the stream shows |
| `--max-tool-rounds <0-32>` | server-side tool loop cap per request |
| `--batch on\|off` `--batch-max-requests <0-50000>` | admit batch submissions, and the per-batch cap |
| `--kind-route <kind=model>` | pin a request archetype to a model: `chat`, `tool_round`, `aside`, `compaction`, `structured_output`, `probe` |
| `--model-route <requested=target>` | map a model id exactly as a harness sends it to a provider model |
| `--alias <name=model>` | name a model on this endpoint |
| `--clear-kind-routes` `--clear-model-routes` `--clear-aliases` | empty a whole map |

The three map flags are repeatable and **merge** onto what the endpoint already
has, so setting one route never drops the others. An empty value removes a
single entry:

```
heyditto endpoints set my-endpoint --kind-route aside=openai/gpt-5.6-nano \
                                   --kind-route probe=openai/gpt-5.6-nano
heyditto endpoints set my-endpoint --kind-route aside=          # remove just that one
heyditto endpoints set my-endpoint --clear-kind-routes          # remove all of them
```

Choices and numeric bounds are checked locally against the gateway's own
enums, so a typo fails instantly instead of costing a round trip.

#### Put a key straight into a secret manager

`keys create` mints a long-lived key on an endpoint and stores it in a secret
manager by delegating to that platform's own CLI — **the key is never shown**.
The plaintext goes to the platform CLI over stdin (or through `/dev/stdin`, for
the CLIs that read a file instead), so it does not appear in argv, `ps`, shell
history, logs or the CLI's own output, and nothing is kept locally. If the
platform CLI fails, the freshly minted key is revoked again.

| Destination | Shorthand | Scoping flags | CLI it delegates to |
| --- | --- | --- | --- |
| GitHub Actions | `--gh-secret NAME` | `--repo` `--env` `--org` | `gh secret set` |
| GitLab CI/CD | `--gitlab-var NAME` | `--project` `--org` `--env` | `glab variable set --masked` |
| AWS Secrets Manager | `--aws-secret NAME` | `--region` | `aws secretsmanager create-secret` (then `put-secret-value`) |
| Google Secret Manager | `--gcp-secret NAME` | `--project` | `gcloud secrets create` (then `versions add`) |
| Azure Key Vault | `--az-secret NAME` | `--key-vault` (required) | `az keyvault secret set --file` |
| 1Password | `--op-item TITLE` | `--op-vault` | `op item create` (JSON template on stdin) |
| HashiCorp Vault | `--vault-secret PATH` | `--mount` `--field` | `vault kv patch` (then `kv put`) |
| Doppler | `--doppler-secret NAME` | `--project` `--doppler-config` | `doppler secrets set` |
| Cloudflare Workers | `--cf-secret NAME` | `--worker` | `wrangler secret put` |
| Vercel | `--vercel-env NAME` | `--vercel-target` | `vercel env add --sensitive` |
| Kubernetes | `--k8s-secret NAME` | `--namespace` `--k8s-key` | `kubectl patch secret` (then `apply`) |
| Fly.io | `--fly-secret NAME` | `--app` | `fly secrets import` |

Every shorthand is sugar for `--store <id> --secret <NAME>`; use whichever
reads better. `heyditto endpoints keys stores` lists the destinations with the
CLI each one needs and whether it is installed here (`--output json` for
scripts).

```bash
cd my-repo
heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY               # repo from the current directory (like gh)
heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --repo acme/app --budget 5000000
heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --org acme --expires 6mo --output json
heyditto endpoints keys create my-endpoint --store aws --secret DITTO_KEY --region us-east-1
heyditto endpoints keys create my-endpoint --gcp-secret ditto-key --project my-gcp-project
heyditto endpoints keys create my-endpoint --az-secret ditto-key --key-vault my-vault
heyditto endpoints keys create my-endpoint --op-item "Ditto inference" --op-vault Engineering
heyditto endpoints keys create my-endpoint --vault-secret ditto/inference --mount secret --field token
heyditto endpoints keys create my-endpoint --k8s-secret ditto-inference --namespace prod
```

Requirements: the platform CLI on `PATH` and signed in — both are checked
*before* anything is minted, so a missing CLI costs you nothing. Without a
terminal the command needs `--yes`; interactively it shows what it will do and
asks you to type the secret name back. Defaults: expiry `1y`, key label
`<store>:<target>:<NAME>` (GitHub keeps its original `gh:<owner>/<repo>:<NAME>`);
`--budget` caps the key's spend (`--spend-period` defaults to `monthly`). A
scoping flag that belongs to another destination is an error rather than being
ignored. The output shows the key's last four characters, expiry, budget, where
it was stored, and how to consume it — for GitHub Actions:

```yaml
env:
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.DITTO_KEY }}
  ANTHROPIC_BASE_URL: https://api.heyditto.ai
  # OpenAI-compatible clients: OPENAI_API_KEY: ${{ secrets.DITTO_KEY }} with OPENAI_BASE_URL: https://api.heyditto.ai/v1
```

Revoke it any time with `heyditto endpoints keys revoke my-endpoint <keyId>`.

**Agent accounts.** An agent set up with `heyditto init` can create and manage
endpoints too, but an endpoint created by an unclaimed agent starts **inactive**:
it serves requests once the person the agent works for claims the agent and
subscribes to Ditto Hero. The CLI prints the server's explanation together with
an activation link (the agent's claim link plus the endpoint) — hand that link
to the user.

### `sessions`

List the coding-agent sessions launched from this machine (stored under
`~/.config/heyditto/cli/sessions/`). `heyditto sessions rm <id>` forgets a local
record; the Ditto thread and traces are unaffected.

### `session`

Explicit MCP sessions. Without one, the server groups your saves and searches
into a time-based *implicit* session (activity within a cooldown, auto-named
when it goes quiet). `heyditto session new [name]` pins an explicit session:
every MCP request from then on carries `X-Ditto-Session-Id`, and the name goes
out once as `X-Ditto-Session-Name` so the thread gets that title. Saves and
searches land in one thread inside the agent your key is attached to.

```bash
heyditto session new "refactor auth module"   # prints the id and makes it active
heyditto save "Decided to keep JWT refresh in the gateway"
heyditto session current                      # the active id (exit 1 when none)
heyditto session list                         # local history, * marks the active one
heyditto session end                          # back to implicit sessions
heyditto session use 9e9a93c3                 # reactivate by id or unique prefix
```

`DITTO_SESSION_ID=<id>` pins a session for one shell or script (it overrides the
saved one and never sends a name). Sessions are tracked locally in
`~/.config/heyditto/cli/mcp-sessions.json`; the server keeps the threads.

### `agents`

List your Ditto agents (`GET /api/v5/chat-agents`): id, kind (`main`, `chat`,
`inference_endpoint`, `mcp`, `connector`), name, thread count, last activity and
the live connections (API keys, OAuth grants, endpoints) writing into each.

## Teleport

Worktrees, clones, package caches and agent traces pile up until a laptop runs
out of disk. **Teleport** moves a coding project — one repo or a whole folder of
repos, plus your Claude Code / Codex session — to Ditto Cloud, so you can resume
it in the cloud or on another machine, and reclaim the local space. It is a
Hero-tier ($20) feature.

A **capsule** is one teleportable root. Each `push` appends an immutable
**generation**; only content-addressed chunks (≤ 24 MiB, deduplicated) reach
storage, and unchanged chunks are never re-uploaded, so re-pushing a mostly
unchanged tree is cheap. Secrets never travel: `.env*`, key files and package
caches are excluded by construction.

```bash
heyditto teleport                       # push the current directory as a capsule
heyditto teleport --cloud --endpoint work   # push, then resume in a Ditto Code cloud job
heyditto teleport push ~/code/project --mirror all
heyditto teleport pull project ~/code/project --restore-harness --resume
heyditto teleport list
heyditto teleport status project        # mirror + verification state
heyditto teleport generations project   # every committed generation
heyditto teleport targets               # mirror targets, quota and capsule limit for your plan
```

Every teleport command accepts `--json` (or `--output json`). `pull --json`
prints `{cwd, harnessSessionId, harnessKind, …}`, which is what the Ditto Code
runner reads when it restores a capsule before starting the harness. Capsules
can be referred to by name or id everywhere. `--endpoint` for `--cloud` takes an
endpoint id, slug or name; with a single endpoint it is chosen automatically.

Under the hood a push negotiates which content-addressed chunks the server
lacks, uploads only those via presigned URLs, then `commit`s the manifest (the
server answers `201 Created` with the new generation and its mirror state).
Every branch's upstream (`branchUpstreams`) and the real remote-tracking shas
(`upstreamTips`) travel in the manifest, so a pull recreates remotes and
tracking refs without a network fetch and `offload` sees exactly the unpushed
commits the source machine saw. A push reports what actually moved, e.g.
`Pushed generation 2: 1.2 KiB uploaded (2.0 MiB logical, 99.9% reused), 3 chunks
(1 uploaded, 2 reused)`; `--json` adds `uploadedBytes`, `logicalBytes`,
`reusedBytes` and `savingsRatio`, and `teleport --cloud --json` prints a single
`{ push, cloudSession }` document. `--cloud` opens
the thread URL the backend returns for its linked app (falling back to the
production app link on older backends). `pull --resume` always resumes the
harness inside the restored tree (add `--dry-run` to see the launch plan), so
the next prompt lands in the restored transcript even when the original
directory still exists on the same machine. Restored Claude transcripts are
filed under Claude Code's own project slug for the destination path (every
non-alphanumeric character becomes `-`), so `claude --resume` finds them in
paths with underscores or dots such as `/opt/workspace_base/capsule`. macOS
AppleDouble `._*` files and `.DS_Store` never enter the worktree archive. Worktrees compressed with `zstd`
are decompressed by Node itself when the `zstd` binary is missing; on a Node
without zstd support the pull fails with a message naming the binary to install.

`push` bundles each repo (thin against the previous generation when possible),
tars the dirty and untracked files, and captures the harness transcript for the
session that was working there. `pull` reconstructs the repos from their
bundles, restores branches, upstreams and the dirty worktree, and places the
harness transcript under the restored path so `--resume` continues the exact
session.

## Offload

`offload` is the safe "back it up, then delete it" command. It pushes the
project, waits until the capsule is verified on a redundant mirror, then removes
the local copy (into the Trash on macOS). It refuses when a repo holds commits
no remote has, unless you pass `--allow-unpushed`.

```bash
heyditto offload ~/code/old-project      # verify, confirm, delete
heyditto offload --yes                   # skip the confirmation
```

Recover any time with `heyditto teleport pull <capsule> <path>`.

## Storage mirrors

Ditto stores capsules redundantly on its own storage. You can also bring your
own S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Hippius)
and mirror capsules to it — to all buckets or a chosen subset.

```bash
heyditto storage add --name my-r2 --endpoint https://<acct>.r2.cloudflarestorage.com \
  --region auto --bucket ditto-teleport --access-key … --secret-key …
heyditto storage list
heyditto storage test my-r2               # name or id
heyditto storage remove my-r2
heyditto storage mirror project all      # or: heyditto storage mirror project <id>,<id>
```

Buckets are managed through the teleport API (`/api/v5/teleport/buckets`), so the
saved CLI key is all you need. A bucket added with `storage add` is a teleport
mirror by default; pass `--no-mirror` to keep it out of mirror policies.

`teleport pull` and `teleport --cloud` need a committed generation: a capsule that
was created but whose push failed reports `has no generations yet`.

## Environment

- `DITTO_API_KEY` (optional) — MCP API key override. Agents can instead run `heyditto init --json` for no-human setup.
- `DITTO_API_BASE` (optional) — API base URL. Defaults to `https://api.heyditto.ai`. Useful for local dev (`http://localhost:3400`).
- `DITTO_SESSION_ID` (optional) — pin an explicit MCP session id for this shell (see `session`).
- `DITTO_CONFIG_DIR` (optional) — config directory for the saved key, default endpoint and session records. Defaults to `$XDG_CONFIG_HOME/heyditto/cli` or `~/.config/heyditto/cli`.

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
