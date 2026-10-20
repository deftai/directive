#!/usr/bin/env bash
# Run one repo-upgrade sample: clone → pre-md5 → upgrade → post-md5 → allowlist → sanity+doctor.
#
# Usage:
#   ./run-sample.sh --name local-smoke --source local --local-path ~/yolo-5490/fixtures/repo-upgrade/_local-smoke-src
#   ./run-sample.sh --catalog catalog.example.json --name local-smoke
#   ./run-sample.sh --name statusreport --clone-url https://github.com/deftai/statusreport.git --sha <SHA>
#   ./run-sample.sh … --dry-run
#   ./run-sample.sh … --tag yolo-cp-wave4a
#
set -euo pipefail

RU_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=lib/common.sh
source "$RU_LIB/common.sh"
# shellcheck source=lib/manifest.sh
source "$RU_LIB/manifest.sh"
# shellcheck source=lib/allowlist.sh
source "$RU_LIB/allowlist.sh"
# shellcheck source=lib/sanity.sh
source "$RU_LIB/sanity.sh"

usage() {
  cat <<'EOF'
repo-upgrade run-sample.sh — one sample

Required (one of):
  --name <slug>              Sample name (fixture folder prefix)
  --catalog <file> --name    Load fields from catalog JSON sample

Source (one of):
  --clone-url <url> [--sha <rev>]   git clone (default branch or pinned SHA)
  --source local --local-path <dir> copy existing tree
  --source synthetic-ovpr-v         build a tiny OVPR-V pin fixture then upgrade

Options:
  --sha <rev>                Pin clone to this commit/tag
  --operation auto|upgrade|install|convert
  --shape <label>            Recorded in result JSON (legacy-core, ovpr-v, …)
  --tag <dist-tag>           Tip launcher tag (default yolo-cp-wave4a → wave3z)
  --target-version <ver>     Override HT_VER
  --dry-run                  Clone/copy + pre-manifest + plan only (no upgrade)
  --skip-sanity              Skip independent sanity
  --skip-doctor              Skip doctor
  --keep-going               Do not exit non-zero on allowlist/sanity FAIL (still record)
  --allowlist-extra <pat>    Extra allowlist pattern (repeatable)
  --help
EOF
}

NAME=""
CATALOG=""
CLONE_URL=""
SHA=""
SOURCE=""
LOCAL_PATH=""
OPERATION="auto"
SHAPE=""
TAG_ARG=""
TARGET_VER=""
DRY_RUN=0
SKIP_SANITY=0
SKIP_DOCTOR=0
KEEP_GOING=0
ALLOW_EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --name) NAME="${2:?}"; shift 2 ;;
    --catalog) CATALOG="${2:?}"; shift 2 ;;
    --clone-url) CLONE_URL="${2:?}"; SOURCE="git"; shift 2 ;;
    --sha) SHA="${2:?}"; shift 2 ;;
    --source) SOURCE="${2:?}"; shift 2 ;;
    --local-path) LOCAL_PATH="${2:?}"; SOURCE="${SOURCE:-local}"; shift 2 ;;
    --operation) OPERATION="${2:?}"; shift 2 ;;
    --shape) SHAPE="${2:?}"; shift 2 ;;
    --tag) TAG_ARG="${2:?}"; shift 2 ;;
    --target-version) TARGET_VER="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-sanity) SKIP_SANITY=1; shift ;;
    --skip-doctor) SKIP_DOCTOR=1; shift ;;
    --keep-going) KEEP_GOING=1; shift ;;
    --allowlist-extra) ALLOW_EXTRA+=("${2:?}"); shift 2 ;;
    *) ru_die "unknown arg: $1" ;;
  esac
done

ru_source_env

# Merge catalog sample fields when provided.
if [[ -n "$CATALOG" ]]; then
  [[ -f "$CATALOG" ]] || ru_die "catalog not found: $CATALOG"
  [[ -n "$NAME" ]] || ru_die "--catalog requires --name"
  sample_json="$(python3 - "$CATALOG" "$NAME" <<'PY'
import json, sys
path, name = sys.argv[1:3]
with open(path, encoding="utf-8") as f:
    doc = json.load(f)
