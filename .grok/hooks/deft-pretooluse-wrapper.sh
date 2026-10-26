#!/usr/bin/env sh
# Grok PreToolUse outer deny when package-relative hook-bin cannot decide
# (#5656 Prefer-A Bound / OVPR AC9.1). Invokes ONLY:
#   node node_modules/@deftai/directive-runtime/dist/hook-bin.js --host grok --event tool.before
# Never resolves deft-hook on PATH.
# Residual: if this wrapper never starts (missing sh / host timeout with no
# decision), the host contract still applies — Directive cannot observe that case.
set -eu
DENY_MISSING='{"decision":"deny","reason":"Directive denied this tool: package-relative hook-bin is missing (node_modules/@deftai/directive-runtime/dist/hook-bin.js) or node cannot run it (#5656 / #3785 / AC9.1). Install @deftai/directive-runtime in this project (`npm install` / `directive install --repair`), or disable Grok host hooks out of band (`directive policy:disable-host-hooks --host grok --confirm`)."}'
DENY_NONDECISION='{"decision":"deny","reason":"Directive denied this tool: package-relative hook-bin produced no usable decision (#5656 / AC9.1). Crash, non-zero exit, and malformed non-empty stdout are non-decisions."}'
HOOK_JS="node_modules/@deftai/directive-runtime/dist/hook-bin.js"

if [ ! -f "$HOOK_JS" ]; then
  printf '%s\n' "$DENY_MISSING"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "$DENY_MISSING"
  exit 0
fi

TMP=$(mktemp) || { printf '%s\n' "$DENY_NONDECISION"; exit 0; }
trap 'rm -f "$TMP"' EXIT INT HUP TERM
set +e
node "$HOOK_JS" --host grok --event tool.before >"$TMP"
CODE=$?
set -e
OUT=$(cat "$TMP" || true)

if [ "$CODE" -ne 0 ]; then
  printf '%s\n' "$DENY_NONDECISION"
  exit 0
fi

TRIMMED=$(printf '%s' "$OUT" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
if [ -z "$TRIMMED" ]; then
  # Empty allow wire for Grok tool.before without advisory.
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  if printf '%s' "$TRIMMED" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);if(!j||typeof j!=="object"||Array.isArray(j))process.exit(1);const d=j.decision;if(d!=="allow"&&d!=="deny")process.exit(1);process.exit(0)}catch{process.exit(1)}});'; then
    printf '%s\n' "$OUT"
    exit 0
  fi
  printf '%s\n' "$DENY_NONDECISION"
  exit 0
fi
# No node parser available: non-empty stdout without JSON validation → deny.
printf '%s\n' "$DENY_NONDECISION"
exit 0
