# Ditto Remote channel approval — owner review draft

Prepared October 28, 2026. Owner: Peyton Spencer. Tracker: DITTO-1585.
**State: engineering review candidate; not submitted, published or approved.**

This is copy ready for owner review. Fields marked **owner decision** and
unmeasured acceptance checks must be resolved before anything is submitted.
No submission terms have been accepted and no Anthropic message has been sent.

## Proposed listing

- Plugin slug: `ditto-remote` (**owner decision**, retain after publication).
- Publisher: Ditto / ditto-assistant (**owner decision**: choose the permanent
  Anthropic submitting account and owning organization).
- Local review identity: `ditto-remote@ditto-remote-review`; generated local
  marketplace only, separate from a public publisher identity.
- Proposed Ditto-controlled marketplace name: `ditto-official` (**owner decision**;
  proposed namespace only, not a published or verified marketplace).
- Source: https://github.com/ditto-assistant/ditto-cli, `plugins/ditto-remote`
  template plus `src/remote/plugin-server.ts` and `channel-server.ts` runtime.
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
necessary for the default allowlist. If directory submission is a separate
step, please distinguish that review from channel admission.

We can provide a sanitized native-subscription demonstration, source revision,
exact-lock runtime bundle, test evidence, data-flow and threat model. We do not
claim default-list approval or a review deadline. We will retain the CLI bridge
for harnesses and accounts without admitted Channels.

## Route and questions for Peyton

Current Channels reference says to coordinate with an Anthropic partner contact
for an official-marketplace listing; it does not promise that submitting a
plugin through the generic directory admits its Channel. If Ditto has an
existing relationship, Peyton should use that contact with the request above.
Otherwise, use the official submission/directory workflow to ask for the
channel-specific route and preserve the response. **No contact is invented.**

The documented directory portal is https://claude.ai/directory/manage. Recheck
its current account eligibility and submission terms with Peyton at submission
time. The review packet can be shared after owner review; submission, public
marketplace publication and legal acceptance are separate actions.

An organization pilot is a distinct route. Its consenting owner/admin can
propose an `allowedChannelPlugins` entry for the exact installed identity and
`channelsEnabled: true`. This setting replaces the default allowlist, so the
admin must preserve the organization's existing allowed entries. Do not
silently modify managed settings. An organization pilot does not establish
default-list admission for personal Pro/Max customers.

## Artifact and evidence checklist

| Item | Current status / required next step |
| --- | --- |
| Installable versioned plugin | `npm run plugin:build` produces a local installable review bundle; `BUILD.json` binds source revision and dependency-lock SHA256 |
| Source and runtime | Reuses the CLI channel implementation; Node provided by the host, dependencies bundled from committed lock; no startup download |
| Manifest validation | Record exact Claude version and successful `claude plugin validate` result for the final clean source bundle |
| Native live demo | Record a unique Browser prompt visibly arriving in the **packaged plugin** and explicit reply returning; prior server-adapter tests do not satisfy this row |
| CLI live demo | Record separately; CLI terminal transport is not plugin admission evidence |
| Sender isolation | Two-account session ownership negative test; attach the exact backend head/result, not just client-session-ID filtering |
| Revoked credentials | Revoke a disposable QA key; prove disconnection/rejection and no new delivery; do not revoke a user's shared key |
| Policy denial | Show omitted/denied channel identity does not deliver or get reported as model receipt |
| Restart / reconnect / duplicate | Exercise bounded deduplication and expiry; do not promise cross-restart exactly-once behavior |
| Normal `--channels` | **Outstanding external admission gate**; test with exact org-allowed or official identity and no development override |
| Privacy / retention / contact | **Owner confirmation required**; public policy coverage and monitored disclosure destination |
| Submission | **Not submitted**; Peyton reviews identity, evidence and text, then authorizes the external step |

Record evidence in `evidence.md` with exact revisions, dates, account scope and
redacted request/turn IDs. Do not include customer prompts, account tokens,
private repository content or unrelated terminal sessions.