samples = doc.get("samples") or doc.get("selected") or doc.get("repos") or doc
if isinstance(samples, dict):
    samples = samples.get("samples") or samples.get("items") or []
if not isinstance(samples, list):
    raise SystemExit("catalog has no samples list")
match = None
for s in samples:
    if not isinstance(s, dict):
        continue
    n = s.get("name") or s.get("repo") or s.get("id") or ""
    if n == name or n.lower() == name.lower():
        match = s
        break
if match is None:
    raise SystemExit(f"sample not found in catalog: {name}")
print(json.dumps(match))
PY
)"
  # Fill blanks from catalog (CLI wins when already set)
  _jq() { jq -r "$1 // empty" <<<"$sample_json"; }
  [[ -n "$CLONE_URL" ]] || CLONE_URL="$(_jq '.clone_url // .url // .cloneUrl // .git_url')"
  [[ -n "$SHA" ]] || SHA="$(_jq '.sha // .tip_sha // .commit // .pinned_sha // .rev')"
  [[ -n "$SOURCE" ]] || SOURCE="$(_jq '.source')"
  [[ -n "$LOCAL_PATH" ]] || LOCAL_PATH="$(_jq '.local_path // .localPath')"
  [[ "$OPERATION" != "auto" ]] || {
    op_c="$(_jq '.operation // .op')"
    [[ -n "$op_c" ]] && OPERATION="$op_c"
  }
  [[ -n "$SHAPE" ]] || SHAPE="$(_jq '.shape // .era // .layout')"
  while IFS= read -r pat; do
    [[ -n "$pat" ]] && ALLOW_EXTRA+=("$pat")
  done < <(jq -r '(.allowlist_extra // .allowlistExtra // [])[]?' <<<"$sample_json" 2>/dev/null || true)
  enabled="$(_jq '.enabled // .include // .selected')"
  if [[ "$enabled" == "false" || "$enabled" == "0" ]]; then
    ru_die "sample $NAME is disabled in catalog"
  fi
  skip_r="$(_jq '.skip_reason // .unsupported_reason // .skipReason')"
  if [[ -n "$skip_r" ]]; then
    ru_die "sample $NAME skipped by catalog: $skip_r"
  fi
  # Default source
  if [[ -z "$SOURCE" ]]; then
    if [[ -n "$LOCAL_PATH" ]]; then SOURCE="local"
    elif [[ -n "$CLONE_URL" ]]; then SOURCE="git"
    fi
  fi
fi

[[ -n "$NAME" ]] || ru_die "--name required"
# Refuse dogfooding directive product name as consumer via clone of patient path
if [[ "$NAME" == "directive" && "${RU_ALLOW_DIRECTIVE_SAMPLE:-0}" != "1" ]]; then
  ru_warn "sample name 'directive' is the patient product — refusing (set RU_ALLOW_DIRECTIVE_SAMPLE=1 to override for a *fixture clone*, never ~/Projects/directive)"
  ru_die "refusing directive consumer"
fi

TAG="$(ru_resolve_tag "${TAG_ARG:-$RU_TAG_DEFAULT}")"
if [[ -z "$TARGET_VER" ]]; then
  TARGET_VER="$(ru_resolve_ver "$TAG")"
fi
export HT_TAG="$TAG" HT_VER="$TARGET_VER"

STAMP="$(ru_stamp)"
WORK="$RU_FIXTURES/${NAME}-${STAMP}"
RESULT_DIR="$RU_RESULTS/${NAME}-${STAMP}"
mkdir -p "$RESULT_DIR"

ru_info "sample=$NAME tag=$TAG ver=$TARGET_VER dry_run=$DRY_RUN"
ru_info "work=$WORK"
ru_info "results=$RESULT_DIR"

