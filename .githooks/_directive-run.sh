#!/usr/bin/env sh
# Package-relative Directive git-hook helper (AC9.9).
# Sourced by pre-commit/pre-push; defines run_directive.
if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$REPO_ROOT" ]; then
  echo "directive hooks: unable to resolve repo root." >&2
  exit 1
fi
RUNTIME_BIN="$REPO_ROOT/node_modules/@deftai/directive-runtime/dist/bin.js"
if [ ! -f "$RUNTIME_BIN" ]; then
  echo "directive hooks: missing $RUNTIME_BIN" >&2
  echo "Recovery: npm i -g @deftai/directive, then directive install --repair" >&2
  exit 1
fi
run_directive() {
  # #3039 / #5543: root local kill-switch — skip CLI spawn when flag is present,
  # not a symlink, and not tracked by git (tracked flag must not disable clones).
  _kill="$REPO_ROOT/.deft-directive-disable"
  if [ -f "$_kill" ] && [ ! -L "$_kill" ]; then
    if ! git -C "$REPO_ROOT" ls-files --error-unmatch -- .deft-directive-disable >/dev/null 2>&1; then
      echo "Directive is DISABLED for this project via root .deft-directive-disable (test/local kill-switch)." >&2
      echo "Git hooks skipping Directive CLI spawn (#5543 / #3039). Deposit may remain." >&2
      echo "Recovery: rm .deft-directive-disable && start a new agent session." >&2
      return 0
    fi
  fi
  node "$RUNTIME_BIN" "$@"
}
