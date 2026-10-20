#!/usr/bin/env bash
# Run all enabled samples from a catalog / survey JSON.
#
# Usage:
#   ./run-all.sh                              # prefers deftai-survey.json, else catalog.example.json
#   ./run-all.sh --catalog ~/yolo-5490/logs/wave4/deftai-survey.json
#   ./run-all.sh --catalog catalog.example.json --dry-run
#   ./run-all.sh --tag yolo-cp-wave4a
#
set -euo pipefail

RU_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RU_LIB="$RU_HOME/lib"
# shellcheck source=lib/common.sh
source "$RU_LIB/common.sh"

usage() {
  cat <<'EOF'
repo-upgrade run-all.sh — catalog / survey batch runner (in-repo)

  ./run-all.sh [--catalog FILE] [--dry-run] [--tag TAG] [--target-version VER]
               [--registry verdaccio|npm] [--limit N] [--only NAME] [--keep-going]

Catalog discovery order when --catalog omitted:
  1) $IH_SCRATCH/results/deftai-survey.json
  2) $YOLO_5490/logs/wave4/deftai-survey.json   (optional tip leftover)
  3) $RU_HOME/catalog.json
  4) $RU_HOME/catalog.example.json

Survey JSON is adapted: looks for samples|selected|repos lists and maps
name/repo, clone_url/url, sha/tip_sha/commit, shape/era, operation, enabled.
EOF
}

CATALOG=""
DRY_RUN=0
TAG_ARG=""
TARGET_VER=""
LIMIT=0
ONLY=""
KEEP_GOING=1   # batch default: continue after FAIL
EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --catalog) CATALOG="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --tag) TAG_ARG="${2:?}"; shift 2 ;;
    --target-version) TARGET_VER="${2:?}"; shift 2 ;;
    --registry) export IH_REGISTRY="${2:?}"; shift 2 ;;
    --limit) LIMIT="${2:?}"; shift 2 ;;
    --only) ONLY="${2:?}"; shift 2 ;;
    --keep-going) KEEP_GOING=1; shift ;;
    --fail-fast) KEEP_GOING=0; shift ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

ru_source_env

if [[ -z "$CATALOG" ]]; then
  if [[ -f "$RU_SURVEY_DEFAULT" ]]; then
    CATALOG="$RU_SURVEY_DEFAULT"
  elif [[ -f "${YOLO_5490}/logs/wave4/deftai-survey.json" ]]; then
    CATALOG="${YOLO_5490}/logs/wave4/deftai-survey.json"
  elif [[ -f "$RU_HOME/catalog.json" ]]; then
    CATALOG="$RU_HOME/catalog.json"
  else
    CATALOG="$RU_HOME/catalog.example.json"
  fi
fi
[[ -f "$CATALOG" ]] || ru_die "catalog not found: $CATALOG"
ru_info "catalog=$CATALOG"

STAMP="$(ru_stamp)"
BATCH_DIR="$RU_RESULTS/batch-$STAMP"
mkdir -p "$BATCH_DIR"

# Normalize catalog → flat samples JSON array for the harness.
NORM="$BATCH_DIR/samples.normalized.json"
python3 - "$CATALOG" "$NORM" <<'PY'
import json, sys, os
src, dst = sys.argv[1:3]
with open(src, encoding="utf-8") as f:
    doc = json.load(f)

samples = None
if isinstance(doc, list):
    samples = doc
elif isinstance(doc, dict):
    for key in ("samples", "selected", "repos", "upgrade_samples", "candidates"):
        if isinstance(doc.get(key), list):
            samples = doc[key]
            break
    if samples is None and isinstance(doc.get("results"), dict):
        for key in ("samples", "selected", "repos"):
            if isinstance(doc["results"].get(key), list):
                samples = doc["results"][key]
                break
if samples is None:
    raise SystemExit("no samples/selected/repos list found in catalog")

