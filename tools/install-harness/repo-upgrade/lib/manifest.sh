#!/usr/bin/env bash
# Manifest + diff helpers for repo-upgrade harness.
#
# Policy (documented in README):
#   - Always skip .git and symlinks.
#   - pre mode:  exclude all node_modules
#   - post mode: exclude node_modules EXCEPT node_modules/@deftai/**
#   - Prefer myquickdiff (md5tree/quickdiff) when available; else sha256/md5 via shasum/md5.
#
# Manifest lines: "<hex>  ./relative/path" (md5sum-style), sorted by path.

_RU_LIB_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=common.sh
source "$_RU_LIB_DIR/common.sh"

ru_hash_file() {
  local f="$1"
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$f"
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "$f" | awk '{print $1}'
  else
    shasum -a 256 "$f" | awk '{print $1}'
  fi
}

# Returns 0 if path (relative ./…) should be skipped for the given mode.
ru_manifest_skip_path() {
  local rel="$1" mode="$2" # mode: pre|post|all
  case "$rel" in
    ./.git|./.git/*) return 0 ;;
  esac
  case "$rel" in
    ./node_modules|./node_modules/*)
      if [[ "$mode" == "post" ]]; then
        case "$rel" in
          ./node_modules/@deftai|./node_modules/@deftai/*) return 1 ;;
          *) return 0 ;;
        esac
      else
        return 0
      fi
      ;;
  esac
  return 1
}

# Write recursive content hash manifest of $root into $out.
# Usage: ru_write_manifest <root> <out> <pre|post|all>
#
# Always uses the builtin walker (not myquickdiff md5tree --exclude .git):
# md5tree treats excludes as path *substrings*, so ./.gitignore, ./.githooks/**,
# **/.gitkeep, and .gitleaks* are dropped from pre but kept in post → false adds.
ru_write_manifest() {
  local root="$1" out="$2" mode="${3:-pre}"
  root="$(cd "$root" && pwd)"
  local tmp
  tmp="$(mktemp)"

  # find predicate order: allow @deftai under node_modules before pruning the rest.
  # Prune only the ./.git directory — never substring-match ".git".
  (
    cd "$root" || exit 1
    if [[ "$mode" == "post" ]]; then
      find . \
        \( -path './.git' -o -path './.git/*' \) -prune -o \
        \( -path './node_modules/@deftai/*' -type f -print \) -o \
        \( -path './node_modules' -o -path './node_modules/*' \) -prune -o \
        -type f -print
    elif [[ "$mode" == "all" ]]; then
      find . \( -path './.git' -o -path './.git/*' \) -prune -o -type f -print
    else
      find . \
        \( -path './.git' -o -path './.git/*' \) -prune -o \
        \( -path './node_modules' -o -path './node_modules/*' \) -prune -o \
        -type f -print
    fi
  ) | while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    case "$rel" in
      ./*) ;;
      .) continue ;;
      *) rel="./$rel" ;;
    esac
    [[ -L "$root/$rel" ]] && continue
    [[ -f "$root/$rel" ]] || continue
    if ru_manifest_skip_path "$rel" "$mode"; then
      continue
    fi
    printf '%s  %s\n' "$(ru_hash_file "$root/$rel")" "$rel"
  done | LC_ALL=C sort -k2 > "$tmp"

  local algo="md5"
  if ! command -v md5 >/dev/null 2>&1 && ! command -v md5sum >/dev/null 2>&1; then
    algo="sha256"
  fi
  local count
  count="$(grep -c '  \./' "$tmp" 2>/dev/null || echo 0)"
  {
    echo "# repo-upgrade manifest"
    echo "# root=$root"
    echo "# mode=$mode"
    echo "# algo=$algo"
    echo "# files=$count"
    echo "# content-only (no mtime/mode/owner); symlinks skipped"
    echo "# walker=builtin (path-prefix ./.git prune; no substring .git exclude)"
    cat "$tmp"
  } > "$out"
  rm -f "$tmp"
  ru_info "wrote manifest ($mode, $count files) → $out"
}

# Diff two manifests → writes machine-readable lists + human summary.
# Outputs:
#   $outdir/diff.txt          human quickdiff-style
#   $outdir/removed.txt       paths
#   $outdir/added.txt
#   $outdir/changed.txt
#   $outdir/diff.json         {removed:[], added:[], changed:[{path,before,after}]}
ru_diff_manifests() {
  local before="$1" after="$2" outdir="$3"
  mkdir -p "$outdir"

  if [[ -f "$MYQUICKDIFF/quickdiff.rb" ]]; then
    ruby "$MYQUICKDIFF/quickdiff.rb" --manifests --full --no-default-excludes \
      "$before" "$after" > "$outdir/diff.txt" || true
  else
    ru_warn "myquickdiff missing; using builtin diff"
  fi

  # Structured path lists for allowlist checking (python for portability).
  python3 - "$before" "$after" "$outdir" <<'PY'
import sys, json, os
before_p, after_p, outdir = sys.argv[1:4]

def load(path):
    m = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            if "  " in line:
                h, p = line.split("  ", 1)
            elif "\t" in line:
                h, p = line.split("\t", 1)
            else:
                parts = line.split(None, 1)
                if len(parts) != 2:
                    continue
                h, p = parts
            p = p.strip()
            if not p.startswith("./"):
                p = "./" + p.lstrip("/")
            m[p] = h.strip().lower()
    return m

b, a = load(before_p), load(after_p)
removed = sorted(set(b) - set(a))
added = sorted(set(a) - set(b))
changed = sorted(p for p in set(b) & set(a) if b[p] != a[p])
for name, rows in ("removed", removed), ("added", added), ("changed", changed):
    with open(os.path.join(outdir, f"{name}.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + ("\n" if rows else ""))
with open(os.path.join(outdir, "diff.json"), "w", encoding="utf-8") as f:
    json.dump({"removed": removed, "added": added, "changed": changed}, f, indent=2)
    f.write("\n")
PY

  if [[ ! -s "$outdir/diff.txt" ]]; then
    local rc ac cc
    rc="$(grep -c . "$outdir/removed.txt" 2>/dev/null || echo 0)"
    ac="$(grep -c . "$outdir/added.txt" 2>/dev/null || echo 0)"
    cc="$(grep -c . "$outdir/changed.txt" 2>/dev/null || echo 0)"
    {
      echo "=== REMOVED ($rc) ==="
      if [[ -s "$outdir/removed.txt" ]]; then cat "$outdir/removed.txt"; else echo "(none)"; fi
      echo
      echo "=== ADDED ($ac) ==="
      if [[ -s "$outdir/added.txt" ]]; then cat "$outdir/added.txt"; else echo "(none)"; fi
      echo
      echo "=== CHANGED ($cc) ==="
      if [[ -s "$outdir/changed.txt" ]]; then cat "$outdir/changed.txt"; else echo "(none)"; fi
    } > "$outdir/diff.txt"
  fi
}
