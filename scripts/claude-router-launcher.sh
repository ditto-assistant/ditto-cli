#!/bin/sh
# T3 Code's Claude provider can execute this file directly. Never store keys here.
set -eu

fail() {
  printf '%s\n' "ditto T3 launcher: $*" >&2
  exit 1
}

resolve_binary() {
  resolved=$(command -v "$1" 2>/dev/null) || fail "cannot find $2; set $3 to its absolute executable path"
  case "$resolved" in
    /*) ;;
    *) fail "$2 must resolve to an absolute executable path; set $3" ;;
  esac
  [ -x "$resolved" ] || fail "$2 is not executable"
  printf '%s\n' "$resolved"
}

claude_bin=$(resolve_binary "${DITTO_T3_CLAUDE_BIN:-claude}" Claude DITTO_T3_CLAUDE_BIN)

# T3 refreshes versions periodically. This path does not contact Ditto or mint a key.
if [ "$#" -eq 1 ]; then
  case "$1" in
    --version|-v) exec "$claude_bin" "$@" ;;
  esac
fi

heyditto_bin=$(resolve_binary "${DITTO_T3_HEYDITTO_BIN:-heyditto}" heyditto DITTO_T3_HEYDITTO_BIN)
# heyditto launches `claude` by name. Select the same executable for that child
# and use the Node installation alongside the selected heyditto, when present.
case "$claude_bin" in
  */claude) ;;
  *) fail "DITTO_T3_CLAUDE_BIN must point to an executable named claude; a symlink is supported" ;;
esac
export PATH="$(dirname "$heyditto_bin"):$(dirname "$claude_bin"):${PATH:-/usr/bin:/bin}"

# Keep each provider instance's CLAUDE_CONFIG_DIR and T3's protocol settings.
# Inherited native-account or gateway credentials must not select another route.
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
unset ANTHROPIC_CUSTOM_HEADERS ANTHROPIC_MODEL CLAUDE_CODE_OAUTH_TOKEN
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY

# Old CLI versions accept unknown options as Claude passthrough. Fail before a
# launch rather than silently forwarding our mode flags or using native auth.
help_output=$("$heyditto_bin" claude --help 2>&1) || fail "cannot inspect heyditto; check its Node runtime and installation"
for required_flag in --no-mcp-only --no-mcp --no-remote-control; do
  printf '%s\n' "$help_output" | grep -Eq -- "(^|[[:space:],])${required_flag}([[:space:],]|$)" ||
    fail "heyditto lacks $required_flag; install @heyditto/cli 3.4.0 or newer with its supported Node runtime"
done

session_id=
take_session_id=false
resuming=false
for argument in "$@"; do
  if [ "$take_session_id" = true ]; then
    session_id=$argument
    take_session_id=false
    continue
  fi
  case "$argument" in
    --session-id) take_session_id=true ;;
    --session-id=*) session_id=${argument#--session-id=} ;;
    --resume|--resume=*|-r|-r?*|--continue|-c) resuming=true ;;
  esac
done
[ "$take_session_id" = false ] || fail "--session-id requires a value"

# Arguments after `--` are owned by the SDK, including stdin/stdout wire flags.
# Fresh sessions share one native/trace id. Resume is resolved by heyditto's
# existing --resume handling and must never be combined with its --session flag.
set -- --no-mcp-only --no-mcp --no-remote-control -- "$@"
if [ "$resuming" = false ] && [ -n "$session_id" ]; then
  set -- --session "$session_id" "$@"
fi
if [ -n "${DITTO_T3_ENDPOINT:-}" ]; then
  set -- --endpoint "$DITTO_T3_ENDPOINT" "$@"
fi

# Preserve the SDK's pipes and signals. heyditto owns temporary-key cleanup.
exec "$heyditto_bin" claude "$@"
