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
