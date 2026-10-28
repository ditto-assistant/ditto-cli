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
| Manifest validation | `claude plugin validate .tmp/ditto-remote-review-1` passed; optional missing-icon warning and marketplace-install-line advice remain for owner review |
| Live packaged-plugin Browser → Claude → reply | Pending root coordinator's visible live test |
| Ordinary approved `--channels` | Outstanding external approval / consenting org allowlist gate |
| Revoked-key and two-account backend negatives | Pending final paired QA evidence |
| Submission / marketplace publication | Not performed |
