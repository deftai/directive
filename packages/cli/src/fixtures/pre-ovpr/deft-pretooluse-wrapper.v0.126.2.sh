#!/usr/bin/env sh
# Grok PreToolUse outer deny when deft-hook cannot decide (#5656 Prefer-A Bound).
# Residual: if this wrapper never starts (missing sh / host timeout with no
# decision), the host contract still applies — Directive cannot observe that case.
set -eu
DENY_MISSING='{"decision":"deny","reason":"Directive denied this tool: deft-hook is missing or not executable (#5656 / #3785). Install @deftai/directive so PreToolUse can run, or disable Grok host hooks out of band (`deft policy:disable-host-hooks --host grok --confirm`)."}'
DENY_NONDECISION='{"decision":"deny","reason":"Directive denied this tool: deft-hook produced no usable decision (#5656). Crash, non-zero exit, and malformed non-empty stdout are non-decisions."}'

resolve_deft_hook() {
  if command -v deft-hook >/dev/null 2>&1; then
    command -v deft-hook
    return 0
  fi
  return 1
}

HOOK_BIN=$(resolve_deft_hook || true)
if [ -z "${HOOK_BIN}" ] || [ ! -x "${HOOK_BIN}" ]; then
  printf '%s\n' "$DENY_MISSING"
  exit 0
fi

TMP=$(mktemp) || { printf '%s\n' "$DENY_NONDECISION"; exit 0; }
trap 'rm -f "$TMP"' EXIT INT HUP TERM
set +e
"$HOOK_BIN" --host grok --event tool.before >"$TMP"
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
