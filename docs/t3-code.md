# Use Ditto Router in the official T3 Code app

T3 Code can run an additional Claude provider instance through Ditto Router.
Keep the normal Claude instance for its existing subscription. The extra
instance uses the installed Claude Code harness, Ditto Router inference, and
the Router's endpoint tools and optimizations.

## Install the launcher

Use `@heyditto/cli` **3.4.0 or newer** and a Node runtime supported by that
installed package. Confirm the binaries in the shell used to install it:

```sh
command -v node
command -v heyditto
command -v claude
heyditto --version
heyditto claude --help
heyditto status
```

Sign in with `heyditto login` if needed. Never put a Ditto or provider key in
the launcher. Select an endpoint you may use with `heyditto endpoints list`.
Use its CLI slug, for example `ditto-dev`; do not assume an `@org/slug` form is
accepted by the installed CLI.

From this repository:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.claude_t3_ditto"
install -m 700 scripts/claude-router-launcher.sh "$HOME/.local/bin/t3-ditto-claude"
```

Or, when installed from npm, copy the packaged launcher using the same npm/Node
installation as the chosen `heyditto`:

```sh
install -m 700 "$(npm root -g)/@heyditto/cli/scripts/claude-router-launcher.sh" "$HOME/.local/bin/t3-ditto-claude"
```

## Add a T3 provider instance

In **Settings → Providers → Add provider**, add another **Claude** instance:

| Setting | Value |
| --- | --- |
| Display name | `Ditto Router` |
| Binary path | The absolute path to `~/.local/bin/t3-ditto-claude` |
| Claude config directory | The absolute path to `~/.claude_t3_ditto` |
| `DITTO_T3_ENDPOINT` environment variable | Your endpoint slug, for example `ditto-dev` |
| `DITTO_T3_HEYDITTO_BIN` environment variable | Optional absolute path to the selected `heyditto` executable |
| `DITTO_T3_CLAUDE_BIN` environment variable | Optional absolute path to the selected executable named `claude` |

The binary overrides are useful when macOS desktop apps see a different PATH
from the terminal, or when several global CLI installations coexist. The
launcher puts those binaries' directories first on its child PATH, so a
version-manager installation uses the Node runtime alongside its `heyditto`.
For a native Claude executable whose filename is a version number, point the
override at its normal `claude` symlink instead. Do not change `HOME`.

Leave the Router token and Anthropic authentication variables unset in T3.
The launcher obtains a temporary endpoint key through the existing Ditto login
for each launch. A separate Claude config directory avoids interfering with the
normal provider's account and conversations. The launcher also removes inherited
Anthropic gateway credentials and alternative-provider selectors for this child.

Add a custom model in this provider's **Models** section if the model you want
is absent from T3's built-in list, then select that exact model in a new chat.
The Router endpoint's routing policy determines the upstream model; inspect
the served trace when verifying the model actually used.

## Verify the connection

1. Refresh provider status. The launcher forwards version probes directly to
   Claude without contacting Ditto.
2. In a new T3 conversation, select **Ditto Router** and a model exposed by your
   endpoint. Send a small prompt and confirm a real response.
3. Check the endpoint's cloud trace for that session, requested model, selected
   upstream, and completed response. A green T3 status alone is not inference
   evidence.
4. Confirm the original Claude provider still uses its normal configuration.

The launcher preserves T3's stream-json stdin/stdout protocol. It gives a fresh
T3 native session the same Ditto trace id. On resume or continue it removes the
SDK's fresh-session flag before letting the CLI resolve the existing session;
Claude cannot use both selectors together. Missing or empty session IDs fail
before launch. It uses `--no-mcp` because T3 manages its own MCP servers through the
Claude SDK; endpoint tools stay on the Router. It uses `--no-remote-control`
because the SDK owns the process pipes: T3 retains its own remote-control path,
while this launcher does not attach Ditto's terminal bridge.

Normal process exit and forwarded termination let the CLI revoke its temporary
key. A hard kill or a failed revocation can leave that key valid until its
expiry; the CLI reports revocation failures. No key is saved in this launcher
or in T3's provider settings.

## Local CLIProxy inference with automatic Ditto MCP tools

With CLI **3.5.0 or newer**, the same launcher can keep inference on the local
CLIProxy while attaching the selected endpoint's tools as native MCP servers.
Install the current packaged launcher; updating only the CLI does not replace
an older copy of the launcher script.

In the Claude provider's **Environment variables**, set:

| Variable | Value |
| --- | --- |
| `DITTO_T3_INFERENCE` | `cliproxy` |
| `DITTO_T3_ENDPOINT` | Your tool endpoint slug, for example `ditto-dev` |

Keep **Binary path** pointed at the installed launcher and keep the provider's
isolated **Claude config directory**. Leave **Launch arguments** empty unless
you have other Claude options to pass. The launcher auto-detects EasyCLIProxyAPI
through the CLI and uses `--cliproxy --mcp --no-remote-control`. Each launch
fetches the endpoint's current tool catalog and attaches one MCP server per app,
using a temporary endpoint key revoked on normal exit. No endpoint key belongs
in T3 settings or a static MCP JSON file.

T3's own SDK servers remain managed by T3. Verify both its tools and the Ditto
servers in a fresh session, then perform a harmless read through one Ditto tool.
A provider status or CLI version probe does not test MCP connectivity. Resume
an existing session as a separate check. Tool approvals still follow the
endpoint policy; this setting does not bypass them. Catalog setup failures stop
CLIProxy launches rather than falling back to paid Router inference.

This mode is for the Claude provider. It does not attach native MCP servers to
T3's Codex provider. Omitting `DITTO_T3_INFERENCE` (or setting it to `router`)
retains the original Router-inference behavior described above.

## Troubleshooting

- **Missing mode flag:** the selected CLI is too old. The launcher checks
  `heyditto claude --help` and fails before launching instead of passing unknown
  flags to Claude or silently selecting another inference mode.
- **Wrong Node or CLI:** set `DITTO_T3_HEYDITTO_BIN` to the intended absolute
  executable, refresh T3's provider, and recheck its help with that installation.
- **Missing Claude:** set `DITTO_T3_CLAUDE_BIN` to its absolute `claude` executable
  or symlink. Both binary overrides must resolve to executable absolute paths.
- **Endpoint not found or unavailable:** check the exact endpoint slug and its
  activation/access with the CLI. The launcher does not fall back to a native
  subscription when Router setup or inference fails.

Upstream reference: [T3 Code's Claude provider guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-claude.md).
