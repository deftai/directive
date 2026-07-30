# Closed-verb authorization (#1095 / #2948 Wave 4)

Layer **L2 AFK / release verbs** of the layered authorization stack (epic #2948).
Consumes Wave 1 human-origin grants (`content/contracts/human-origin-authz.md`);
does **not** invent a second mint path.

Threat model: **aligned agent** confusion — the agent believes prose, affirmative
continuations (`go`, `yes`), or self-authored lifecycle state authorizes
`release-publish` and peer closed verbs. Credential-compromised forgery remains
#983-class out of scope.

## Defaults

| Surface | Default | Notes |
| --- | --- | --- |
| Closed-verb table | `conventions/verb-classification.json` | release-cut, release-publish, release-rollback |
| Env bypass | unset | e.g. `DEFT_ALLOW_RELEASE_PUBLISH=1` (ephemeral shell) |
| Grant templates | none until `authz:grant --template` | Mint via Wave 1 only |

## Classification rows

Each closed verb records:

- `closure_set` — follow-up verbs implied by completion-of-scope (not expansion)
- `explicit_required` — high-blast peers that never ride on this verb's grant alone
- `irreversibility` — composes with destructive-op axes (#708)
- `wildcard_allowed` — **false** for Wave 4 release-class rows
- `skill` + `phase` — informational precondition pointer (e.g. release SKILL Phase 5)
- `authz_operations` — Wave 1 operation names that satisfy the verb
- `env_bypass` — `DEFT_ALLOW_<VERB>` key

## Evaluation (`evaluateClosedVerb`)

Pure TS gate. **Allow** only when:

1. **Env bypass:** `DEFT_ALLOW_<VERB>=1` (or `true` / `yes`) for this shell, **or**
2. **Human-origin grant:** live Wave 1 grant with:
   - accepted origin (`operator-cli` / `operator-session` / `human-event`)
   - not revoked / expired / single-use spent
   - `scope.operations` intersects the verb's `authz_operations`  
     (precise op e.g. `release-publish`, or broader `deployment`)
   - `scope.surfaces` empty **or** matches the target version (`0.30.0` / `v0.30.0`)

**Deny** with structured codes:

| Code | Meaning |
| --- | --- |
| `closed-verb-deny-missing` | No grant and no env bypass |
| `closed-verb-deny-origin` | Agent/self-authored grant |
| `closed-verb-deny-scope` | Ops or target surfaces do not cover |
| `closed-verb-deny-expired` / `revoked` / `spent` | Grant semantics |
| `closed-verb-unknown` | Verb not in classification table |

Agent-authored grants and lifecycle/dispatch tokens **never** satisfy.

## Enforcement: `release-publish`

`deft release-publish` / `task release:publish` calls the gate **after** a draft
is found and **before** `draft=false` (draft→public). Already-published NOOP and
dry-run do not require a grant.

```text
[publish] Closed-verb gate release-publish vX.Y.Z... FAIL (closed-verb-deny-missing: …)
```

Human action named in the deny:

```bash
deft authz:grant -- --template release-publish --target X.Y.Z
# or, single-shell:
DEFT_ALLOW_RELEASE_PUBLISH=1 deft release-publish -- X.Y.Z
```

## AFK templates (no second mint engine)

```bash
deft authz:grant -- --template release-cut --target 0.30.0
deft authz:grant -- --template release-publish --target 0.30.0
deft authz:grant -- --template release-rollback --target 0.30.0
```

Templates are **presets** on `mintHumanOriginGrant` (`origin.kind=operator-cli`).
They write only under `.deft/authz/grants/`.

⊗ Do **not** treat `~/.deft/session-auth` (or `%APPDATA%\deft\session-auth`) as an
independent authorization source that agents can self-mint. An optional mirror
that only **references** grant ids is non-authority documentation, not a second SoT.

## Dual-mint avoidance

| Path | Authority? |
| --- | --- |
| `deft authz:grant` / `mintHumanOriginGrant` | **Yes** — sole mint |
| `evaluateClosedVerb` | Consumer only |
| Session-auth JSON files | **No** — not accepted as approval evidence |
| xBRIEF / dispatch / allocation_context | **No** — Wave 1 rejection kinds |

## Explicit non-goals (Wave 5 / residual)

| Concern | Owner |
| --- | --- |
| Full `directive:finish-loop` / `pr:finish-loop` product | **#871** (Wave 5) |
| Post-session audit of consumed closed verbs | residual / PR-D of original RFC |
| HMAC / hardware-keyed grants | non-goal (misalignment-not-malice) |
| Python-only preflight as sole enforcement | non-goal; TS engine is required |
| Non-verb product-edit provenance + UAT | #2944 Wave 1 |

## Composition

1. Intent ceiling (#1193 Wave 2) — may the session ever deploy/release?
2. **Closed-verb gate (this contract)** — is this release-class verb granted?
3. Human-origin / UAT (#2944) — product mutations under UAT
4. runtimeAuthority path + push/merge (#1394 / #2711)
5. Destructive-gh preflight (#1019) — continues unchanged

Refs #1095 #2948 #2944 #871 #1019 #708 #983.
