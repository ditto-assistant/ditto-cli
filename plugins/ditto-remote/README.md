# Ditto Remote for Claude Code

Review candidate. This plugin has **not been submitted or approved** as a Claude
Code Channel. Installing it does not authorize inbound Channels. Claude's
channel opt-in and your organization's policy still apply.

Receive a prompt from your own Ditto session in native Claude Code, explicitly
acknowledge receipt, and return an explicit reply to the Ditto app. Claude uses
its existing subscription/authentication for inference. This plugin does not
set Anthropic credentials, inference URLs or native tool permissions.
It supplies the remote Channel and its `acknowledge`/`reply` tools only. Selecting
an endpoint registers the session; it does not automatically attach that
endpoint's full MCP tool catalog. Use `heyditto claude --mcp-only` or your other
Ditto MCP configuration for those tools.

## Build and review

From a clean source checkout with the Node version in `.nvmrc`:

```sh
npm ci
npm run plugin:build -- .tmp/ditto-remote-review /absolute/path/to/cli-2.41.0.tgz
claude plugin validate .tmp/ditto-remote-review
```

The checked-in `plugins/ditto-remote` folder is a source template. It is not an
installable GitHub-source plugin until the generated runtime is included. Do
not submit that template unchanged to a directory that ingests GitHub content.

The output is the installable plugin root, including a manifest, MCP config,
canonical published CLI 2.41.0 runtime, exact-lock production dependencies, their licenses, and
`BUILD.json` with separate packaging and released-runtime revisions, archive SRI/SHA256, overlay hashes and dependency-lock SHA256. The build refuses to overwrite
an existing directory; pass a fresh output path to
`node scripts/build-remote-plugin.mjs <output> <canonical-runtime.tgz>` after `npm run build`. The committed `runtime-release.json` pins the archive and dependency lock. Obtain that exact npm archive separately; the builder refuses a mismatch before creating output and does not select `latest`. Only the standalone pairing entry point and URL helper overlay the released runtime.
Dependencies install only at build time, with lifecycle scripts disabled. The
plugin does not run `npx`, fetch packages or update itself when Claude starts.
The machine must provide a supported Node on `PATH`; Node is not bundled.

Before enabling this plugin, run `heyditto login` and select an existing tools
endpoint using `heyditto endpoints use <slug>`, or apply the repo's `.ditto`
profile with `heyditto repo apply`. In a plain Claude launch, the plugin resolves
that repository's endpoint first, then the saved default, then the sole endpoint
if there is exactly one. An explicit `DITTO_REMOTE_ENDPOINT` overrides these.
It refuses an ambiguous or unavailable selection instead of creating a profile
or key. Authentication uses the existing CLI config or inherited `DITTO_API_KEY`;
never place credentials in plugin JSON, command arguments or screenshots.

A plain launch creates one native/MCP-only Channels session per MCP process.
Its link is printed to MCP stderr and appears under Claude Code in Ditto. An
MCP process restart creates a new session; Claude transcript resumption is not
currently correlated across independent plugin process restarts. The standalone registration UUID is not asserted to be Claude's native transcript UUID, so native automatic title synchronization is not provided by this standalone adapter. Wrapper title-sync evidence is separate. A launch
that inherits `DITTO_REMOTE_SESSION_ID` and `DITTO_REMOTE_CWD` uses the CLI
wrapper's already registered session instead.

## Development and approval

The plugin stays inactive unless `DITTO_REMOTE_CHANNELS_ENABLED=1` is present
in the launching process. Scope that opt-in to the Claude launch that also
sets its matching Channels flag; installation alone must not register a remote
session. This environment opt-in cannot prove Claude accepted the flag, so the
explicit model receipt and reply remain the delivery evidence.

The bundle includes a **local-only** marketplace named `ditto-remote-review`
so review uses a precise identity without claiming a public listing. Install
from the generated directory in a disposable review project:

```sh
claude plugin install ditto-remote --marketplace /absolute/path/to/built-plugin --scope local
DITTO_REMOTE_CHANNELS_ENABLED=1 claude --dangerously-load-development-channels plugin:ditto-remote@ditto-remote-review
```

Review the local source/trust prompt. Do not add a global permanent marketplace
merely to test a candidate. The local install writes Claude settings for the
review project; use the plugin manager to disable/remove it afterwards.
Alternatively, `--plugin-dir` loads the built root for a single process, using
the identity Claude reports for that mode.
Do not use `-p` or the SDK for this test: development Channels are interactive.
An ordinary community marketplace does not put the plugin on Anthropic's default
channel allowlist. The approval packet documents the two proposed routes:
an organization administrator's exact allowlist, or coordination with Anthropic
for the official plugin marketplace/default channel list. The official
marketplace does not take submissions through the generic directory portal.
Generic plugin and remote-MCP-connector directory listings remain separate
records and do not establish Channel admission. A public distribution artifact
or runnable GitHub package is an owner-reviewed publication step; the generated
review marketplace remains local.

Do not install both the launcher's `server:ditto-remote` adapter and this plugin
in one Claude process; two local adapters create conflicting control paths.
The launcher retains the development server path until plugin admission and
installation behavior have been verified. Installation alone is not proof of
channel registration: verify a unique prompt and explicit acknowledge/reply.

## Limits and uninstall

Only prompt delivery, attachment paths and explicit replies are supported. Claude schedules normal channel notifications itself: capabilities advertise queue=false, steer=false, interrupt=false, nativeScheduling=true. The terminal bridge's FIFO, steering, permission and physical Stop evidence does not transfer to Channels.
Queue/Send now guarantees, remote permission answers, slash commands, interrupts, checkpoints and full
native transcript synchronization are unsupported. Normal Claude permissions
still control all local actions. Treat remote content as untrusted input.

There are at most 32 in-memory pending prompts; unacknowledged prompts expire
after ten minutes, acknowledged prompts after one hour. A reply is limited to
64 KiB. Seen turn IDs are deduplicated within a bounded process-local cache;
this does not promise exactly-once execution across restarts. The app, server
and local session must be authenticated and available. Downloaded attachments
remain in `<working-directory>/.tmp/ditto/attachments/<turn-id>/` until you remove
them; uninstalling the plugin does not delete your files or Ditto account data.

Disable/remove the plugin in Claude's plugin manager and restart/close its MCP
process to stop receiving prompts. Revoke the existing Ditto key through Ditto
when account-level access must end. Do not remove a shared CLI login simply to
uninstall this plugin. Review app/session deletion separately under Ditto's
actual retention policy; no special automatic deletion period is claimed here.

Source and issue reports: https://github.com/ditto-assistant/ditto-cli.
Review/security contact ownership must be confirmed by Peyton before submission;
do not put credentials or private transcripts in public issues.

## Brand asset provenance

`icon.png` is the unchanged canonical sculptural-D app icon from
`ditto-assistant/brand-kit`, tag `v2026.09.10`, revision
`8e79ff354ccf08130b1e00ea095599a78a6254fe`, source
`kit/png/ditto-app-icon-dark-512.png` (512 × 512). SHA256:
`22f8c0283b513d40fa7599f789d70bc577a500eeaaf6280047f5441d3a973934`.
No mark was redrawn.
The listing owner should approve this icon before the first directory save,
since the current validator warns the initial listing icon is not replaced by
later plugin updates.
