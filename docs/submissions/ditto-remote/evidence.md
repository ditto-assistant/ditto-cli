# Ditto Remote review evidence

Prepared October 28, 2026. Status: candidate; not submitted or approved.

The final owner-review handoff must bind the PR head, clean `BUILD.json`, Claude
version, manifest validation, automated tests and a sanitized packaged-plugin
live prompt/reply demonstration. Record missing evidence as outstanding rather
than claiming prior server-adapter tests cover the plugin.

| Evidence | Result |
| --- | --- |
| Source PR / revision | CLI PR #113; live-tested clean runtime artifact `4a2debc3aa478e981c59c225bb10e9fac5be8867`. Documentation revision `d9aacd1c7537f92e331ef19f434851d726c512cf` changes only the approval plan, submission draft and plugin README |
| Dependency lock | Clean artifact `BUILD.json` records SHA256 `34866abefa150be787ee9be290cbd8137ff6db50c45a7c81e08ca66c966d8171`; exact integrity pins are in `runtime/package-lock.json` |
| Automated channel tests | Local `npm run verify`: 415 tests passed on Node 24.22.1, including notification, explicit model receipt/reply, wrong ID, reply bound, deduplication, expiry and stalled notification handling |
| Plugin startup tests | Existing launcher identity reuse; standalone native registration; no endpoint/key creation on missing selection |
| Hook executable test | Homebrew opt symlink must resolve to the same Node as the active Cellar executable; otherwise original executable retained |
| Manifest validation | Claude Code 2.1.312: clean `4a2debc` bundle plugin manifest and generated local-review marketplace both passed with no warnings; computed version and canonical 512px icon included |
| Bundled MCP protocol | Clean `bc06e2f` runtime probe passed initialization, actual notification transport, explicit acknowledge and reply; this synthetic MCP client is not a native Claude live test |
| Live packaged-plugin Browser → Claude → reply | **Passed October 28, 2026** against clean artifact `4a2debc`: unique Browser prompt visibly arrived in Claude Code 2.1.312, explicit acknowledge/reply calls completed, matching response appeared in Ditto; see the run below |
| Ordinary approved `--channels` | Outstanding external approval / consenting org allowlist gate |
| Revoked-key and two-account backend negatives | Pending final paired QA evidence |
| Submission / marketplace publication | Not performed |

## Packaged native Claude live run

The coordinator installed the exact clean `4a2debc3aa478e981c59c225bb10e9fac5be8867`
bundle from the local `ditto-remote-review` marketplace in the disposable
`/tmp/ditto-packaged-channel-qa-20261028` project. `BUILD.json` had `dirty: false`.
The Claude Code 2.1.312 banner displayed **Opus 5.5 / Claude Max**. Native
provider-routing environment overrides were unset and authentication was not
modified for this run.

Claude was launched with the development override
`--dangerously-load-development-channels plugin:ditto-remote@ditto-remote-review`
and the explicit scoped plugin opt-in. A unique Browser prompt visibly arrived
in the terminal as an inbound channel message. Claude made the two MCP calls,
`acknowledge` then `reply`; Ditto displayed the matching
`PACKAGED_CHANNEL_20261028_B` response. The backend session readback recorded
`lastTurn.status: finished` for:

- Session: `b8280237-b7aa-4788-9276-726d454b2c27`.
- Turn: `5c7969c1-3e34-45b7-b419-0614f51ccb60`.

The coordinator preserved these local owner-review originals:

- `/Users/peyton/.codex/visualizations/2026/10/27/01a17f77-71ab-7660-8bb1-45e4f1156912/remote-plugin-reliability/packaged-native-channel-terminal.png`
- `/Users/peyton/.codex/visualizations/2026/10/27/01a17f77-71ab-7660-8bb1-45e4f1156912/remote-plugin-reliability/packaged-native-channel-browser.png`

Review and sanitize screenshots before external sharing. This run proves
visible packaged-plugin delivery, actual model receipt and an explicit reply
under the development override. It does **not** prove an organization-managed
ordinary `--channels` launch, Anthropic default admission, revoked-key behavior,
two-account backend isolation or complete submission-security acceptance.
Those checks remain outstanding in the table and submission draft. A generic
MCP connector demonstration is a separate result.

No runtime bundle rebuild is needed for the subsequent documentation-only
updates. Keep the artifact's runtime revision separate from the packet's latest
documentation revision; do not relabel the tested artifact as a new runtime.

## Reported Mac mini hook failure

The coordinator's read-only Mac mini inspection confirmed existing Claude
process settings contain Ditto's `dist/remote/hook.js` with a missing
`/opt/homebrew/Cellar/node/26.9.0/bin/node`. The Node executable was removed by a
Homebrew upgrade. New hook settings now prefer the matching stable Homebrew
`opt/node/bin/node` link, including the Channels subprocess command.

This repairs future hook launches. A running Claude process retains its old
argv/settings, so the user must safely resume/relaunch that session to replace
the baked path; this change does not kill or rewrite active user sessions.
The hook failure affects turn-completion reporting and is separate from the
session-delivery/presence issue. It does not prove why a send reported offline.
