# Ditto Remote: Claude Code channel approval plan

Owner: Peyton (submission and Anthropic relationship); engineering (plugin, evidence and fixes).
Tracking: DITTO-1585. Last checked: October 28, 2026.
Status: preparation only. Ditto has not been submitted or approved as a channel.

## Objective and current limits

Get Ditto's remote-control channel accepted for ordinary `--channels` launches,
while retaining the CLI terminal bridge for users and harnesses without Channels.
Approval is an external dependency with no promised outcome or review deadline.
The current implementation is a development adapter, enabled by
`--dangerously-load-development-channels server:ditto-remote`; its successful
native Claude Max tests do not establish approval or suitability for general
customer distribution. Do not market the development override as the approved
installation path.

Two independent decisions matter:

| Decision | Authority | Evidence of success |
| --- | --- | --- |
| Organization permits the Ditto plugin as a channel | Customer's organization owner/admin | Managed `channelsEnabled` and `allowedChannelPlugins` admit the exact plugin/marketplace identity; a real normal-flag test passes |
| Ditto joins the default channel allowlist | Anthropic | Anthropic confirms channel eligibility and an uncustomized supported account accepts the published plugin with ordinary `--channels` |

The official docs now describe organization-specific allowlists. This offers a
pilot path without assuming Anthropic will add Ditto to its default set. An
organization decision applies only inside that organization. Directory listing,
MCP connector verification and channel allowlisting must each be tracked
separately; obtaining one is not proof of the others.

## Review candidate

The plugin source now lives in `plugins/ditto-remote`; `npm run plugin:build`
produces an installable bundle with the existing channel server and exact-lock
production dependencies. See [the owner review draft](submissions/ditto-remote/submission-draft.md),
[security and data flow](submissions/ditto-remote/security-and-data-flow.md), and
[evidence checklist](submissions/ditto-remote/evidence.md). Packaging is separate
from channel admission, a public marketplace listing and final live evidence.

## 1. Prepare a reviewable plugin and submission packet

Engineering prepares a versioned plugin containing the local `ditto-remote`
stdio server, its manifest and documented MCP configuration. Select a stable
plugin slug and a Ditto-controlled marketplace identity before publishing;
plugin names cannot be casually renamed after installation. Reuse the current
adapter rather than forking a second protocol implementation. Installation,
authentication, pairing, session selection, revocation and upgrade/uninstall
must work from a clean profile. The review bundle implements this packaging; final validation and live evidence
are tracked in the packet. It has not been published as a marketplace plugin.

The packet should include:

- Public, reviewable source and a reproducible release with pinned dependencies,
  license, maintainer/contact details and a vulnerability-reporting route.
- A diagram of app → caller-owned session → authenticated host connection →
  local channel → acknowledgement/reply. Distinguish native inference from
  Router inference and explain which service receives each credential and datum.
- Sender authorization, session ownership, replay/reconnect behavior, bounded
  queues/payloads, expiration and revocation evidence. Treat channel text and
  attachments as untrusted input; remote senders acquire no extra tool authority.
- Data retention/deletion and privacy documentation. Native transcripts remain
  local; the app receives explicitly returned content. Do not promise that no
  data leaves the computer: prompts, receipts and replies cross Ditto's service.
- A short recording showing a unique Browser prompt arriving in native Claude
  Code and its explicit reply returning, plus negative tests for another user,
  revoked credentials, offline hosts and duplicate deliveries.
- Clear capability limits. The current adapter does not remotely approve native
  permission prompts, interrupt native turns, run terminal commands or provide
  full native transcript history. Any future permission relay needs a separate
  threat model and tests before inclusion in the submission.

Use synthetic accounts and sanitized evidence. Do not include tokens, customer
transcripts, private repository content or screenshots with unrelated work.
Run the current official plugin pre-submission checklist before submission.

## 2. Prove the organization-controlled pilot path

Engineering supplies an installable plugin and exact proposed managed settings
for an explicitly consenting pilot organization. Its owner enables Channels and
adds the precise plugin/marketplace pair to `allowedChannelPlugins`. These are
admin actions, not changes the Ditto launcher silently makes. Preserve the
organization's existing allowlist entries in the proposed configuration.

