# Claude Code remote input

Work tracked by DITTO-1648 (images and long prompts) and DITTO-1649 (queue,
steering, Send Now, and Stop). This branch is an incremental implementation,
not a claim that the complete input matrix is supported or released.

## Attachment transport

The backend resolves authenticated thread attachment IDs to expiring presigned
GET URLs. The CLI downloads each attachment with a single GET, verifies its
declared size and required SHA-256, and writes it to the session's attachment
directory. Redirects, invalid sizes, mismatched bytes, repository symlinks, and
existing destination files with different bytes fail delivery. An identical
regular file may be reused after reconnect; symlinks are always refused.
Duplicate names receive distinct filenames, including case-only differences.
Names are sanitized for Windows, and colon-bearing turn IDs use a hashed
directory component. Git exclusion checks use the actual session subdirectory. Download failures must not be reported as Claude receiving an image.

For custom Channels, the original prompt is kept verbatim, including long
multiline text and trailing whitespace. Absolute downloaded paths are carried
in the channel's `attachment_paths` metadata as a JSON array. Server
instructions tell Claude to Read those files. Text that resembles an attachment
annotation does not create trusted attachment metadata. A notification write
is transport delivery only; acknowledge/reply remain separate receipts.

Claude's TUI receives bracketed pasted text with quoted relative `@file`
references. Two trailing newlines close the file-completion menu so the submit
key sends the prompt. Other harnesses and headless behavior retain plain paths.
A real Claude Code2.1.312 loopback probe confirmed this format, including a
filename with spaces, produced an actual PNG image block:1,334decoded bytes
and an exact SHA-256 match to the synthetic source. This proves native format
compatibility, not the complete app/upload/CLI delivery path. Channels file Read
still needs native image-content evidence beyond the metadata transport tests.

## Input actions

Stop must continue to interrupt the current response independently of any new
input. The existing TUI implementation sends Claude's Escape key. Keep queued
input cancellation separate from stopping the response already running.

Queue, steering, and Send Now (Ctrl+Enter) are not implemented by this initial
attachment change. Native Channels notifications are normally consumed at the
next turn; the documented Channels event schema has no force-now or interrupt
field. Do not advertise unsupported controls based on invented metadata. A
native TUI probe confirmed Ctrl+Enter cancels the running request and submits
queued input plus the new direction. Ditto's typed send-mode contract and its
terminal key encoding still need implementation and testing.

Before release, exercise both transports visibly with actual Claude Code:
image bytes present in native model context; long multiline text intact;
queued input while busy; Send Now/steering while busy; Stop while busy;
Stop with queued input; failed uploads/downloads; and reconnect/redelivery.
Use the portable backend `scripts/harness-probe` tools with synthetic fixtures.
Preserve evidence separately for transport receipt, native receipt, and final
response. Unit tests using a fake harness are not native behavior evidence.


Terminal permission answers after steering are correlated by native session,
input epoch, unique tool/input fingerprint and exact tool-use ID. A matching
PostToolUse/Failure can resolve the dialog; native No in observed2.1.312 emits
neither completion hook, but writes the exact user/tool_result with is_error.
The CLI polls only that active main-session UUID file, anchored before the tool
outcome by offset, file identity and a capture-boundary hash. Reads are limited
to256KiB of complete appended rows. It never scans session inventories or returns
raw tool content. Replaced/truncated files, wrong session/ID/role, sidechains,
ambiguous matches and oversized missing rows fail closed. An explicit answer or
new native prompt remains the recovery for unconfirmed metadata.

A local completed permission with no remote turn can rearm the existing quiet
fallback even before the first steer. Still-live dialogs, subsequent outstanding
tools and terminal activity hold it. Quiet is a heuristic rather than an exact
native model-busy guarantee. Uncorrelated Stop never resolves a live dialog;
Escape remains independent and does not await the metadata reader to interrupt.
The observed2.1.312 /model and/clear commands emit no UserPromptSubmit, so their
builtin behavior does not justify a blanket local fallback change.

Authoritative dialog resolution emits an optional resolvedPromptId on existing
session.status, with current status rather than a fabricated idle event. The
paired backend clears only that exact pending ID for the owner/current socket.
The latest resolution is replayed after a same-process reconnect; stale IDs
cannot clear a newer prompt. Older backends ignore this additive field and may
retain stale permission UI until updated. Existing running Claude processes need
a normal relaunch/resume to load the added native hooks.


New Claude TUI hosts advertise `capabilities.promptDelivery.promptResolution`.
Only the exact socket that receives a remote answer may declare that capability.
The paired API then leaves the dialog pending until the host sends its matching
`resolvedPromptId`; legacy sockets retain API-driven clearing. A sequential API
retry with an already-recorded answer sends no second keypress. Concurrent API
requests are not promised exactly once: the existing answer ledger is recorded
after socket delivery. The host itself ignores an answer after its pending ID
has cleared. Reconnect reads the new socket declaration, never the physical
host's last capabilities. API success alone does not prove native acceptance.

Attachment rendering preserves the supplied text, including leading/trailing
spaces and CRLF, before appending the separate native file-reference block.
Native editor normalization remains the native client's behavior.

If local typing or a public PTY write intervenes in an unsubmitted paste, abort
preserves that foreign input instead of sending undo. The owned PTY then latches
input uncertainty: queued or immediate future prompt pastes fail visibly through
the existing turn error receipt before a new active turn is created. They cannot
silently append to the uncertain editor. Independent Escape Stop remains available,
even without an active remote turn. No late unscoped hook clears this latch.
Recovery currently requires reviewing the terminal draft and normally relaunching
the session; a new owned PTY starts with fresh input state. DITTO-1649 tracks a
less disruptive recovery based on authoritative input ownership. This rare
relaunch-only path is conservative and never automatically clears device input.
