# Use Ditto Router in the official T3 Code app

T3 Code can run an additional Claude provider instance through Ditto Router.
Keep the normal Claude instance for its existing subscription. The extra
instance uses the installed Claude Code harness, Ditto Router inference, and
the Router's endpoint tools and optimizations.

## Automatic setup

Preview a dedicated Claude provider using local CLIProxy inference and the
selected endpoint's MCP tools:

```sh
heyditto t3 setup --endpoint ditto-dev --inference cliproxy --dry-run
```

Quit T3 Code (or stop its background service yourself), then apply:

```sh
heyditto t3 setup --endpoint ditto-dev --inference cliproxy
```

Without `--endpoint`, setup chooses the endpoint the way `heyditto claude`
does: it signs you in through the browser if needed, then uses your saved
default endpoint, your only endpoint, or a numbered picker, and offers to
create your first endpoint when you have none. The chosen slug is written into
the launcher. A `--dry-run` without `--endpoint` never creates an endpoint or
saves a default.

Keep T3 closed until setup finishes. Reopen it and choose **Claude CLIProxy +
Ditto** in a new chat. The command installs a private launcher, creates an
isolated Claude config directory, and adds the `claude_ditto_cliproxy` provider.
It preserves other providers and settings, saves an exact private backup before
replacing settings, and can be rerun without duplicating the provider. It does
not mint keys, copy credentials, stop active chats, or send inference requests,
and it changes the saved default endpoint only when you create a first endpoint
or accept the picker's "use by default" prompt. Session keys are minted by the launcher when
a chat starts and revoked on normal exit.

## Two providers, two endpoints (profiles)

Each T3 provider created by setup is bound to one endpoint, so it sees that
endpoint's MCP tools. To orchestrate between, say, your normal endpoint and a
subnet endpoint, give each a [named profile](../README.md#profile--named-endpoint-profiles)
and set up one provider per profile:

```sh
# Your existing default endpoint becomes profile "default" (still active).
heyditto profile create subnet --endpoint <subnet-endpoint-slug>
heyditto profile                           # * default → ditto-dev, subnet → <subnet-endpoint-slug>

heyditto t3 setup --profile subnet --dry-run
# quit T3, then
heyditto t3 setup --profile subnet
```

| Profile | T3 instance id | Display name |
| --- | --- | --- |
| `default` | `claude_ditto_cliproxy` | Claude CLIProxy + Ditto |
| `subnet` | `claude_ditto_subnet_cliproxy` | Claude Subnet |
| `<name>`, `--inference router` | `claude_ditto_<name>_router` | Claude `<Name>` (Router) |

`--instance`, `--name` and `--inference` still override what the profile
implies; the profile's inference mode (`profile create --inference`) is the
default. `--profile` and `--endpoint` are mutually exclusive; an explicit
`--endpoint` (without `--profile`) keeps the original behaviour and instance id
even when `DITTO_PROFILE` is set. Once you have
saved profiles, a bare `heyditto t3 setup` uses the *active* profile's endpoint
and instance, so after `heyditto profile use subnet` it updates the subnet
provider and never re-points the original one.

The endpoint is written into each provider's own launcher, so `heyditto profile
use` changes only which endpoint new `heyditto claude`/`codex` sessions in your
terminal use. It does not edit any T3 provider, its Claude home or its launcher,
and the normal Claude subscription provider is untouched. To re-point a
provider, change the profile (`heyditto profile set subnet --endpoint <slug>`)
and rerun `heyditto t3 setup --profile subnet` with T3 closed. Renaming or
deleting a profile leaves the provider it created in place. Profiles, launchers
and T3 settings hold no credentials: each chat still mints its own session key
and revokes it on exit.

## Repositories choose their own endpoint

A provider's endpoint is a fallback, not a pin. When a T3 chat starts in a
checkout whose `.ditto/config.toml` sets `repository.default_endpoint`, the
launcher uses that repository's endpoint (and its MCP tools) instead; anywhere
else it uses the provider's endpoint. So one provider gives `heyditto-stack`
chats the `ditto-dev` tools and `ditto-subnet` chats the SN118 Backroom tools
without a second provider. A resumed chat stays on the endpoint it started on,
and `--profile` / `DITTO_PROFILE` still beat the repository default.

Launchers installed before this behaviour pass their endpoint as `--endpoint`.
`heyditto claude` recognises that value (it equals the launcher's exported
`DITTO_T3_ENDPOINT`) and treats it as the fallback too, so updating
`@heyditto/cli` is enough; rerunning `heyditto t3 setup` is not required. Any
other `--endpoint` is still an explicit choice and wins.

## Options

Use `--inference router` for Router inference instead. `--instance` and `--name`
choose a separate provider id and label. An id belonging to another provider is
refused rather than overwritten. To update a provider created by this command,
rerun setup with its id and the new endpoint or inference mode. Its Claude home
stays the same, and its old launcher is kept intact.

`--base-dir` selects a local T3 installation, defaulting to `T3CODE_HOME` or
`~/.t3`. Pass the base directory, not its `userdata` child. T3 must already have
been initialized there. `--heyditto-bin` and `--claude-bin` override executable
detection. `--json` prints a summary with paths and route choices, never the
existing settings or their secrets.

T3 CLI v0.1.7 has no provider-settings command. This shortcut updates its local
`userdata/settings.json` while the server is stopped, rather than invoking a
nonexistent `t3 provider` command or an undocumented live API. Apply refuses a
live or unreadable runtime record, changed settings, linked destinations, and
modified generated launchers. Dry runs are allowed while T3 is open. This
file-based integration was developed against T3 v0.1.7; verify it after T3
configuration-schema changes. It currently supports the Claude provider on
macOS/Linux, not native MCP attachment for Codex.

To undo, disable or remove this dedicated provider in T3; your previous providers
are preserved. Setup also prints a private backup path. Restore a whole backup
only with T3 stopped and before making later settings edits you would lose.

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