# --- materialize fixture ---
case "${SOURCE:-}" in
  git|"")
    [[ -n "$CLONE_URL" ]] || ru_die "git source requires --clone-url (or catalog)"
    # Guard: clone URL pointing at local patient
    if [[ "$CLONE_URL" == *"Projects/directive"* && "$CLONE_URL" != *github.com* ]]; then
      ru_die "refusing local patient path as clone_url: $CLONE_URL"
    fi
    mkdir -p "$WORK"
    if [[ -n "$SHA" ]]; then
      git clone --no-checkout "$CLONE_URL" "$WORK"
      git -C "$WORK" checkout --detach "$SHA"
    else
      git clone --depth 1 "$CLONE_URL" "$WORK"
      SHA="$(git -C "$WORK" rev-parse HEAD)"
    fi
    ;;
  local)
    [[ -n "$LOCAL_PATH" && -d "$LOCAL_PATH" ]] || ru_die "local source requires --local-path dir"
    if ru_is_forbidden_consumer "$LOCAL_PATH"; then
      ru_die "refusing forbidden consumer path: $LOCAL_PATH"
    fi
    mkdir -p "$WORK"
    # copy without .git first then re-init? Prefer rsync including .git for realism.
    rsync -a --exclude node_modules "$LOCAL_PATH"/ "$WORK"/
    if [[ ! -d "$WORK/.git" ]]; then
      git -C "$WORK" init -q
      git -C "$WORK" config user.email yolo@local
      git -C "$WORK" config user.name yolo
      git -C "$WORK" config commit.gpgsign false
      git -C "$WORK" add -A
      git -C "$WORK" commit --no-gpg-sign -qm "repo-upgrade local fixture" || true
    fi
    SHA="${SHA:-$(git -C "$WORK" rev-parse HEAD 2>/dev/null || echo local)}"
    ;;
  synthetic-ovpr-v)
    # Build a tiny OVPR-V consumer (older pin) under WORK, then upgrade to TARGET_VER.
    mkdir -p "$WORK"
    cat > "$WORK/package.json" <<'PJ'
{"name":"ru-local-smoke","version":"0.0.0","private":true}
PJ
    ru_write_hybrid_npmrc "$WORK"
    git -C "$WORK" init -q
    git -C "$WORK" config user.email yolo@local
    git -C "$WORK" config user.name yolo
    git -C "$WORK" config commit.gpgsign false
    git -C "$WORK" add package.json .npmrc
    git -C "$WORK" commit --no-gpg-sign -qm init
    OLD_VER="${RU_SMOKE_OLD_VER:-}"
    if [[ -z "$OLD_VER" ]]; then
      OLD_VER="$(npm view "@deftai/directive@yolo-cp-wave2za" version --registry "$VERDACCIO_URL" 2>/dev/null || true)"
      OLD_VER="${OLD_VER:-0.0.0-yolo.cp-wave2za.3}"
    fi
    if [[ "$DRY_RUN" -eq 0 ]]; then
      ru_info "synthetic: install OVPR-V pin $OLD_VER"
      directive install --root "$WORK" --yes --target-version "$OLD_VER"
    else
      ru_info "synthetic dry-run: would install $OLD_VER then upgrade to $TARGET_VER"
    fi
    SHAPE="${SHAPE:-synthetic-ovpr-v}"
    OPERATION="upgrade"
    SHA="$(git -C "$WORK" rev-parse HEAD)"
    ;;
  *)
    ru_die "unknown --source $SOURCE"
    ;;
esac

if ru_is_forbidden_consumer "$WORK"; then
  ru_die "work tree resolved to forbidden consumer"
fi

ru_write_hybrid_npmrc "$WORK"

OP="$(ru_detect_operation "$WORK" "$OPERATION")"
SHAPE="${SHAPE:-$OP}"
CMD="$(ru_build_directive_cmd "$OP" "$WORK" "$TARGET_VER")"
ru_info "detected operation=$OP"
ru_info "planned: $CMD"

# --- pre-manifest (exclude node_modules) ---
ru_write_manifest "$WORK" "$RESULT_DIR/pre.md5tree" pre

