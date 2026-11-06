# Ditto's Claude Code hooks

Design note for [DITTO-2479](https://omniaura-team.atlassian.net/browse/DITTO-2479).

## Why hooks

`heyditto claude` has three inference modes. In Router mode, Ditto runs every
model call, so it can optimize, route, record, compact and recall. In
`--mcp-only` (the person's own Claude account) and `--cliproxy` (a local
proxy), Ditto supplies MCP tools and Remote Control, but the model calls never
pass through it. In those modes Ditto has no way into the agent loop.

Claude Code hooks are that way in. They work the same whoever runs
inference, they are configured through the same `--settings` value that
already carries native MCP's permission rules, and Claude Code merges them
with the person's own hooks instead of replacing them.

Hooks do **not** let the Router optimize or smart-route inference in those
modes, because the model calls still do not reach it. That needs
[DITTO-2480](https://omniaura-team.atlassian.net/browse/DITTO-2480): CLIProxy
inference forwarded through Ditto's servers. We need both. Hooks put policy
and lifecycle in Ditto's hands, and the forward puts inference there.

## The cost: the session is not vanilla Claude Code

A session with Ditto hooks is no longer a strict one-to-one copy of plain
`claude`. A Stop hook can keep Claude working after it meant to stop. That
changes what the person sees, how long a turn lasts and what it costs. So:

- Hooks are **opt-in per repository** (`claude_hooks` in a checked-in
  `.ditto/endpoints/<name>.toml`), never on by default.
- `--no-hooks` leaves them out for one launch, and the launch banner says
  `hooks=off (--no-hooks)`.
- The banner names every attached hook and its profile file:
  `hooks=Stop (unpushed) (.ditto/endpoints/dev.toml)`. `--dry-run` lists them
  under `hooks`.
- The block reason Claude reads starts `Ditto stop check (<file>)`, so neither
  the agent nor the person mistakes Ditto's rule for Claude Code's own.

## Survey of Claude Code hook events

Source: the [hooks reference](https://code.claude.com/docs/en/hooks), read
2026-11-06. It documents 33 events. These are the ones relevant to Ditto.

| Event | Fires | Can steer | Ditto's use |
| --- | --- | --- | --- |
| **Stop** | Claude finishes responding | `decision: "block"` + `reason` continues the turn | **Implemented.** Completion gate (below). Later: turn reporting for non-Router modes. |
| SubagentStop | a subagent finishes | block keeps the subagent going | Not now. The parent owns the work; gating every subagent would multiply the cost. |
| SessionStart | session begins, resumes, clears or compacts | `additionalContext` | **Next.** Endpoint context and memory brief in `--mcp-only` / CLIProxy, where the Router cannot add its prompt. |
| UserPromptSubmit | before Claude reads a prompt | block, `additionalContext` | Candidate for recall in non-Router modes. Runs before every prompt, with a 30 s default timeout, so it needs a latency budget first. Remote Control already relays it. |
| PreToolUse | before a tool call | allow, deny, ask, defer, rewrite input | Later: Ditto policy for Claude's own tools (Bash, Edit). Ditto tools are already gated server-side and through MCP permission rules. Remote Control already relays it. |
| PermissionRequest / PermissionDenied | permission dialog / auto-mode denial | decide the dialog | Remote Control relays these to the app already. |
| PostToolUse / PostToolUseFailure / PostToolBatch | after tool calls | feedback to Claude | Remote Control relays these already. No policy use yet. |
| PreCompact / PostCompact | around compaction | block compaction | Later. In Router mode the Router compacts. Native mode could save the summary to Ditto. |
| StopFailure | a turn ends on an API error | none | Later: error reporting for CLIProxy turns, which Ditto cannot see now. |
| SessionEnd | session terminates | none (1.5 s budget) | Not needed. The launcher already revokes the key and records the session on exit. |
| Notification | Claude notifies | none | Remote Control relays it already. |

Other events (Setup, UserPromptExpansion, MessageDisplay, SubagentStart,
TaskCreated, TaskCompleted, TeammateIdle, InstructionsLoaded, ConfigChange,
CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove,
PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult) have no Ditto
use yet.

Hook types are `command`, `http`, `mcp_tool`, `prompt` and `agent`. Stop uses
`command` because it must read the person's local git state. An `http` hook to
Ditto (with the session key from an allowed env var, the way MCP headers get
it) is how turn reporting would ship once a backend ingest endpoint exists.

## Stop, as implemented

```toml
# .ditto/endpoints/dev.toml
[settings]
claude_hooks = { stop = { checks = ["unpushed"], repos = [".", "workspaces/*/*"] } }
```

When Claude finishes a turn, the hook checks each listed repository, as a
path relative to the repository that holds `.ditto/`. In those paths `*`
matches one directory name and hidden directories are skipped. For each
repository it reports:

- uncommitted changes (`git status --porcelain`);
- commits ahead of the branch's upstream;
- with no upstream, commits no remote-tracking ref contains, confirmed with
  `git ls-remote`. A single-branch clone pushed without a refspec has no
  remote-tracking ref and would otherwise always read as unpushed (the trap
  in heyditto-stack's AGENTS.md).

When it finds something, it returns `{"decision":"block","reason":…}`, and
Claude gets the list and is asked to push the work or say why it is left.

It blocks **at most once per stop**. When Claude is already continuing
because of a Stop hook (`stop_hook_active`), the turn ends, so a condition
Claude cannot fix never traps the session. Claude Code also has its own cap:
eight consecutive blocks.

It **under-reports rather than guesses**. A repository with no remote, a
detached HEAD, an unreachable remote, a remote tip this clone never fetched,
or any git error counts as nothing to report. The script exits 0 in every
case. Git calls time out after 5 s (8 s for `ls-remote`), at most 64
repositories are checked, and the hook's own timeout is 60 s.

What it carries: the hook command holds the repository root, check names, path
patterns and profile file name, base64url-encoded in argv. That is no key and
no token.

Why this check first: it is the one rule every agent in heyditto-stack is told
to follow ("never end a turn with uncommitted or unpushed work") that nothing
enforces at the moment of stopping. It needs no backend change, and it applies
the same in every inference mode.

## How it attaches

- `src/agents/claude-hooks.ts`: config parsing and the `--settings` fragment.
- `src/agents/claude-stop-hook.ts`: the hook script Claude Code runs.
- `planClaude` merges native MCP permissions and Ditto's hooks into **one**
  `--settings`, which also absorbs a `--settings` the person passed. Claude
  Code honours only one. Remote Control's relay hooks are folded into the same
  value, so the `Stop` list holds both hooks.
- The repository profile is read at launch. Hooks attach when the endpoint was
  chosen by that profile, or when `--endpoint` / a resumed session names the
  same endpoint and owner. Another endpoint gets none of the repository's
  hooks.
- `heyditto repo apply` validates `claude_hooks` and does **not** send it. The
  paths only mean something inside this repository, so this setting is not
  stored on the endpoint.

## Not verified

- Precedence between `--settings` hooks and settings-file hooks is not stated
  in the documentation: the hooks reference says settings levels merge, and
  the CLI reference says `--settings` overrides "the same keys". Remote Control
  has attached its hooks this way in every TUI launch since it shipped, so
  this change does not create that question, but it has not been checked
  against a session that also has project Stop hooks.
- The tests run the compiled hook directly with Claude Code's documented Stop
  input. A live interactive Claude Code session with the hook attached has not
  been run.
