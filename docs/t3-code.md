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
T3 native session the same Ditto trace id, and lets the CLI resolve resumed
sessions. It uses `--no-mcp` because T3 manages its own MCP servers through the
Claude SDK; endpoint tools stay on the Router. It uses `--no-remote-control`
because the SDK owns the process pipes: T3 retains its own remote-control path,
while this launcher does not attach Ditto's terminal bridge.

Normal process exit and forwarded termination let the CLI revoke its temporary
key. A hard kill or a failed revocation can leave that key valid until its
expiry; the CLI reports revocation failures. No key is saved in this launcher
or in T3's provider settings.

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
