# Codex Desktop setup recovery

Close Codex Desktop and other programs editing its settings before changing the
setup. `heyditto codex-app` stages and validates the model catalog, configuration,
login and Ditto setup record before replacing any of them. Existing backups are
never overwritten. The previous endpoint key remains valid until all new local
files and the final commit record have been synced. Only then is it revoked.

Initial CLI sign-in also saves a complete profile through a synced temporary file
and atomic replacement, preserving its existing Desktop record and defaults.
Partial-write or rename failure keeps the prior profile bytes intact. The shared
profile writer keeps existing symlinks and refuses to bypass read-only files;
successful profile saves retain the existing owner-only mode0600 behavior. This
single-file protection does not serialize unrelated concurrent profile merges.

An ordinary failure before that commit restores the original bytes and modes and
revokes only the new key when the unchanged login can safely be restored. New login and state files use mode0600. Existing
configuration and catalog modes are preserved. New original-login backups use
mode0600; existing backup files and permissions are kept.

After interruption, the next `codex-app` invocation checks for recovery before
starting another setup. Run this to recover without creating another key:

```sh
heyditto codex-app --recover
```

A prepared transaction first verifies that the login is unchanged, then restores
the old files and revokes its known new key. An edited or unreadable login might
still use the new key; recovery then stops without further file or key changes
for manual reconciliation. A failed login restoration also stops further key
cleanup. Earlier cleanup may already have revoked a key before interruption;
the recovery record cannot always establish that both keys remain valid.
A committed transaction keeps the new files and finishes previous-key cleanup.
Cleanup errors retain the recovery record so the same command can retry without
minting another credential. `--dry-run` never performs recovery or writes files;
it asks for recovery first when a pending record exists.

Recovery compares file contents and permissions before replacing anything. If a
file changed after interruption, its edit is kept. When the login can safely be
restored, prepared recovery restores other unchanged files and revokes only the
new key, then stops for manual review if another file conflicts.
Committed recovery with an intervening edit makes no further key changes, since
the edit might have selected the previous login. Earlier cleanup may already
have revoked that key before interruption. The protected copies remain available
for review. Do not delete the recovery directory until the files and keys have
been reconciled.

The version2 manifest binds recovery to the canonical paths of every target,
including the Ditto profile file, and the normalized API server and namespace.
Changing `DITTO_CONFIG_DIR`, `XDG_CONFIG_HOME`, `CODEX_HOME` or `DITTO_API_BASE` to a
different target rejects recovery before any setup file or key is changed. Restore
the original environment before retrying. Aliases resolving to the same canonical
paths and equivalent server URLs remain valid. An older journal without these
bindings is left for manual reconciliation; its intended environment is not guessed.

The recovery directory is `CODEX_HOME/.ditto-codex-app-recovery` (normally under
`~/.codex`). It has mode0700. Its JSON manifest contains target paths/API base, hashes, file modes and
endpoint/key IDs, with no login tokens or plaintext keys. Original/staged payloads
can contain credentials and are mode0600 inside that private directory. A SQLite
write lock serializes setup/recovery across processes and is released by the OS
when a process dies. SQLite is loaded only when setup/recovery takes the lock;
unrelated commands do not load it. SQLite is built into the supported pinned Node
runtimes; there is no new package dependency. The small lock database remains after cleanup
and contains no credentials.

## Limits

The existing `--unset` restore operation remains outside this multi-file setup
transaction. It first settles any pending setup recovery under the same lock, but
its own configuration/login restoration is not journaled as one recoverable unit.
The shared profile save is atomic; that does not make the whole undo operation
crash-atomic. This change does not claim transactional undo/redo for `--unset`.

The existing revoke API returns404 for both an unknown key and an already-revoked
key. If a process dies after successful revocation but before recording cleanup,
its retry cannot distinguish those cases. The client keeps recovery pending;
it does not claim a generic404 proves revocation. Automatic completion of this
window requires the backend's authorized, same-endpoint idempotent-revoke fix.
If a login or file edit stops recovery before that retry, the conflict message
reports that no further changes were made, not that both keys are still valid.
Until that prerequisite lands, reconcile the key and protected recovery record
manually when this response occurs. The local setup remains restored or committed
as appropriate, and recovery never mints another key to work around it.

This is a recoverable sequence of atomic file replacements, not one filesystem
transaction spanning Codex and Ditto directories. While replacements are in
progress another program could observe mixed files. The shared lock coordinates
`codex-app` processes; external editors and Codex do not take it. Content checks
detect intervening edits before each replacement/recovery step, but an external
writer can race the final check and rename. Keep those programs closed during
setup/recovery. Symbolic-link target files and unsafe recovery permissions fail
closed instead of being replaced.

Files and containing directories are synced on macOS/Linux, including newly
created ancestors. New protected setup/recovery fails closed on Windows because
POSIX modes cannot verify Windows ACLs; an ACL-aware adapter is required before
that path is available there. Dry-run and undo of existing Windows wiring remain
available without creating recovery payloads. Process-interruption recovery is
tested on local filesystems; network filesystems and hardware that does not honor
sync/locking are outside the guarantee.

Remote issuance cannot participate in this local transaction. If the server
accepts creation but the response is lost, lacks an ID, or the process dies before
the returned ID is durably recorded, the client cannot identify that new key for
revocation. Existing local files and the previous key remain untouched. The CLI
reports uncertain issuance when it observes that failure. Inspect endpoint keys
before retrying, or let the unknown key expire. IAM use-only session keys are
bounded by the server's session TTL; legacy callers retain their configured
expiry, including the existing one-month default. Closing this response/journal
window requires server-side idempotent issuance/reconciliation; the client does
not retry issuance automatically or fall back to a different account.

A missing/corrupt manifest or recovery copy is never guessed around. Recovery
stops and preserves the remaining protected files for manual review. An OS or
disk failure before the initial journal is synced can leave an incomplete
recovery directory; no local target replacements have started at that point.
