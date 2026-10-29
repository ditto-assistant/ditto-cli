# Claude Code remote input

Work tracked by DITTO-1648 (images and long prompts) and DITTO-1649 (queue,
steering, Send Now, and Stop). This branch is an incremental implementation,
not a claim that the complete input matrix is supported or released.

## Attachment transport

The backend resolves authenticated thread attachment IDs to expiring presigned
GET URLs. The CLI downloads each attachment with a single GET, verifies its
declared size and optional SHA-256, and writes it to the session's attachment
directory. Redirects, invalid sizes, mismatched bytes, repository symlinks, and
existing destination files fail delivery. Duplicate names receive distinct
filenames. Download failures must not be reported as Claude receiving an image.

For custom Channels, the original prompt is kept verbatim, including long
multiline text and trailing whitespace. Absolute downloaded paths are carried
in the channel's `attachment_paths` metadata as a JSON array. Server
instructions tell Claude to Read those files. Text that resembles an attachment
annotation does not create trusted attachment metadata. A notification write
is transport delivery only; acknowledge/reply remain separate receipts.

The TUI currently submits bracketed pasted text with relative attachment paths.
Native image attachment ingestion through that input path still requires a
real Claude Code content-block probe. Channels file Read also needs native
image-content evidence beyond the metadata transport tests.

## Input actions

Stop must continue to interrupt the current response independently of any new
input. The existing TUI implementation sends Claude's Escape key. Keep queued
input cancellation separate from stopping the response already running.

Queue, steering, and Send Now (Ctrl+Enter) are not implemented by this initial
attachment change. Native Channels notifications are normally consumed at the
next turn; the documented Channels event schema has no force-now or interrupt
field. Do not advertise unsupported controls based on invented metadata.

Before release, exercise both transports visibly with actual Claude Code:
image bytes present in native model context; long multiline text intact;
queued input while busy; Send Now/steering while busy; Stop while busy;
Stop with queued input; failed uploads/downloads; and reconnect/redelivery.
Use the portable backend `scripts/harness-probe` tools with synthetic fixtures.
Preserve evidence separately for transport receipt, native receipt, and final
response. Unit tests using a fake harness are not native behavior evidence.
