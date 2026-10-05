#!/usr/bin/env bash
# Checks that RELEASE_TOKEN still authenticates and is not about to expire.
#
# An expired token fails the release at checkout with "could not read Username
# for 'https://github.com'", which says nothing about the token, and nothing
# is published: the DITTO-249 fix sat merged but unreleased for a day because
# of exactly that. GitHub reports a PAT's expiry in the
# github-authentication-token-expiration response header, so read it here.
#
# Usage: check-release-token.sh [warn-days]
#   Fails if the token is missing or rejected, or expires within warn-days
#   (default 0: only an already-expired token fails).
set -euo pipefail

warn_days="${1:-0}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
rotate="Rotate it: create a token as described under \"Release authentication\" in CLAUDE.md, then run gh secret set RELEASE_TOKEN -R ${repo}."

if [ -z "${RELEASE_TOKEN:-}" ]; then
  echo "::error::RELEASE_TOKEN is not set. ${rotate}"
  exit 1
fi

headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
status="$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' \
  -H "Authorization: Bearer ${RELEASE_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${repo}")"

if [ "$status" != "200" ]; then
  echo "::error::RELEASE_TOKEN was rejected by GitHub (HTTP ${status}); it has probably expired or been revoked. ${rotate}"
  exit 1
fi

expiry="$(grep -i '^github-authentication-token-expiration:' "$headers" | cut -d' ' -f2- | tr -d '\r' || true)"
if [ -z "$expiry" ]; then
  echo "RELEASE_TOKEN authenticates and has no expiry."
  exit 0
fi

expires_at="$(date -u -d "$expiry" +%s)"
days_left="$(( (expires_at - $(date -u +%s)) / 86400 ))"
echo "RELEASE_TOKEN authenticates; it expires ${expiry} (${days_left} days)."
if [ "$days_left" -lt "$warn_days" ]; then
  echo "::error::RELEASE_TOKEN expires in ${days_left} days (${expiry}). ${rotate}"
  exit 1
fi
