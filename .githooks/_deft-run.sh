# Shared deft CLI resolver for .githooks/* (#2067, #2248).
# REPO_ROOT must be set before sourcing.
#
# Resolution order:
#   1. DEFT_HOOKS_PREFER_GLOBAL=1 forces the global `deft` (escape hatch, #2248).
#   2. Framework-source (monorepo) checkout: prefer the freshly-built LOCAL CLI
#      (packages/cli/dist/bin.js) over a possibly-stale global `deft`, so a
#      newly-added-and-wired verb is not unknown to the global and does not
#      block commits/pushes (#2248). Detected via the built local CLI existing
#      under $REPO_ROOT together with a monorepo sentinel (pnpm-workspace.yaml).
#   3. Consumer install (vendored .deft/core, no local build): resolve the
#      global `deft` exactly as before -- consumers have no local CLI to prefer.
#   4. Local build present without the monorepo sentinel: fall back to it.
#   5. Nothing resolvable: fail with an install hint.

run_deft() {
    _deft_local="$REPO_ROOT/packages/cli/dist/bin.js"

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

    # (3) Consumer install: resolve the global `deft` exactly as today.
    if command -v deft >/dev/null 2>&1; then
        deft "$@"
        return $?
    fi

    # (4) Local build present without the monorepo sentinel.
    if [ -f "$_deft_local" ]; then
        node "$_deft_local" "$@"
        return $?
    fi

    # (5) Nothing resolvable.
    echo "deft hooks: 'deft' not found on PATH and no local CLI at packages/cli/dist/bin.js." >&2
    echo "  Install: npm i -g @deftai/directive" >&2
    exit 1
}