if [[ "$DRY_RUN" -eq 1 ]]; then
  jq -n \
    --arg name "$NAME" \
    --arg work "$WORK" \
    --arg sha "$SHA" \
    --arg tag "$TAG" \
    --arg ver "$TARGET_VER" \
    --arg op "$OP" \
    --arg shape "$SHAPE" \
    --arg cmd "$CMD" \
    --argjson dry_run true \
    '{name:$name, status:"dry-run", work:$work, sha:$sha, tag:$tag, target_version:$ver,
      operation:$op, shape:$shape, planned_command:$cmd, dry_run:$dry_run}' \
    > "$RESULT_DIR/result.json"
  {
    echo "## $NAME (dry-run)"
    echo
    echo "- work: \`$WORK\`"
    echo "- sha: \`$SHA\`"
    echo "- tag/ver: \`$TAG\` / \`$TARGET_VER\`"
    echo "- operation: \`$OP\` (shape=$SHAPE)"
    echo "- planned: \`$CMD\`"
    echo "- pre-manifest: \`pre.md5tree\`"
    echo "- status: **dry-run** (no upgrade executed)"
  } > "$RESULT_DIR/snippet.md"
  ru_pass "dry-run complete → $RESULT_DIR"
  echo "$RESULT_DIR"
  exit 0
fi

# --- upgrade / install ---
set +e
eval "$CMD" > "$RESULT_DIR/upgrade.log" 2>&1
UP_RC=$?
set -e
ru_info "upgrade/install exit=$UP_RC"

# --- post-manifest (include node_modules/@deftai) ---
ru_write_manifest "$WORK" "$RESULT_DIR/post.md5tree" post
ru_diff_manifests "$RESULT_DIR/pre.md5tree" "$RESULT_DIR/post.md5tree" "$RESULT_DIR/diff"

