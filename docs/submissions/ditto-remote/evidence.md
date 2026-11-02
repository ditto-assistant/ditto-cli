# Ditto Remote review evidence

Updated October 29, 2026. New review candidate; **not submitted, published or approved**.

## Current release-based candidate

The current package pins canonical npm `@heyditto/cli@2.41.0`, published by
[automatic release 40989344989](https://github.com/ditto-assistant/ditto-cli/actions/runs/40989344989).
Release tag `v2.41.0` and registry `gitHead` identify
`25c16ccc0c323edd2296658e2de5914b75b3a06f`; the provenance statement identifies
source merge `e5e41776b5f53806acc365bd3e12b5c85d88f596`.

- Canonical tarball SHA256: `e74778b249eba04bda71ff0a7cf86ba3a34e52a88d7af914b89a330d76a1d6e2`.
- Canonical archive SRI and dependency-lock digest: committed `plugins/ditto-remote/runtime-release.json`.
- Tested Modes source: `43f50c5b7a98f4e32bfe926f33e9283b8d135679`. All 262 compiled files were compared: 261 identical; only `update-lock.json.packageVersion` changed from 2.40.0 to 2.41.0, with the remaining object identical.
- Packaging source and six standalone adapter/helper overlay hashes: clean `BUILD.json` in each new bundle.

| Evidence | Current result / next gate |
| --- | --- |
| Canonical npm runtime | Registry SRI/SHA1/SHA256 verified; GitHub tag/registry gitHead matched; npm provenance statement retrieved and linked to the release workflow/source merge. This does not claim an independent Sigstore trust-root verification |
| Packaging / pairing automated controls | Local `npm run verify`: 503 total, 500 passed, 0 failed, 3 existing opt-in skips; 15 focused packaging/pairing tests pass. Removing archive verification makes the integrity control fail. Controls cover no endpoint/key creation on missing selection, inactive opt-in, wrapper identity reuse, standalone registration, sanitized errors and canonical runtime preservation. Exact-head Depot checks must be recorded separately |
| Manifest and local install | Record exact candidate validation and installed-file comparison in the owner-review receipt; installation alone does not prove channel delivery |
| Current packaged native Max test | **Pending coordinator-visible retest of this new artifact**; historical 1756 proof does not transfer |
| CLI terminal live proof | Separate tested Modes transport; does not prove Channels queue/steer/interrupt or plugin admission |
| Two-account / revoked-key negatives | Outstanding current packaged/backend acceptance |
| Ordinary `--channels` | Outstanding external default or consenting-organization admission gate |
| Submission/public marketplace | Not performed |

Only `plugin-server` and `session-link` compiled files overlay canonical release
bytes. The standalone plugin does not attach the selected endpoint's full MCP
catalog or correlate its registration UUID to Claude's transcript UUID.

## Historical artifact: PR113 / 1756fd7

Historical source PR: https://github.com/ditto-assistant/ditto-cli/pull/113.
Its preserved runtime is `1756fd7b18e0a7a9e33d138fe5ab90cde3bd3081`, archive
`ditto-remote-1756fd7-owner-review.zip`, SHA256
`0ede757255e09b1f21a64d249ce53ce55d057de64045163435251bf4cc0e05a9`.
The coordinator previously compared all 4,165 installed files and observed
Claude Code 2.1.312 / Opus 5.5 / Claude Max receive the unique prompt, make
actual acknowledge/reply calls and return `PACKAGED_CHANNEL_1756FD7_20261028_C`
to Ditto. Development override only. Its earlier 4a2debc demo is also historical.
Neither archive is rebuilt, relabeled, or used as the new candidate's native proof.

Keep exact new archive hashes, private receipts and sanitized screenshots in
the owner-review handoff. Do not commit credentials, customer prompts, private
absolute paths or unsanitized screenshots.

The follow-up controls distinguish invalid explicit-selector guidance, exact
physical entry-point execution (including symlinks and macOS temp aliases),
release ancestry, and offline registration from initialized host admission.
Unavailable stored endpoint selection intentionally remains fail-closed.
Historical b82d3e5 archive/install evidence predates this narrow follow-up and
must not be relabeled as the final rebuilt candidate.
