# Shared deft CLI resolver for .githooks/* (#2067).
# REPO_ROOT must be set before sourcing.

run_deft() {
    if command -v deft >/dev/null 2>&1; then
        deft "$@"
    elif [ -f "$REPO_ROOT/packages/cli/dist/bin.js" ]; then
        node "$REPO_ROOT/packages/cli/dist/bin.js" "$@"
    else
        echo "deft hooks: 'deft' not found on PATH and no local CLI at packages/cli/dist/bin.js." >&2
        echo "  Install: npm i -g @deftai/directive" >&2
        exit 1
    fi
}
