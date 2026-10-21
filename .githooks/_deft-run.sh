#!/usr/bin/env sh
# Shared deft CLI resolver for .githooks/* (#2067, #2248).
# Compat tip relief after OVPR renamed the helper to _directive-run.sh (#5802).
# REPO_ROOT must be set before sourcing.
#
# Resolution order:
#   0. Root .deft-directive-disable kill-switch (#3039 / #5543) — skip CLI spawn.
#   1. DEFT_HOOKS_PREFER_GLOBAL=1 forces the global `deft` (escape hatch, #2248).
#   2. Framework-source (monorepo) checkout: prefer packages/runtime/dist/bin.js
#      when pnpm-workspace.yaml is present (#2248).
#   3. Installed runtime: node_modules/@deftai/directive-runtime/dist/bin.js.
#   4. Consumer install: resolve the global `deft`.
#   5. Local build present without the monorepo sentinel: fall back to it.
#   6. Nothing resolvable: fail with an install hint.

run_deft() {
    # (0) Kill-switch — match run_directive / _directive-run.sh (#5543 / #3039).
    _kill="$REPO_ROOT/.deft-directive-disable"
    if [ -f "$_kill" ] && [ ! -L "$_kill" ]; then
        if ! git -C "$REPO_ROOT" ls-files --error-unmatch -- .deft-directive-disable >/dev/null 2>&1; then
            echo "Directive is DISABLED for this project via root .deft-directive-disable (test/local kill-switch)." >&2
            echo "Git hooks skipping Directive CLI spawn (#5543 / #3039). Deposit may remain." >&2
            echo "Recovery: rm .deft-directive-disable && start a new agent session." >&2
            return 0
        fi
    fi

    _deft_local="$REPO_ROOT/packages/runtime/dist/bin.js"
    _deft_runtime="$REPO_ROOT/node_modules/@deftai/directive-runtime/dist/bin.js"

    # (1) Escape hatch: force the global even in a monorepo.
    if [ "${DEFT_HOOKS_PREFER_GLOBAL:-}" = "1" ] && command -v deft >/dev/null 2>&1; then
        deft "$@"
        return $?
    fi

    # (2) Framework-source checkout: the local build is authoritative for verbs.
    if [ -f "$_deft_local" ] && [ -f "$REPO_ROOT/pnpm-workspace.yaml" ]; then
        node "$_deft_local" "$@"
        return $?
    fi

    # (3) Installed runtime pin (pnpm install without a local build).
    if [ -f "$_deft_runtime" ]; then
        node "$_deft_runtime" "$@"
        return $?
    fi

    # (4) Consumer install: resolve the global `deft` exactly as today.
    if command -v deft >/dev/null 2>&1; then
        deft "$@"
        return $?
    fi

    # (5) Local build present without the monorepo sentinel.
    if [ -f "$_deft_local" ]; then
        node "$_deft_local" "$@"
        return $?
    fi

    # (6) Nothing resolvable.
    echo "deft hooks: 'deft' not found on PATH and no local/runtime CLI under packages/runtime or node_modules/@deftai/directive-runtime." >&2
    echo "  Install: npm i -g @deftai/directive" >&2
    exit 1
}
