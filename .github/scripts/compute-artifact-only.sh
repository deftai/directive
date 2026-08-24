#!/usr/bin/env bash
# Merge-base artifact-only predicate (#3678).
# Writes artifact_only=true|false to $GITHUB_OUTPUT. Fail closed: unknown
# event, unusable base, or script error -> false (full stack).
#
# --no-renames: git name-only would otherwise emit only the destination of a
# rename into the allowlist and skip optional jobs.
set -eu

artifact_only=false
ZERO="0000000000000000000000000000000000000000"
EVENT_NAME="${EVENT_NAME:-}"
BASE_REF="${BASE_REF:-}"
PR_HEAD_SHA="${PR_HEAD_SHA:-}"
PUSH_BEFORE="${PUSH_BEFORE:-}"
HEAD_SHA="${HEAD_SHA:-}"

if [ "$EVENT_NAME" = "pull_request" ]; then
  git fetch --no-tags origin "$BASE_REF" || true
  BASE="origin/${BASE_REF}"
  TIP="$PR_HEAD_SHA"
elif [ "$EVENT_NAME" = "push" ]; then
  BASE="$PUSH_BEFORE"
  TIP="$HEAD_SHA"
else
  echo "Unknown event ${EVENT_NAME}; routing to full stack"
  echo "artifact_only=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

if [ -z "${BASE:-}" ] || [ "$BASE" = "$ZERO" ] || [ "$BASE" = "origin/" ] || [ -z "${TIP:-}" ]; then
  echo "Unusable merge-base (base=${BASE:-empty} tip=${TIP:-empty}); routing to full stack"
  echo "artifact_only=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Caller MUST pass ARTIFACT_ONLY_SCRIPT from a merge-base `git show`.
# Unset means the workspace (PR HEAD) copy would be used — fail closed.
if [ -z "${ARTIFACT_ONLY_SCRIPT:-}" ]; then
  echo "ARTIFACT_ONLY_SCRIPT unset; refusing HEAD predicate; routing to full stack"
  echo "artifact_only=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
files="$(git diff --name-only --no-renames --diff-filter=ACDMRT "${BASE}...${TIP}" || true)"
printf '%s\n' "$files"
result="$(printf '%s\n' "$files" | node "$ARTIFACT_ONLY_SCRIPT" --stdin || true)"
echo "$result"
case "$result" in
  artifact_only=true) artifact_only=true ;;
  *) artifact_only=false ;;
esac
echo "artifact_only=${artifact_only}" >> "$GITHUB_OUTPUT"
