# Ditto Remote security and data flow

Engineering review draft, October 28, 2026. This describes the implemented
adapter and plugin; it is not an external security certification.

```mermaid
sequenceDiagram
    participant U as Signed-in user in Ditto app
    participant D as Ditto authenticated API / session service
    participant H as Local host bridge / plugin MCP process
    participant C as Native Claude Code
    U->>D: Prompt for caller-owned session
    D->>D: Authenticate user and authorize session/graph access
    D->>H: Authenticated WebSocket turn.deliver(sessionId, turnId)
    H->>H: Match local session; bound pending queue; verify attachment digest
    H-->>D: Transport turn.ack
    H->>C: notifications/claude/channel with turn metadata
    C->>H: acknowledge(turn_id)
    H-->>D: turn.started (actual model receipt)
    C->>C: Native model and ordinary local permissions
    C->>H: reply(turn_id, text)
    H-->>D: turn.finished + explicit response
    D-->>U: Receipt and reply
```

## Trust boundaries

The app user is authenticated by Ditto; backend authorization, not a caller's
claimed `sessionId`, determines access to a host/session. A separate stored CLI
key authenticates the host WebSocket and management API. The plugin resolves
that existing CLI login privately. Tokens never appear in manifests, argv,
channel event text or the submission packet. The bundled server does not
create another standing key. Revocation is a backend/account control, and its
actual connected-socket behavior must be exercised with a disposable key.

The backend-to-plugin socket is trusted for session routing; the **content is
untrusted**. Only matching-session turns enter the channel. `turn_id` comes
from channel metadata and is accepted only while pending in this process.
Wrong/expired IDs cannot acknowledge or reply. Every explicit reply is bounded
to 64 KiB. Neither channel text nor attachment paths are permissions to run
commands. Claude's own permissions and organization policy continue to apply.

The plugin requires `DITTO_REMOTE_CHANNELS_ENABLED=1` before registering a
session, so installation alone stays inactive. This scoped local opt-in does
not attest that Claude accepted the accompanying channel flag.

Installed MCP does not establish Channel admission. Claude can silently ignore
notifications if the identity was not opted in. A transport acknowledgement
therefore remains distinct from model receipt, which requires a successful
`acknowledge` tool call, and completion, which requires `reply`. Submission
acceptance must prove the exact packaged identity with a visible prompt.

## Data handled

| Data | Path and local persistence |
| --- | --- |
| Existing Ditto credential | CLI config or inherited environment → authenticated Ditto requests; never sent as prompt content |
| Host/session metadata | Machine name, platform/version, working directory, harness and session ID → Ditto session service |
| Remote prompt | Ditto app → Ditto service → local channel → native Claude model context |
| Receipt/reply | Explicit Claude acknowledge/reply → Ditto service → user app |
| Native inference | Claude's existing provider/subscription; the plugin does not configure the inference URL/key or upload the full native transcript |
| Attachments | Service-supplied download URL → `.tmp/ditto/attachments/<turn-id>/`; basename sanitization, size/digest validation, private file mode; files remain until user cleanup |

Do not claim zero data egress: prompt content and explicit replies cross Ditto,
and native Claude handles the channel context under its existing account.
Ditto's service retention/deletion policy must be confirmed in the owner review.
The plugin does not add an automatic service-retention guarantee. Local pending
turns and the seen-ID cache are in memory. Local attachment deletion and native
Claude transcript retention are separate from uninstalling this plugin.

## Bounds and failure behavior

- At most 32 pending prompts per process. Unsupported turn kinds and a full
  queue finish with a clear unsupported/error result rather than executing.
- Model receipt deadline: ten minutes. Completion deadline after acknowledge:
  one hour. Late acknowledgements fail closed; expired prompts must be resent.
- Seen turn IDs: at most 1,000, scoped to the process. This limits duplicate
  delivery while connected; it is not durable exactly-once execution.
- Attachments use the shared CLI downloader, which checks declared size up to
  512 MiB per attachment and validates the downloaded bytes/hash. This is not
  a total disk quota or a streaming memory bound; review this limit before a
  broad customer rollout. Downloads are not active content execution.
- The host reconnects in the background and reannounces its session. A new
  standalone plugin process receives a new session identity; wrapper-controlled
  process restarts may reuse the wrapper's session identity.
- Interruption, remote native permission approval, slash-command execution,
  teleport and full native transcript mirroring are not plugin capabilities.

## Submission negatives to demonstrate

Use a minted non-production account and synthetic content. Try another user's
session; an unannounced/disconnected session while another session shares the
same host; a wrong/expired turn ID; duplicate socket delivery; disconnected
reply/reconnect; disabled Channel policy; and a revoked disposable credential.
Record observed behavior and limitations separately. Existing unit tests and
prior developer-adapter demos do not replace this final packaged-plugin run.