Test with ordinary `--channels plugin:<plugin>@<marketplace>` and no development
override. Include allowed and disallowed users, organizational denial, restart,
revocation and clean uninstall. Record the Claude version and authentication
method. Do not claim this path works until the packaged plugin passes these
checks. Personal Pro/Max users do not gain an organization allowlist merely by
installing a marketplace.

## 3. Ask Anthropic for default approval

The Channels reference specifically says to coordinate with an Anthropic partner
contact for listing in the official plugin marketplace; an ordinary community
marketplace is not accepted by the default channel allowlist. Use that contact
if Ditto has one, and ask for the channel-specific review route. Do not invent
a contact or infer admission from a generic plugin listing.

For the separate directory workflow, Peyton can submit the reviewed plugin
through the current developer portal at
[claude.ai/directory/manage](https://claude.ai/directory/manage), from the account
or organization that should permanently own its listing. The directory docs
require an eligible paid account; Team/Enterprise submissions need the relevant
owner/directory authority. The old submission-form shortlink now redirects to
the directory publication guide, so use the current portal workflow.

The submission must explicitly ask about **Claude Code Channels approval**,
not just a generic MCP listing. Ask whether directory review includes channel
allowlisting, which identity/version is approved, how updates are handled, and
whether any additional security review is required. The documented directory
review does not promise channel allowlisting, and we have not found a separate
public channel-approval application or guaranteed SLA. Use an existing Anthropic
relationship or the portal's support route to resolve that uncertainty; do not
invent an approval contact or imply a partnership.

If the plugin references Ditto's remote MCP service, follow the directory's
separate connector-submission guidance as applicable. Review any submission
terms with the owner at the actual submission step. This plan does not itself
submit forms, accept terms, publish a plugin or send external messages.

Peyton records the submission ID, owning organization, date, exact source
revision, sanitized packet and any channel-specific response in DITTO-1585.
Proposed cadence: one follow-up after ten business days without a response,
then follow Anthropic's guidance. This is our follow-up plan, not their SLA;
no scheduled outreach has been created.

## 4. Release only the path that was actually approved

After explicit default-list approval, engineering verifies a clean supported
account with the released plugin and ordinary `--channels`, without managed
allowlist overrides or the development flag. Verify native Claude inference,
visible prompt delivery, acknowledgement/reply, revocation and version upgrade.
Only then let the saved endpoint Channels setting select that approved plugin
path automatically. Keep Claude's own opt-in and organization controls intact.

If approval is declined, delayed or unavailable, keep the CLI terminal bridge
as the supported broad-compatibility path. Offer an organization-approved plugin
only where that organization has explicitly permitted it. Keep the local
Channels adapter clearly marked for development; never silently switch to it
when normal plugin approval fails. Record any fallback choice visibly before
launch and retain native/MCP-only versus Router labels in the app.

## Immediate next steps

1. Engineering: validate the packaged plugin and preserve a sanitized visible
   native prompt/receipt/reply recording; previous server-adapter tests already
   show both transports but do not prove this package or channel admission.
2. Engineering and Peyton: review the submission packet, confirm publisher,
   icon, monitored contact, policy coverage and proposed owning organization.
3. Peyton: review that packet and submit the channel-specific request through
   the appropriate account. Track responses and pilot evidence in DITTO-1585.

## Primary sources

- [Claude Code Channels](https://code.claude.com/docs/en/channels), especially
  research-preview availability, security and organization allowlists.
- [Channels protocol/reference](https://code.claude.com/docs/en/channels-reference).
- [Anthropic's official plugin directory](https://github.com/anthropics/claude-plugins-official),
  including submission routing and immutable plugin names.
- [Publish to the directory](https://claude.com/docs/directory/publish), including
  account ownership, review stages and separate plugin/connector submissions.
- [Plugin pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)
  and [submit a plugin](https://claude.com/docs/plugins/submit).

Re-check these sources before submitting: Channels and directory policy are
still changing. The claimed organization route above is documented capability;
Ditto-specific approval remains unverified.
