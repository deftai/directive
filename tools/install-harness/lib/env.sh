#!/usr/bin/env bash
# Shared env for in-repo installer harnesses (post-sterile / master-ready).
# Sourced by ht-auto and repo-upgrade. YOLO_5490 remains optional for tip work.
#
# Defaults (override via env):
#   IH_ROOT                 — this tools/install-harness directory
#   IH_SCRATCH              — writable fixtures+results (gitignored)
#   IH_REGISTRY             — verdaccio | npm  (default: verdaccio)
#   VERDACCIO_URL           — local tip registry
#   HT_SANITY               — outside sanity checker checkout
#   YOLO_5490               — optional legacy tip workspace

set -euo pipefail

IH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IH_ROOT="$(cd "$IH_LIB_DIR/.." && pwd)"
# Repo root = tools/install-harness/../..
IH_REPO_ROOT="$(cd "$IH_ROOT/../.." && pwd)"

YOLO_5490="${YOLO_5490:-$HOME/yolo-5490}"
IH_SCRATCH_DEFAULT="${IH_REPO_ROOT}/.deft-scratch/install-harness"
IH_SCRATCH="${IH_SCRATCH:-$IH_SCRATCH_DEFAULT}"
IH_HOME_FALLBACK="${IH_HOME_FALLBACK:-$HOME/directive-install-harness-results}"

# Prefer in-repo scratch; fall back to $HOME if the repo tree is read-only.
if ! mkdir -p "$IH_SCRATCH" 2>/dev/null; then
  IH_SCRATCH="$IH_HOME_FALLBACK"
  mkdir -p "$IH_SCRATCH"
fi

VERDACCIO_URL="${VERDACCIO_URL:-http://127.0.0.1:4873}"
IH_REGISTRY="${IH_REGISTRY:-verdaccio}"
HT_SANITY="${HT_SANITY:-$HOME/Projects/directive-install-sanity}"
MYQUICKDIFF="${MYQUICKDIFF:-$HOME/Projects/myquickdiff}"

export IH_ROOT IH_REPO_ROOT IH_SCRATCH YOLO_5490 VERDACCIO_URL IH_REGISTRY HT_SANITY MYQUICKDIFF

# Put in-repo bin (ht-prep) first; keep YOLO bin as optional tip helper.
export PATH="$IH_ROOT/bin:${YOLO_5490}/bin:${YOLO_5490}/prefix/bin:${PATH:-}"

# Optional YOLO env for Verdaccio tip sessions (noop when missing).
if [[ -f "$YOLO_5490/env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$YOLO_5490/env.sh"
fi

# Registry URL for npm view / install in this harness session.
ih_registry_url() {
  case "${IH_REGISTRY}" in
    npm|public|latest)
      printf '%s\n' "https://registry.npmjs.org/"
      ;;
    *)
      printf '%s\n' "$VERDACCIO_URL"
      ;;
  esac
}

ih_npm_view() {
  # usage: ih_npm_view @deftai/directive@<tag> version
  local spec="$1"
  local field="${2:-version}"
  npm view "$spec" "$field" --registry "$(ih_registry_url)"
}
