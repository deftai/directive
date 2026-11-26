# Antigravity (agy) host: hook ordering mitigation (#7378)

agy runs `PreToolUse` hooks in hook-name order, and the last `overwrite` wins
(observed in #7345). Directive's check therefore sees the arguments that run
only when no other hook runs at or after Directive's entry.

## What Directive does

- Directive's entry in `.agents/hooks.json` uses one name,
  `zzzz-directive` (`AGY_DIRECTIVE_HOOK_NAME`). The name is a convenience. The
  ordering predicate carries the safety claim.
- One predicate reads `.agents/hooks.json` and reports every foreign
  `PreToolUse` entry that runs at or after Directive's. It counts as at-or-after
  any name that equals, starts with, or compares above Directive's name in UTF-8
  byte order, any name outside `[A-Za-z0-9._~-]`, and any entry whose shape it
  cannot read. It never reads `matcher`. An unparseable config is a finding.
- The agy hook outer runs the predicate on every `PreToolUse` call. The
  workspace comes from the payload `workspacePaths`. Any finding, an unreadable
  payload or an unresolvable workspace denies the call with one remediation:
  rename or remove the named foreign hook, or run
  `deft policy:disable-host-hooks --host agy --confirm`.
- `directive doctor` reports the same findings (check `agy-hook-order`). It is
  read-only and does not repair.
- The outer prints one explicit decision for every intentional allow on agy
  (kill record, missing-runtime install admit) and denies when the runtime's
  output is empty, not JSON, more than one object, or has no `decision` of
  `allow`, `deny`, `ask` or `force_ask`. agy treats exit 0 with empty output as
  allow, so this closes that gap.

## Stated limits

- **Hostile self-edit.** An agent that edits `.agents/hooks.json` can delete or
  rename Directive's own entry or add a hook. No host guards its hook config
  today, and agy is no exception. The per-call check covers foreign hooks that
  are not adversarial.
- **Other hook sources.** User-scope hooks (`~/.gemini`) and plugin hooks are
  not read by the predicate and were not observed. Mid-session reload of
  `.agents/hooks.json` was not observed either. Until all three are observed,
  the admission verdict keeps final executed argument integrity at `fail`
  (`AGY_MITIGATION_COVERAGE`) and activation stays halted.
- **No version check.** Directive does not read the agy version at run time
  (operator decision). The order was observed on agy 1.5.16 and 1.5.18. A
  later agy that changes how hooks are ordered would not be noticed.
- **Platform.** Observed on Windows only.