out = []
for s in samples:
    if not isinstance(s, dict):
        continue
    name = s.get("name") or s.get("repo") or s.get("id")
    if not name:
        continue
    # Skip patient product unless explicitly enabled in survey
    if str(name).lower() == "directive" and not s.get("allow_directive_sample"):
        continue
    # Supportability gates: unsupported/no dropped; skip_reason kept as recorded SKIP.
    support = (s.get("supportability") or s.get("support") or s.get("verdict") or "").lower()
    skip_reason = s.get("skip_reason") or s.get("unsupported_reason") or s.get("skipReason") or ""
    if support in ("unsupported", "no") and not skip_reason:
        if not s.get("force"):
            continue
    if support == "skip" and not skip_reason:
        skip_reason = s.get("supportReason") or s.get("notes") or "supportability=skip"
    enabled = s.get("enabled", s.get("include", s.get("selected", s.get("shortlisted", True))))
    if enabled is False or enabled == 0 or enabled == "false":
        continue
    if skip_reason and s.get("force"):
        skip_reason = ""  # force overrides catalog skip

    clone_url = s.get("clone_url") or s.get("url") or s.get("cloneUrl") or s.get("git_url")
    if clone_url and clone_url.startswith("https://github.com/") and not clone_url.endswith(".git"):
        # gh api style url without .git is fine for git clone
        pass
    sha = (
        s.get("sha")
        or s.get("recommendedCheckoutSha")
        or s.get("recommended_checkout_sha")
        or s.get("tipSha")
        or s.get("tip_sha")
        or s.get("commit")
        or s.get("pinned_sha")
        or s.get("rev")
    )
    # Convert-shaped survey rows (legacy pin + .deft/core) default to convert
    op = s.get("operation") or s.get("op")
    if not op:
        era = (s.get("era") or s.get("shape") or "").lower()
        if "copied-core" in era or "oldstyle" in era or s.get("hasDeftCore"):
            op = "convert"
        elif s.get("runtimePin"):
            op = "upgrade"
        else:
            op = "auto"
    entry = {
        "name": name,
        "clone_url": clone_url,
        "sha": sha,
        "source": s.get("source") or ("local" if s.get("local_path") or s.get("localPath") else ("git" if clone_url else None)),
        "local_path": s.get("local_path") or s.get("localPath"),
        "operation": op,
        "shape": s.get("shape") or s.get("era") or s.get("layout") or s.get("install_shape"),
        "allowlist_extra": s.get("allowlist_extra") or s.get("allowlistExtra") or [],
        "notes": s.get("notes") or s.get("supportReason") or s.get("reason") or "",
        "enabled": True,
        "supportability": s.get("supportability") or s.get("support") or "",
        "directivePin": s.get("directivePin"),
        "runtimePin": s.get("runtimePin"),
        "skip_reason": skip_reason,
    }
    # Drop entries we cannot run (SKIP rows still need an identity; clone optional)
    if not skip_reason:
        if entry["source"] == "git" and not entry["clone_url"]:
            continue
        if entry["source"] == "local" and not entry["local_path"]:
            continue
        if not entry["source"]:
            continue
    else:
        entry["source"] = entry["source"] or ("git" if clone_url else "skip")
    out.append(entry)

with open(dst, "w", encoding="utf-8") as f:
    json.dump({"version": 1, "samples": out, "source_catalog": os.path.abspath(src)}, f, indent=2)
    f.write("\n")
print(len(out), file=sys.stderr)
PY

COUNT="$(jq '.samples|length' "$NORM")"
ru_info "normalized $COUNT runnable sample(s)"

if [[ "$COUNT" -eq 0 ]]; then
  ru_warn "no runnable samples — write catalog or wait for P0-5 deftai-survey.json"
  jq -n --arg catalog "$CATALOG" --arg batch "$BATCH_DIR" \
    '{status:"EMPTY", catalog:$catalog, batch:$batch, samples:[]}' > "$BATCH_DIR/summary.json"
  echo "$BATCH_DIR"
  exit 0
fi

NAMES=()
while IFS= read -r n; do
  NAMES+=("$n")
done < <(jq -r '.samples[].name' "$NORM")

PASS_N=0
PASS_SC_N=0
FAIL_N=0
WARN_N=0
SKIP_N=0
DRY_N=0
RAN=0
SUMMARY_MD="$BATCH_DIR/SUMMARY.md"
{
  echo "# Repo-upgrade batch $STAMP"
  echo
  echo "- catalog: \`$CATALOG\`"
  echo "- normalized: \`$NORM\`"
  echo
  echo "| sample | status | result dir |"
  echo "| --- | --- | --- |"
} > "$SUMMARY_MD"

