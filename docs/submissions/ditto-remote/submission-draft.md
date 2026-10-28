# Ditto Remote channel approval — owner review draft

Prepared October 28, 2026. Submitting organization: **OmniAura LLC**.
Account owner/contact: **Peyton Spencer (`peyton@omniaura.ai`)**. Tracker: DITTO-1585.
**State: engineering review candidate; not submitted, published or approved.**

This is copy ready for owner review. Fields marked **owner decision** and
unmeasured acceptance checks must be resolved before anything is submitted.
No submission terms have been accepted and no Anthropic message has been sent.

## Proposed listing

- Plugin slug: `ditto-remote` (**owner decision**, retain after publication).
- Publisher: Ditto, submitted by **OmniAura LLC** from **`peyton@omniaura.ai`**.
  Confirm this organization is the permanent listing owner before final submission.
- Local review identity: `ditto-remote@ditto-remote-review`; generated local
  marketplace only, separate from a public publisher identity.
- Proposed Ditto-controlled marketplace name: `ditto-official` (**owner decision**;
  proposed namespace only, not a published or verified marketplace).
- Source: https://github.com/ditto-assistant/ditto-cli, `plugins/ditto-remote`
  template plus `src/remote/plugin-server.ts` and `channel-server.ts` runtime.
  **This GitHub template is not runnable until built**; use the distribution
  checklist below before a directory ingestion or public installation.
- Icon: unchanged canonical Ditto app icon, brand-kit `v2026.09.10` revision
  `8e79ff354ccf08130b1e00ea095599a78a6254fe`; **owner review** before the first
  portal save because the initial listing icon cannot be casually replaced.
- License: MIT; runtime dependencies and their licenses ship in the bundle.
- Product: https://heyditto.ai.
- Support and vulnerability contact: **owner decision**. Confirm an actively
  monitored security channel and its disclosure policy before listing.
- Privacy policy, data retention and deletion links: **owner confirmation** of
  the exact current public pages and whether they cover remote prompt content,
  receipts, replies, attachment copies and existing CLI credentials.

## Proposed channel-specific request

Please review Ditto Remote as a **Claude Code Channel plugin**, including its
eligibility for the official plugin marketplace and default channel allowlist.
It lets the signed-in Ditto user send a prompt from their Ditto app to their own
native Claude Code session and return an explicit receipt and reply. The user
continues to use their native Claude Code account for model inference; this
plugin does not route or bill native model inference through Ditto.

Our plugin is a stdio MCP server advertising `experimental["claude/channel"]`
and sending `notifications/claude/channel`. Its `acknowledge` and `reply` tools
record actual model receipt and completion rather than claiming notification
transport alone proves delivery. Inbound content has no additional authority
over local tools, permissions or files. Remote permission approval and
unattended native tool-permission bypass are outside the requested scope.

We understand that an ordinary community-marketplace listing is not sufficient
for default Channel admission, and a generic directory/MCP listing does not
prove Channel approval. Please confirm the appropriate channel-specific review
route, the exact plugin/marketplace identity to use, update/version policy,
security evidence required and whether an official-marketplace listing is
necessary for the default allowlist. We understand that the official
marketplace does not take submissions through the directory portal; this
request is specifically for the relationship/support-led Channel route.

We can provide a sanitized native-subscription demonstration, source revision,
exact-lock runtime bundle, test evidence, data-flow and threat model. We do not
claim default-list approval or a review deadline. We will retain the CLI bridge
for harnesses and accounts without admitted Channels.

## Route and questions for Peyton

### Channel admission: two independent paths