ALLOW_RC=0
set +e
if [[ ${#ALLOW_EXTRA[@]} -gt 0 ]]; then
  ru_check_allowlist "$RESULT_DIR/diff" "$RESULT_DIR" "${ALLOW_EXTRA[@]}"
else
  ru_check_allowlist "$RESULT_DIR/diff" "$RESULT_DIR"
fi
ALLOW_RC=$?
set -e

SANITY_RC=0
DOCTOR_RC=0
if [[ "$SKIP_SANITY" -eq 0 ]]; then
  set +e
  ru_run_sanity "$WORK" "$RESULT_DIR"
  SANITY_RC=$?
  set -e
  # 127 = skipped
  if [[ "$SANITY_RC" -eq 127 ]]; then SANITY_RC=0; fi
fi
if [[ "$SKIP_DOCTOR" -eq 0 ]]; then
  set +e
  ru_run_doctor "$WORK" "$RESULT_DIR"
  DOCTOR_RC=$?
  set -e
fi

UNEXPECTED_N=0
if [[ -s "$RESULT_DIR/unexpected.txt" ]]; then
  UNEXPECTED_N="$(grep -c . "$RESULT_DIR/unexpected.txt" || true)"
fi
UNEXPECTED_N="$(printf '%s' "$UNEXPECTED_N" | tr -d '[:space:]')"
UNEXPECTED_N="${UNEXPECTED_N:-0}"

CONVERT_LANDED=0
SETUP_CONFLICTS=0
if ru_ovpr_convert_landed "$WORK" "$TARGET_VER"; then
  CONVERT_LANDED=1
fi
if ru_setup_conflicts_after_pin "$RESULT_DIR/upgrade.log"; then
  SETUP_CONFLICTS=1
fi

# Scoring (wave4e):
# - allowlist unexpected → FAIL
# - convert that lands OVPR pin + removes .deft/core + sanity PASS, with only
#   unmanaged-hooks setup conflicts (upgrade rc≠0) → PASS_WITH_SETUP_CONFLICTS
# - otherwise upgrade rc≠0 → FAIL
# - doctor mutation (rc=2) or sanity fail → FAIL
# - doctor diagnostics nonzero alone → WARN (or keep PASS_WITH_SETUP_CONFLICTS)
STATUS="PASS"
SCORE_NOTE=""
if [[ "$ALLOW_RC" -ne 0 ]]; then
  STATUS="FAIL"
  SCORE_NOTE="allowlist unexpected paths"
elif [[ "$SANITY_RC" -ne 0 ]]; then
  STATUS="FAIL"
  SCORE_NOTE="sanity failed"
elif [[ "$DOCTOR_RC" -eq 2 ]]; then
  STATUS="FAIL"
  SCORE_NOTE="doctor mutated tree"
elif [[ "$UP_RC" -ne 0 ]]; then
  if [[ "$CONVERT_LANDED" -eq 1 && "$SETUP_CONFLICTS" -eq 1 ]]; then
    STATUS="PASS_WITH_SETUP_CONFLICTS"
    SCORE_NOTE="OVPR pin landed; setup refused unmanaged .githooks (product-correct)"
  else
    STATUS="FAIL"
    SCORE_NOTE="upgrade/convert exit $UP_RC without convert-success+setup-conflict profile"
  fi
elif [[ "$DOCTOR_RC" -ne 0 ]]; then
  STATUS="WARN"
  SCORE_NOTE="doctor diagnostics nonzero (non-mutating)"
fi

jq -n \
  --arg name "$NAME" \
  --arg status "$STATUS" \
  --arg work "$WORK" \
  --arg sha "$SHA" \
  --arg tag "$TAG" \
  --arg ver "$TARGET_VER" \
  --arg op "$OP" \
  --arg shape "$SHAPE" \
  --arg cmd "$CMD" \
  --arg score_note "$SCORE_NOTE" \
  --argjson up_rc "$UP_RC" \
  --argjson allow_rc "$ALLOW_RC" \
  --argjson sanity_rc "$SANITY_RC" \
  --argjson doctor_rc "$DOCTOR_RC" \
  --argjson unexpected "$UNEXPECTED_N" \
  --argjson convert_landed "$CONVERT_LANDED" \
  --argjson setup_conflicts "$SETUP_CONFLICTS" \
  --argjson dry_run false \
  --slurpfile diff "$RESULT_DIR/diff/diff.json" \
  '{name:$name, status:$status, work:$work, sha:$sha, tag:$tag, target_version:$ver,
    operation:$op, shape:$shape, planned_command:$cmd, dry_run:$dry_run,
    exit:{upgrade:$up_rc, allowlist:$allow_rc, sanity:$sanity_rc, doctor:$doctor_rc},
    unexpected_count:$unexpected, convert_landed:($convert_landed==1),
    setup_conflicts:($setup_conflicts==1), score_note:$score_note,
    diff:($diff[0] // {})}' \
  > "$RESULT_DIR/result.json"

{
  echo "## $NAME — **$STATUS**"
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| work | \`$WORK\` |"
  echo "| sha | \`$SHA\` |"
  echo "| tip | \`$TAG\` / \`$TARGET_VER\` |"
  echo "| operation | \`$OP\` (shape=$SHAPE) |"
  echo "| upgrade rc | $UP_RC |"
  echo "| allowlist | $ALLOW_RC (unexpected=$UNEXPECTED_N) |"
  echo "| sanity rc | $SANITY_RC |"
  echo "| doctor rc | $DOCTOR_RC |"
  echo "| convert landed | $CONVERT_LANDED |"
  echo "| setup conflicts | $SETUP_CONFLICTS |"
  if [[ -n "$SCORE_NOTE" ]]; then
    echo "| score note | $SCORE_NOTE |"
  fi
  echo
  echo "### Diff summary"
  echo
  echo '```'
  head -n 80 "$RESULT_DIR/diff/diff.txt" 2>/dev/null || true
  echo '```'
  if [[ -f "$RESULT_DIR/allowlist-report.md" ]]; then
    echo
    cat "$RESULT_DIR/allowlist-report.md"
  fi
} > "$RESULT_DIR/snippet.md"

if [[ "$STATUS" == "PASS" || "$STATUS" == "PASS_WITH_SETUP_CONFLICTS" ]]; then
  ru_pass "$NAME → $STATUS ($RESULT_DIR)"
elif [[ "$STATUS" == "WARN" ]]; then
  ru_warn "$NAME → $STATUS ($RESULT_DIR)"
else
  ru_warn "$NAME → $STATUS ($RESULT_DIR)"
fi

echo "$RESULT_DIR"
if [[ "$STATUS" == "FAIL" && "$KEEP_GOING" -eq 0 ]]; then
  exit 1
fi
exit 0
