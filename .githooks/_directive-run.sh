#!/usr/bin/env sh
# Package-relative Directive git-hook helper (AC9.9 / AC9.12 / #5994 / #6740).
# directive-kill-switch-reader: v1
# Sourced by pre-commit/pre-push; defines run_directive.
# Shared entry order: kill record → runtime missing (project install, by lockfile) → pin bin.js.
if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
fi
if [ -z "$REPO_ROOT" ]; then
  echo "directive hooks: unable to resolve repo root." >&2
  exit 1
fi
_directive_kill_warned=""
# #6740: kill record verdict (valid | absent | an invalid reason). CR removed (tr), then exact
# whole lines (grep -qxF); the record binds to git rev-parse --absolute-git-dir. No node.
_directive_kill_record() {
  _rec="$REPO_ROOT/.deft/authz/kill-switch.disable"
  if [ ! -e "$_rec" ] && [ ! -L "$_rec" ]; then
    echo absent
    return 0
  fi
  if [ -L "$_rec" ] || [ ! -f "$_rec" ]; then
    echo not-a-regular-file
    return 0
  fi
  if [ ! -r "$_rec" ]; then
    echo unreadable
    return 0
  fi
  if ! tr -d '\r' <"$_rec" 2>/dev/null | grep -qxF "schema=deft.kill-switch.v1"; then
    echo missing-schema-line
    return 0
  fi
  _gd="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || _gd=""
  if [ -z "$_gd" ]; then
    echo git-dir-unresolved
    return 0
  fi
  if ! tr -d '\r' <"$_rec" 2>/dev/null | grep -qxF "gitDir=$_gd"; then
    echo git-dir-mismatch
    return 0
  fi
  echo valid
}
run_directive() {
  # #3039 / #5543 / #5994 F1 / #6740: a valid kill record stands down BEFORE requiring
  # pin bin.js or node; a bare flag file turns nothing off and gets one warning per hook.
  _directive_kill_verdict="$(_directive_kill_record)"
  if [ "$_directive_kill_verdict" = "valid" ]; then
    return 0
  fi
  if [ -z "$_directive_kill_warned" ]; then
    _directive_kill_warned=1
    _directive_kill_flag=""
    if [ -f "$REPO_ROOT/.deft-directive-disable" ] && [ ! -L "$REPO_ROOT/.deft-directive-disable" ]; then
      _directive_kill_flag=1
    fi
    if [ "$_directive_kill_verdict" != "absent" ]; then
      if [ -n "$_directive_kill_flag" ]; then
        echo "Directive warning: \`.deft/authz/kill-switch.disable\` is not a valid kill record for this checkout ($_directive_kill_verdict). Enforcement stays on. The root \`.deft-directive-disable\` flag also turns nothing off. A person runs \`deft kill-switch:on --confirm\` at a terminal to write a new one, or \`deft kill-switch:off --confirm\` to remove it." >&2
      else
        echo "Directive warning: \`.deft/authz/kill-switch.disable\` is not a valid kill record for this checkout ($_directive_kill_verdict). Enforcement stays on. A person runs \`deft kill-switch:on --confirm\` at a terminal to write a new one, or \`deft kill-switch:off --confirm\` to remove it." >&2
      fi
    elif [ -n "$_directive_kill_flag" ]; then
      echo "Directive warning: root \`.deft-directive-disable\` is present, but a bare flag file turns nothing off (#6740). Enforcement stays on. To turn Directive off for this checkout, a person runs \`deft kill-switch:on --confirm\` at a terminal." >&2
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
