# Ditto Remote review evidence

Prepared October 28, 2026. Status: candidate; not submitted or approved.

The final owner-review handoff must bind the PR head, clean `BUILD.json`, Claude
version, manifest validation, automated tests and a sanitized packaged-plugin
live prompt/reply demonstration. Record missing evidence as outstanding rather
than claiming prior server-adapter tests cover the plugin.

| Evidence | Result |
| --- | --- |
| Source PR / revision | CLI PR #113; current owner-review runtime artifact `1756fd7b18e0a7a9e33d138fe5ab90cde3bd3081`, built clean. This packet update changes documentation only; the runtime artifact remains pinned |
| Dependency lock | Clean artifact `BUILD.json` records SHA256 `34866abefa150be787ee9be290cbd8137ff6db50c45a7c81e08ca66c966d8171`; exact integrity pins are in `runtime/package-lock.json` |
| Automated tests at runtime source | `1756fd7` Depot verification: 424 total tests, 421 passed, zero failed, three opt-in installed-Codex tests skipped; focused plugin/build/channel suite: 19 passed |
| Plugin startup tests | Existing launcher identity reuse; standalone native registration; no endpoint/key creation on missing selection |
| Hook executable test | Homebrew opt symlink must resolve to the same Node as the active Cellar executable; otherwise original executable retained |
| Manifest validation | Claude Code 2.1.312: clean `1756fd7` plugin manifest and generated local-review marketplace passed without warnings; archive integrity passed |
| Bundled MCP protocol | Clean `bc06e2f` runtime probe passed initialization, actual notification transport, explicit acknowledge and reply; this synthetic MCP client is not a native Claude live test |
| Live packaged-plugin Browser → Claude → reply | **Passed October 28, 2026** against clean artifact `1756fd7`: visible inbound prompt, actual acknowledge/reply calls and matching Ditto response; native Opus 5.5 / Claude Max, development override only |
| Installed artifact identity | All 4,165 compared installed bundle files matched the reviewed `1756fd7` distribution; no files changed |
| Owner-review archive | `ditto-remote-1756fd7-owner-review.zip`; SHA256 `0ede757255e09b1f21a64d249ce53ce55d057de64045163435251bf4cc0e05a9` |
| Ordinary approved `--channels` | Outstanding external approval / consenting org allowlist gate |
| Revoked-key and two-account backend negatives | Pending final paired QA evidence |
| Submission / marketplace publication | Not performed |

## Current packaged native Claude live run: 1756fd7

The coordinator installed the exact clean
`1756fd7b18e0a7a9e33d138fe5ab90cde3bd3081` owner-review distribution through the
local review marketplace. `BUILD.json` recorded a clean source tree. All 4,165
compared installed bundle files matched that distribution; no runtime file was
changed for the demonstration. The archive SHA256 is recorded above.

Claude Code 2.1.312 displayed **Opus 5.5 / Claude Max** with the native account;
Anthropic Router environment overrides were unset. The development channel
opt-in was explicit. The unique Browser prompt visibly arrived in the terminal,
and Claude made the two actual MCP calls, `acknowledge` and `reply`. The matching
response `PACKAGED_CHANNEL_1756FD7_20261028_C` appeared in Ditto. The backend
readback recorded `lastTurn.status: finished` at
`2026-10-28T21:49:10.847759555Z`.

Redacted synthetic-run references are session `108c67f1…` and turn `210e3222…`.
Complete receipts remain in the coordinator's private owner-review evidence.
Portable evidence basenames are:

- `packaged-1756-native-evidence.json`
- `ditto-remote-1756fd7-build-provenance.json`
- `packaged-1756-native-terminal.png`
- `packaged-1756-native-browser.png`

The build-provenance snapshot initially marked the native retest pending. The
later `packaged-1756-native-evidence.json` records its successful completion;
this does not rebuild or relabel the archive. This documentation update also
does not change the pinned runtime, archive or installed files.

This proves visible packaged-plugin prompt delivery, actual model receipt and
an explicit reply for **1756fd7 under the development override**. It does not
prove ordinary approved `--channels`, organization-policy admission, revoked
credentials, two-account backend isolation or complete submission-security
acceptance. Those gates remain outstanding. Review and sanitize the preserved
screenshots before any external sharing; no screenshots, private account IDs,
private local paths or credentials are committed with this packet.

## Historical packaged native Claude live run: 4a2debc

The coordinator installed the exact clean `4a2debc3aa478e981c59c225bb10e9fac5be8867`
bundle from the local `ditto-remote-review` marketplace in a disposable local
review project. `BUILD.json` had `dirty: false`.
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

- Session: `b8280237…`.
- Turn: `5c7969c1…`.

The coordinator preserved these local owner-review originals, identified here
by basename. Their personal absolute paths are not part of the committed packet:

- `packaged-native-channel-terminal.png`
- `packaged-native-channel-browser.png`

Review and sanitize screenshots before external sharing. This run proves
visible packaged-plugin delivery, actual model receipt and an explicit reply
under the development override. It does **not** prove an organization-managed
ordinary `--channels` launch, Anthropic default admission, revoked-key behavior,
two-account backend isolation or complete submission-security acceptance.
Those checks remain outstanding in the table and submission draft. A generic
MCP connector demonstration is a separate result.

The earlier `4a2debc` artifact, ZIP and evidence remain historical and unchanged.
Build invocation, Git provenance and startup diagnostic hardening were included
in the separately built and live-tested `1756fd7` artifact above. Keep each
artifact's runtime revision separate from the packet's latest documentation
revision; do not use the historical run as substitute evidence for another build.

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
