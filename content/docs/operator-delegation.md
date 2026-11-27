# Operator delegation (TOTP-armed, #7420)

Refs: #7420 · #7279 harness-attended mint · #3110 terminal mint · #6945 / #7046 signed approvers (passkey) · #6740 kill switch · contract: [human-origin-authz.md](../contracts/human-origin-authz.md)

## What it is for

Some Directive steps need a person at a terminal: the approved-scope mint and the
release grants. A phone-only operator cannot do them. A delegation lets the
operator arm a short, limited window from chat. While the window is live, an
agent shell can complete those mints. Each result works at one named check only
and stops working when the window ends.

## Enroll once, at a terminal

```bash
deft delegate enroll --confirm [--account <name>]
```

This is the kept terminal mint (no agent or CI markers, a real TTY, a
controlling terminal, `--confirm`, the typed phrase `mint`). It writes a TOTP
secret under your user config directory, outside every repository
(`%APPDATA%\deft\delegation\totp-secret.json` on Windows, else
`$XDG_CONFIG_HOME/deft/delegation/totp-secret.json` or
`~/.config/deft/delegation/totp-secret.json`). It prints an `otpauth://` URI.
Add it to your phone authenticator app. `--replace` enrolls a new secret.

## Arm from chat

Type on its own line:

```text
deft delegate on [<ttl>] <code>
```

- `<code>` is the 6-digit code from the phone app (30-second steps, one step of
  clock drift either way).
- `<ttl>` is hours, such as `8h`. Default 12h, maximum 72h.
- A host adapter passes only the prompt text and the host session id to the one
  core arming verb. On Claude Code that is the `UserPromptSubmit` hook running
  `deft delegate claude-hook`. The Antigravity adapter follows #7332 and the two
  probes in issue comment 7206768951.

The core verb checks the code. It accepts a code only when its time step is
greater than `lastAcceptedStep` in the protected store
(`<main checkout>/.deft/authz/delegation/`). Every valid code sets
`lastAcceptedStep`, even when the rest of the command is refused (for example a
TTL over 72h), so a code copied from the transcript cannot arm later. A wrong or
missing code writes nothing. A repeat of the same prompt is a quiet no-op. The
check, the step update and the record write are one locked step.

## What a live delegation allows

| Harness-attended request | Under a live delegation |
| --- | --- |
| `scope:record-approved-scope` (single brief, and `--add-path` widen) | completes with provenance `delegated-totp` |
| `authz:grant --template release-cut` / `release-publish` / `release-rollback` / `release-promote-latest` | completes with provenance `delegated-totp` |
| every other verb and template | refuses as before |

A completion is one compare-and-set from open to completed: of two concurrent
completions of one request, one wins.

### Never delegable

- `authz:grant --template finish-loop` (it carries merge; the human merge gate
  is unchanged), `gate-override`, `spec-drift-override`, `one-pr-unit`,
  `delivery-identity-attest`, `acceptance-disposition`, `plan-sequence-approval`.
- `authz:grant` with raw operations and no template.
- `authz:uat-start`, `authz:uat-suspend`, `authz:revoke`.
- `kill-switch:on` / `kill-switch:off`, `approvers:enroll` / `approvers:remove`,
  `delegate enroll`.
- `scope:record-approved-scope --manifest` (cohort mint).

## Where a delegated result is accepted

Grants and stamps minted this way carry the delegated origin (kind
`operator-delegated`, `mintedVia` `delegated-totp`, the delegation id). Exactly
one check accepts each:

| Result | The one check that accepts it | Every other check |
| --- | --- | --- |
| approved-scope stamp | the scope-provenance fence's merge-base mint lookup (`packages/core/src/scope-provenance/evaluate.ts`) | `isHumanApprovalStamp` refuses it: the one-PR proof, the write-fence budget, the durable-effect and presentation ceilings, presentation coverage |
| release grant | `evaluateClosedVerb` (`packages/core/src/authz/closed-verb.ts`), for the release verb its template names only | `isHumanOrigin`, the general grant check in `authz/evaluate.ts`, the active-grant list and every other grant reader refuse it |

Each delegated result expires no later than the delegation, and it stops
admitting the moment the delegation ends. The check reads the live record at
use; a stamp or grant from an ended or older delegation is refused. The #6138
`protected` target class is not built yet; when it is, its floor must use
`isHumanOrigin`, which refuses the delegated origin.

The delegation store is local to the operator's machine. On CI, or any machine
without the live record, a delegated stamp does not admit at the fence.

## What ends a delegation

Any of these ends the record; it stays ended:

- `deft delegate off` (anyone may run it; ending only tightens);
- TTL expiry;
- session end (the `SessionEnd` adapter runs `deft delegate session-end`; only a
  record armed in that session ends);
- `authz:uat-start` (and any active UAT lease);
- a kill record (`deft kill-switch:on`);
- a terminal `deft authz:revoke`.

`deft delegate status` shows the record and why it is or is not live.

## Audit and chat

Each arm, end, delegated mint and delegated allow appends one line with
provenance `delegated-totp` to `<main checkout>/.deft/authz/delegation/audit.jsonl`.
The harness-attended request records `completedVia: "delegated-totp"` and the
delegation id. Each delegated action prints one chat line that starts with
`[delegated-totp]`.

## Strength

- **Parity of forging effort.** The hook that checks the code runs as the
  operator's OS user, so it must read the TOTP secret. Any agent shell under
  that user can read it too and compute a fresh code. Today's terminal gate can
  also be forged by a same-user process that drives a pseudo-terminal. Forging
  an arm costs about the same effort as forging the terminal gate.
- **Wider blast radius.** One terminal mint buys one mint. One arm buys hours
  of approved-scope and release grants. The allowlist and the one-consumer rule
  are the limits.
- **The upgrade.** The passkey (#6945 / #7046) makes the arming factor
  unproducible by an agent. Until then, treat a delegation as operator intent
  with the same trust as the terminal gate, not as a stronger proof.
- **No human review.** Under standing delegation the #7279 request digest is
  not human review. The agent opens and completes the request; nobody reads the
  frozen payload.
- The session id limits the record's life and labels the audit. It is not
  isolation between agents of the same OS user. The TTL is the real cap.

## Stop inventory

| Stop | Outcome | Reason |
| --- | --- | --- |
| `scope:record-approved-scope` | delegable | one named consumer (the fence), expires with the delegation |
| `authz:grant` release templates (4) | delegable | one named consumer (`evaluateClosedVerb`, own verb only) |
| commit admission `prospective-scope-cover-deny`, advisory-capable scope-cover failure only | delegable in the per-condition form (allow with audit; the remaining checks still run) | installer area change, pending owner approval |
| install-health stop (runtime missing) | remove | the outer stub admits its own lockfile install command in its own project root only |
| `authz:grant --template finish-loop` | human-only | carries merge; the human merge gate is unchanged |
| `gate-override`, `spec-drift-override` | human-only | override a failed gate; never delegable |
| other `authz:grant` templates, raw-ops grants | human-only | no named consumer accepts a delegated origin |
| `authz:uat-start` / `uat-suspend` / `revoke` | human-only | control the lease and grant store that bound the delegation |
| kill switch, approvers enroll/remove, `delegate enroll` | human-only | they set or lift the controls the delegation depends on |
| human merge | unchanged | not a Directive mint |
