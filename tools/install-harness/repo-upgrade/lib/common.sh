#!/usr/bin/env bash
# Shared bootstrap for repo-upgrade harness.
# shellcheck disable=SC2034

RU_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$RU_ROOT/../lib/env.sh"
RU_FIXTURES="${RU_FIXTURES:-$IH_SCRATCH/fixtures/repo-upgrade}"
RU_RESULTS="${RU_RESULTS:-$IH_SCRATCH/results/repo-upgrade}"
RU_SURVEY_DEFAULT="${RU_SURVEY_DEFAULT:-$IH_SCRATCH/results/deftai-survey.json}"
# Prefer current tip when present; override with --tag. Public mode uses latest.
RU_TAG_DEFAULT="${RU_TAG:-yolo-cp-wave4i}"
RU_TAG_FALLBACK="${RU_TAG_FALLBACK:-latest}"

# Never dogfood the patient product checkout as a consumer.
RU_FORBIDDEN_CONSUMERS=(
  "$IH_REPO_ROOT"
  "$HOME/Projects/directive"
  "${YOLO_DIRECTIVE_REPO:-$HOME/Projects/directive}"
)

ru_die() { echo "FAIL: $*" >&2; exit 1; }
ru_warn() { echo "WARN: $*" >&2; }
ru_info() { echo "INFO: $*" >&2; }
ru_pass() { echo "PASS: $*" >&2; }

ru_source_env() {
  # env.sh already sourced above; keep YOLO npmrc only in verdaccio mode.
  if [[ "${IH_REGISTRY}" == "verdaccio" || "${IH_REGISTRY}" == "" ]]; then
    if [[ -f "${YOLO_5490}/.npmrc-yolo" ]]; then
      export NPM_CONFIG_USERCONFIG="${NPM_CONFIG_USERCONFIG:-$YOLO_5490/.npmrc-yolo}"
    fi
  fi
  export YOLO_5490 VERDACCIO_URL HT_SANITY IH_SCRATCH IH_REGISTRY
  mkdir -p "$RU_FIXTURES" "$RU_RESULTS"
}

ru_resolve_tag() {
  local want="${1:-$RU_TAG_DEFAULT}"
  local reg
  reg="$(ih_registry_url)"
  if [[ "${IH_REGISTRY}" == "npm" || "${IH_REGISTRY}" == "public" || "${IH_REGISTRY}" == "latest" ]]; then
    want="${1:-latest}"
  fi
  if ih_npm_view "@deftai/directive@$want" version >/dev/null 2>&1; then
    echo "$want"
    return 0
  fi
  if [[ "$want" != "$RU_TAG_FALLBACK" ]] && \
     ih_npm_view "@deftai/directive@$RU_TAG_FALLBACK" version >/dev/null 2>&1; then
    ru_warn "tag @$want missing on $reg; falling back to @$RU_TAG_FALLBACK"
    echo "$RU_TAG_FALLBACK"
    return 0
  fi
  ru_die "neither @$want nor @$RU_TAG_FALLBACK resolvable at $reg"
}

ru_resolve_ver() {
  local tag="$1"
  ih_npm_view "@deftai/directive@$tag" version
}

ru_stamp() { date +%Y%m%d-%H%M%S; }

ru_is_forbidden_consumer() {
  local root
  root="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  local f
  for f in "${RU_FORBIDDEN_CONSUMERS[@]}"; do
    local fp
    fp="$(cd "$f" 2>/dev/null && pwd -P)" || continue
    if [[ "$root" == "$fp" ]]; then
      return 0
    fi
  done
  return 1
}

ru_write_hybrid_npmrc() {
  local root="$1"
  local npmrc="$root/.npmrc"
  if [[ -f "$npmrc" ]] && grep -q '@deftai:registry' "$npmrc" 2>/dev/null; then
    return 0
  fi
  cat > "$npmrc" <<EOF
registry=https://registry.npmjs.org/
@deftai:registry=${VERDACCIO_URL}/
EOF
}

# Detect install shape for operation selection.
# Prints: upgrade | install | convert
ru_detect_operation() {
  local root="$1"
  local forced="${2:-auto}"
  case "$forced" in
    upgrade|install|convert) echo "$forced"; return 0 ;;
    auto|"") ;;
    *) ru_warn "unknown operation '$forced'; using auto"; ;;
  esac

  local pkg="$root/package.json"
  local has_runtime=0 has_fat=0 has_core=0
  if [[ -f "$pkg" ]]; then
    if jq -e '
      (.dependencies["@deftai/directive-runtime"] //
       .devDependencies["@deftai/directive-runtime"] //
       .optionalDependencies["@deftai/directive-runtime"] // empty) != ""
    ' "$pkg" >/dev/null 2>&1; then
      has_runtime=1
    fi
    if jq -e '
      (.dependencies["@deftai/directive"] //
       .devDependencies["@deftai/directive"] // empty) != ""
    ' "$pkg" >/dev/null 2>&1; then
      has_fat=1
    fi
  fi
  if [[ -d "$root/.deft/core" ]]; then
    has_core=1
  fi

  if [[ "$has_runtime" -eq 1 ]]; then
    echo "upgrade"
  elif [[ "$has_core" -eq 1 || "$has_fat" -eq 1 ]]; then
    # Legacy / convert-shaped: prefer upgrade (product may migrate); callers may force install.
    echo "convert"
  else
    echo "install"
  fi
}

ru_build_directive_cmd() {
  local op="$1" root="$2" ver="$3"
  case "$op" in
    upgrade)
      echo "directive upgrade --root $(printf %q "$root") --yes --target-version $(printf %q "$ver")"
      ;;
    convert)
      # Convert-shaped: try upgrade first (OVPR migrate path). Fallback documented in README.
      echo "directive upgrade --root $(printf %q "$root") --yes --target-version $(printf %q "$ver")"
      ;;
    install)
      echo "directive install --root $(printf %q "$root") --yes --target-version $(printf %q "$ver")"
      ;;
    *)
      ru_die "ru_build_directive_cmd: bad op=$op"
      ;;
  esac
}

# True if package.json pins exact @deftai/directive-runtime@$ver.
ru_has_runtime_pin() {
  local root="$1" ver="$2" pkg="$1/package.json"
  [[ -f "$pkg" ]] || return 1
  jq -e --arg v "$ver" '
    (.dependencies["@deftai/directive-runtime"] //
     .devDependencies["@deftai/directive-runtime"] //
     .optionalDependencies["@deftai/directive-runtime"] // "") == $v
  ' "$pkg" >/dev/null 2>&1
}

# True when convert/upgrade landed OVPR pin and removed legacy .deft/core.
ru_ovpr_convert_landed() {
  local root="$1" ver="$2"
  ru_has_runtime_pin "$root" "$ver" || return 1
  [[ ! -d "$root/.deft/core" ]] || return 1
  return 0
}

# True when upgrade.log shows setup conflicts after a successful pin (refuse unmanaged hooks).
ru_setup_conflicts_after_pin() {
  local log="$1"
  [[ -f "$log" ]] || return 1
  grep -q 'setup completed with conflicts' "$log" || return 1
  # Product confirms pin landed despite setup conflicts.
  grep -Eq 'pin and lockfile now reference|is installed, but project setup did not finish' "$log" || return 1
  return 0
}