1. **Default allowlist / Anthropic official marketplace.** The current
   [publish guide](https://code.claude.com/docs/en/plugins/publish) explicitly
   says `claude-plugins-official` does **not** accept directory-portal
   submissions. The Channels reference directs an official-marketplace
   listing through an Anthropic partner contact. Peyton should use an existing
   relationship, or ask the account's legitimate support route where this
   request belongs. No contact or separate public Channel application is
   invented. Share the request only after owner review.
2. **An explicitly consenting organization's managed allowlist.** Its
   owner/admin may enable `channelsEnabled` and admit the exact
   `allowedChannelPlugins` identity. This replaces the default allowlist, so
   preserve existing allowed entries. Do not change managed settings silently.
   This route applies to that organization and does not establish default
   admission for personal Pro/Max accounts. Test ordinary `--channels` with no
   development override before claiming that pilot works.

### Generic directory plugin / remote connector: separate listings

The portal at https://claude.ai/directory/manage handles generic plugins and
remote MCP connectors. Neither listing is the Channel approval route above.
Keep the existing Ditto memory plugin draft separate from the new
`ditto-remote` package and from any remote MCP connector submission. The owner
identity is OmniAura LLC / `peyton@omniaura.ai`; authenticating that account
alone does not approve any listing or channel. The remote connector needs its
own limited-catalog review and demonstration before submission. No form has
been submitted and no submission terms accepted as part of this packet.

The standalone `ditto-remote` package provides the inbound Channel and
`acknowledge`/`reply` only. Selecting a repository/default endpoint registers
and places its session; it does **not** attach that endpoint's full MCP tool
catalog. `heyditto claude --mcp-only` and other configured Ditto MCP connections
supply tools separately. A normal remote MCP connection alone does not provide
inbound Channels.

## Distribution proposal to review before publishing

- Build from the approved immutable CLI revision, preserving `BUILD.json`,
  dependency-lock SHA256 and licenses; hash the final versioned ZIP.
- Publish a versioned release artifact only after owner review. Direct
  `--plugin-url` loading or an extracted `--plugin-dir` can use that bundle;
  neither option grants Channel admission.
- Directory ingestion requires a GitHub repository that holds the runnable
  plugin. The CLI's committed `plugins/ditto-remote` folder is a source template
  and intentionally lacks generated `runtime/`; do not submit it unchanged.
- Propose an approved Ditto-controlled distribution repo/folder containing the
  complete runnable bundle under that repo's rules. Review the existing
  `ditto-claude-plugins` repo as a possible home, preserving its memory plugin
  and draft. Do not mutate or publish that distribution as part of this packet.
- Validate and clean-install from the exact proposed public source/artifact;
  record its revision/hash and repeat the packaged-plugin live demo.
- Publishing a Ditto marketplace is publishing its JSON catalog to GitHub,
  not an Anthropic submission/approval. Keep the generated
  `ditto-remote-review` catalog local and choose any public identity separately.

## Artifact and evidence checklist

| Item | Current status / required next step |
| --- | --- |
| Installable versioned plugin | `npm run plugin:build` produces a local installable review bundle; `BUILD.json` binds source revision and dependency-lock SHA256 |
| Runnable public distribution | **Not published**; approve a complete release bundle and a runnable GitHub source location before directory ingestion; the checked-in template alone is insufficient |
| Source and runtime | Reuses the CLI channel implementation; Node provided by the host, dependencies bundled from committed lock; no startup download |
| Manifest validation | Clean `4a2debc` plugin manifest and local-review marketplace both passed without warnings on Claude Code 2.1.312; runtime artifact remains pinned independently of documentation-only updates |
| Native live demo | **Passed October 28, 2026**: clean runtime artifact `4a2debc3aa478e981c59c225bb10e9fac5be8867`, Claude Code 2.1.312 displaying Opus 5.5 / Claude Max, unique Browser prompt visibly received through the packaged plugin, explicit acknowledge/reply completed and matching response returned to Ditto. Development override only; run IDs and screenshot originals in `evidence.md` |
| CLI live demo | Record separately; CLI terminal transport is not plugin admission evidence |
| Sender isolation | **Outstanding**: two-account session ownership negative test; attach the exact backend head/result, not just client-session-ID filtering |
| Revoked credentials | **Outstanding**: revoke a disposable QA key; prove disconnection/rejection and no new delivery; do not revoke a user's shared key |
| Policy denial | Show omitted/denied channel identity does not deliver or get reported as model receipt |
| Restart / reconnect / duplicate | Exercise bounded deduplication and expiry; do not promise cross-restart exactly-once behavior |
| Normal `--channels` | **Outstanding external admission gate**; test with exact org-allowed or official identity and no development override |
| Privacy / retention / contact | **Owner confirmation required**; public policy coverage and monitored disclosure destination |
| Channel request | **Not sent**; Peyton reviews the relationship/support destination, identity, artifact, evidence and request text |
| Generic plugin / connector directory listings | Separate owner-reviewed records; neither implies official marketplace or Channel admission |

Record evidence in `evidence.md` with exact revisions, dates, account scope and
redacted request/turn IDs. Do not include customer prompts, account tokens,
private repository content or unrelated terminal sessions.
