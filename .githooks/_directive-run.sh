#!/usr/bin/env sh
# Package-relative Directive git-hook helper (AC9.9 / AC9.12 / #5994).
# Sourced by pre-commit/pre-push; defines run_directive.
# Shared entry order: disable → runtime missing (project install, by lockfile) → pin bin.js.
if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$REPO_ROOT" ]; then
  echo "directive hooks: unable to resolve repo root." >&2
  exit 1
fi
run_directive() {
  # #3039 / #5543 / #5994 F1: disable BEFORE requiring pin bin.js; quiet skip.
  _kill="$REPO_ROOT/.deft-directive-disable"
  if [ -f "$_kill" ] && [ ! -L "$_kill" ]; then
    if ! git -C "$REPO_ROOT" ls-files --error-unmatch -- .deft-directive-disable >/dev/null 2>&1; then
      return 0
    fi
  fi
  RUNTIME_BIN="$REPO_ROOT/node_modules/@deftai/directive-runtime/dist/bin.js"
  if [ ! -f "$RUNTIME_BIN" ]; then
    if [ -f "$REPO_ROOT/pnpm-lock.yaml" ]; then
      _directive_install='`pnpm install --frozen-lockfile`'
    elif [ -f "$REPO_ROOT/package-lock.json" ]; then
      _directive_install='`npm install`'
    else
      _directive_install='`npm install` (or `pnpm install --frozen-lockfile`)'
    fi
    echo "directive hooks: missing $RUNTIME_BIN" >&2
    echo "Directive can't run: @deftai/directive-runtime is not installed in this project. Run $_directive_install in a terminal in this project." >&2
    exit 1
  fi
  node "$RUNTIME_BIN" "$@"
}
