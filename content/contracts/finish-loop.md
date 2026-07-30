# Walk-away finish-loop (#871 / #2948 Wave 5)

Layer **L3 product loop** of the layered authorization stack (epic #2948).
Consumes Wave 1 human-origin grants and Wave 4 AFK template mint path
(`content/contracts/human-origin-authz.md`, `content/contracts/closed-verb-authz.md`).
Does **not** invent a second mint path.

Threat model: **aligned agent** confusion — the agent believes prose, affirmative
continuations (`go`, `yes`), or self-authored lifecycle state authorize a long-running
implement → PR → review → merge cascade. Credential-compromised forgery remains
#983-class out of scope.

Sibling Wave 5 work: typed escalation / batched approval UX is **#518** (separate PR).

## Operator walk-away

```bash
# 1. Mint once (operator-cli; Wave 1 SoT only)
deft authz:grant -- --template finish-loop
# optional: --expires ISO, --surfaces 'src/**', --repo owner/name, --branch <b>

# 2. Outer cascade (or let an agent re-enter after each AGENT_STEP)
task directive:finish-loop --

# 3. Per-PR shepherd after a PR is open
task pr:finish-loop -- <N>
# optional: --merge  (respects plan.policy.requireHumanMerge — never force bot merge)
```

Ephemeral single-shell bypass (not for AFK):

```bash
DEFT_ALLOW_FINISH_LOOP=1 task directive:finish-loop --
```

## Finish-loop grant template

| Field | Value |
| --- | --- |
| Template name | `finish-loop` |
| Mint path | `mintHumanOriginGrant` only (`deft authz:grant -- --template finish-loop`) |
| Operations | `edit`, `push`, `pr`, `merge` |
| Default expiry | 8h |
| Target | not required (unlike release-*) |
| Explicitly excluded | `release-cut`, `release-publish`, `release-rollback` |

Release-class verbs still require their own Wave 4 templates / env bypasses.
A finish-loop grant never authorizes draft→public publish.

## Surfaces

### `task pr:finish-loop -- <N>`

1. Fail closed **BLOCKED** (exit 2) without a covering finish-loop grant / env bypass.
2. Poll via `pr:watch` until terminal verdict.
3. **CLEAN** (exit 0) — review gate satisfied.
4. **NEW_P0_P1** (exit 1) — address path is **agent-orchestrated**: fix, push, re-run.
5. With `--merge`: if `requireHumanMerge` is true, exit 1 `require-human-merge`
   (human merges in GitHub UI). If bot merge is allowed, document / invoke
   `pr:wait-mergeable-and-merge` cascade (do not force merge when policy denies).

### `task directive:finish-loop --`

1. Grant gate (same as above).
2. Scan `xbrief/{active,pending}` (legacy `vbrief/` accepted).
3. Append one line per phase to `.deft-cache/finish-loop-progress.jsonl`.
4. Optional `--pr N` → run `pr:finish-loop` for that PR.
5. Non-empty queue → exit 1 **AGENT_STEP** with next story pointer.
   Implementation / PR open is **agent-owned**; the CLI provides gates + progress + halt,
   not an in-process autonomous coder.
6. Halt reasons: empty queue (exit 0), grant expiry/deny (exit 2), max iterations (exit 2),
   address findings / require-human-merge (exit 1).

## Heartbeat

Path: `.deft-cache/finish-loop-progress.jsonl`

Each line is JSON:

```json
{
  "schemaVersion": 1,
  "ts": "2026-07-30T12:00:00Z",
  "phase": "queue-scan",
  "iteration": 1,
  "haltReason": null,
  "message": "queue count=2",
  "prNumber": null,
  "grantId": "grant-…",
  "queueCount": 2,
  "exitCode": null
}
```

## Dual-mint avoidance

| Path | Authority? |
| --- | --- |
| `deft authz:grant --template finish-loop` / `mintHumanOriginGrant` | **Yes** — sole mint |
| `evaluateFinishLoopGrant` | Consumer only |
| Session-auth JSON files | **No** |
| xBRIEF / dispatch / allocation_context | **No** — Wave 1 rejection kinds |

## Composition with other layers

1. Intent ceiling (#1193) — may this session implement/merge?
2. Finish-loop grant (this contract) — is walk-away cascade granted?
3. Human-origin / UAT (#2944) — product mutations under UAT still need cohort grants
4. Closed-verb release gates (#1095) — release-* still separate
5. `requireHumanMerge` (#1193) — CLEAN ≠ auto-merge when human merge is required
6. runtimeAuthority path + push/merge (#1394 / #2711)

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | CLEAN / MERGED / empty queue complete |
| 1 | ACTION_REQUIRED (address findings, agent implement, require-human-merge) |
| 2 | BLOCKED (grant missing/expired, watch error, max iterations, config) |

Refs #871 #2948 #1095 #2944 #1193 #1056 #518.
