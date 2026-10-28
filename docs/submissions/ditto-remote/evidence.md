# Ditto Remote review evidence

Prepared October 28, 2026. Status: candidate; not submitted or approved.

The final owner-review handoff must bind the PR head, clean `BUILD.json`, Claude
version, manifest validation, automated tests and a sanitized packaged-plugin
live prompt/reply demonstration. Record missing evidence as outstanding rather
than claiming prior server-adapter tests cover the plugin.

| Evidence | Result |
| --- | --- |
| Source PR / revision | Populated in the PR and owner handoff |
| Dependency lock | SHA256 recorded in generated `BUILD.json`; exact integrity pins in `runtime/package-lock.json` |
| Automated channel tests | Local `npm run verify`: 415 tests passed on Node 24.22.1, including notification, explicit model receipt/reply, wrong ID, reply bound, deduplication, expiry and stalled notification handling |
| Plugin startup tests | Existing launcher identity reuse; standalone native registration; no endpoint/key creation on missing selection |
| Hook executable test | Homebrew opt symlink must resolve to the same Node as the active Cellar executable; otherwise original executable retained |
| Manifest validation | Claude Code 2.1.312 validates the manifest; the versioned build supplies its computed version and vendors the canonical 512px icon. Validate the final clean bundle and its local marketplace separately |
| Bundled MCP protocol | Clean `bc06e2f` runtime probe passed initialization, actual notification transport, explicit acknowledge and reply; this synthetic MCP client is not a native Claude live test |
| Live packaged-plugin Browser → Claude → reply | Pending root coordinator's visible live test |
| Ordinary approved `--channels` | Outstanding external approval / consenting org allowlist gate |
| Revoked-key and two-account backend negatives | Pending final paired QA evidence |
| Submission / marketplace publication | Not performed |

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