for name in "${NAMES[@]}"; do
  if [[ -n "$ONLY" && "$name" != "$ONLY" ]]; then
    continue
  fi
  if [[ "$LIMIT" -gt 0 && "$RAN" -ge "$LIMIT" ]]; then
    break
  fi
  RAN=$((RAN + 1))

  skip_r="$(jq -r --arg n "$name" '.samples[] | select(.name==$n) | .skip_reason // empty' "$NORM")"
  if [[ -n "$skip_r" ]]; then
    rdir="$BATCH_DIR/skip-$name"
    mkdir -p "$rdir"
    jq -n \
      --arg name "$name" \
      --arg reason "$skip_r" \
      --arg tag "${TAG_ARG:-}" \
      '{name:$name, status:"SKIP", skip_reason:$reason, tag:$tag, dry_run:false}' \
      > "$rdir/result.json"
    {
      echo "## $name — **SKIP**"
      echo
      echo "- reason: $skip_r"
    } > "$rdir/snippet.md"
    status="SKIP"
    SKIP_N=$((SKIP_N + 1))
    echo "| $name | $status | \`$rdir\` |" >> "$SUMMARY_MD"
    {
      echo
      cat "$rdir/snippet.md"
      echo
    } >> "$BATCH_DIR/SNIPPETS.md"
    ru_warn "$name → SKIP ($skip_r)"
    continue
  fi

  args=(--catalog "$NORM" --name "$name")
  [[ "$DRY_RUN" -eq 1 ]] && args+=(--dry-run)
  [[ -n "$TAG_ARG" ]] && args+=(--tag "$TAG_ARG")
  [[ -n "$TARGET_VER" ]] && args+=(--target-version "$TARGET_VER")
  [[ "$KEEP_GOING" -eq 1 ]] && args+=(--keep-going)
  if [[ ${#EXTRA[@]} -gt 0 ]]; then
    args+=("${EXTRA[@]}")
  fi

  set +e
  out="$("$RU_HOME/run-sample.sh" "${args[@]}" 2>"$BATCH_DIR/${name}.stderr.log")"
  rc=$?
  set -e
  rdir="$(echo "$out" | tail -n1)"
  status="UNKNOWN"
  if [[ -f "$rdir/result.json" ]]; then
    status="$(jq -r .status "$rdir/result.json")"
  elif [[ "$rc" -ne 0 ]]; then
    status="FAIL"
  fi
  case "$status" in
    PASS) PASS_N=$((PASS_N + 1)) ;;
    PASS_WITH_SETUP_CONFLICTS) PASS_SC_N=$((PASS_SC_N + 1)) ;;
    FAIL) FAIL_N=$((FAIL_N + 1)) ;;
    WARN) WARN_N=$((WARN_N + 1)) ;;
    SKIP) SKIP_N=$((SKIP_N + 1)) ;;
    dry-run) DRY_N=$((DRY_N + 1)) ;;
  esac
  echo "| $name | $status | \`$rdir\` |" >> "$SUMMARY_MD"
  if [[ -f "$rdir/snippet.md" ]]; then
    {
      echo
      cat "$rdir/snippet.md"
      echo
    } >> "$BATCH_DIR/SNIPPETS.md"
  fi
  if [[ "$status" == "FAIL" && "$KEEP_GOING" -eq 0 ]]; then
    break
  fi
done

{
  echo
  echo "## Totals"
  echo
  echo "- ran: $RAN"
  echo "- PASS: $PASS_N"
  echo "- PASS_WITH_SETUP_CONFLICTS: $PASS_SC_N"
  echo "- FAIL: $FAIL_N"
  echo "- WARN: $WARN_N"
  echo "- SKIP: $SKIP_N"
  echo "- dry-run: $DRY_N"
} >> "$SUMMARY_MD"

jq -n \
  --arg stamp "$STAMP" \
  --arg catalog "$CATALOG" \
  --arg batch "$BATCH_DIR" \
  --argjson ran "$RAN" \
  --argjson pass "$PASS_N" \
  --argjson pass_sc "$PASS_SC_N" \
  --argjson fail "$FAIL_N" \
  --argjson warn "$WARN_N" \
  --argjson skip "$SKIP_N" \
  --argjson dry "$DRY_N" \
  '{stamp:$stamp, catalog:$catalog, batch:$batch, ran:$ran,
    PASS:$pass, PASS_WITH_SETUP_CONFLICTS:$pass_sc, FAIL:$fail,
    WARN:$warn, SKIP:$skip, dry_run:$dry}' \
  > "$BATCH_DIR/summary.json"

ru_info "batch done PASS=$PASS_N PASS_SC=$PASS_SC_N FAIL=$FAIL_N WARN=$WARN_N SKIP=$SKIP_N dry=$DRY_N → $BATCH_DIR"
echo "$BATCH_DIR"
[[ "$FAIL_N" -eq 0 ]] || exit 1
exit 0
