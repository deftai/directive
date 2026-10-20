#!/usr/bin/env bash
# Allowlist check: every added/removed/changed path must match a planned pattern.
# Unexpected source-code edits → FAIL.
#
# Patterns are path-prefix or glob-ish:
#   ./package.json          exact
#   ./.deft/**              prefix ./.deft/ (also allows ./.deft itself)
#   ./node_modules/@deftai/** 
#   *.lock                  suffix (rare; prefer explicit lockfile names)
#
_RU_LIB_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=common.sh
source "$_RU_LIB_DIR/common.sh"

# Default planned-churn patterns (refine in README / per-sample allowlist_extra).
RU_ALLOWLIST_DEFAULT=(
  './package.json'
  './package-lock.json'
  './npm-shrinkwrap.json'
  './pnpm-lock.yaml'
  './yarn.lock'
  './bun.lock'
  './bun.lockb'
  './.npmrc'
  './.gitignore'
  './.gitattributes'
  './AGENTS.md'
  './CLAUDE.md'
  './.agents/**'
  './.claude/**'
  './.cursor/**'
  './.codex/**'
  './.grok/**'
  './.github/**'
  './Taskfile.yml'
  './Taskfile.yaml'
  './.githooks/**'
  './.deft/**'
  './node_modules/@deftai/**'
  # xbrief/vbrief migration surfaces (upgrade-owned)
  './xbrief/**'
  './vbrief/**'
  './.xbrief/**'
)

# Return 0 if $path matches $pattern.
ru_path_matches() {
  local path="$1" pattern="$2"
  # exact
  if [[ "$path" == "$pattern" ]]; then
    return 0
  fi
  # trailing /**
  if [[ "$pattern" == *'/**' ]]; then
    local prefix="${pattern%/**}"
    if [[ "$path" == "$prefix" || "$path" == "$prefix"/* ]]; then
      return 0
    fi
    return 1
  fi
  # trailing /*
  if [[ "$pattern" == *'/*' && "$pattern" != *'/**' ]]; then
    local prefix="${pattern%/*}"
    if [[ "$path" == "$prefix"/* && "$path" != "$prefix"/*/* ]]; then
      return 0
    fi
    # also allow deeper for convenience? no — use /**
    return 1
  fi
  # simple suffix glob: *.lock
  if [[ "$pattern" == \*.* ]]; then
    local suf="${pattern#\*}"
    [[ "$path" == *"$suf" ]] && return 0
    return 1
  fi
  return 1
}

ru_path_allowed() {
  local path="$1"
  shift
  local pat
  for pat in "$@"; do
    if ru_path_matches "$path" "$pat"; then
      return 0
    fi
  done
  return 1
}

# Check diff dir (removed/added/changed.txt) against allowlist.
# Writes $outdir/unexpected.txt and $outdir/allowlist-report.md
# Exit 0 if clean; 1 if unexpected paths.
# Usage: ru_check_allowlist <diffdir> <outdir> [extra_pattern ...]
ru_check_allowlist() {
  local diffdir="$1" outdir="$2"
  shift 2
  local patterns=("${RU_ALLOWLIST_DEFAULT[@]}" "$@")
  mkdir -p "$outdir"

  local unexpected="$outdir/unexpected.txt"
  : > "$unexpected"

  local path kind
  for kind in removed added changed; do
    local f="$diffdir/${kind}.txt"
    [[ -f "$f" ]] || continue
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      # normalize to ./relative
      case "$path" in
        ./*) ;;
        /*) ru_warn "absolute path in diff ignored for allowlist: $path"; continue ;;
        *) path="./$path" ;;
      esac
      if ! ru_path_allowed "$path" "${patterns[@]}"; then
        printf '%s\t%s\n' "$kind" "$path" >> "$unexpected"
      fi
    done < "$f"
  done

  local unc=0
  if [[ -s "$unexpected" ]]; then
    unc="$(grep -c . "$unexpected" || true)"
  fi
  unc="$(printf '%s' "$unc" | tr -d '[:space:]')"
  unc="${unc:-0}"
  {
    echo "# Allowlist report"
    echo
    echo "Patterns (${#patterns[@]}):"
    local p
    for p in "${patterns[@]}"; do
      echo "- \`$p\`"
    done
    echo
    if [[ "$unc" -eq 0 ]]; then
      echo "**Result: PASS** — all churn paths are allowlisted."
    else
      echo "**Result: FAIL** — $unc unexpected path(s):"
      echo
      echo '```'
      cat "$unexpected"
      echo '```'
    fi
  } > "$outdir/allowlist-report.md"

  if [[ "$unc" -eq 0 ]]; then
    ru_pass "allowlist clean"
    return 0
  fi
  ru_warn "allowlist FAIL ($unc unexpected)"
  cat "$unexpected" >&2
  return 1
}
