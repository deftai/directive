# Human-origin approval + UAT mutation lease (#2944 / #2948 Wave 1)

Layer **L1–L2** of the layered authorization stack (epic #2948). Composes with
`runtimeAuthority` (L3, #1394 / #2711) and does **not** re-implement Shell push/merge
matchers.

Threat model: **aligned agent** confusion — the agent believes self-authored
xBRIEF/lifecycle/dispatch state is permission. Credential-compromised local-file
forgery remains #983-class out of scope.

## Defaults

| Surface | Default | Notes |
| --- | --- | --- |
| UAT lease | inactive | No Wave 1 denials until operator starts UAT |
| Human-origin grants | none | Minted only via `deft authz:grant` |

## Human-origin grant

Stored under `.deft/authz/grants/<id>.json`.

Accepted `origin.kind` values:

- `operator-cli` (mint path: `deft authz:grant`)
- `operator-session` (future interactive approval)
- `human-event` (external human event ref)

**Rejected** (never satisfy an implementation-approval gate):

- `agent-lifecycle`, `xbrief-status`, `dispatch-envelope`, `allocation-context`,
  `self-asserted`, `agent-authored`
- any grant with actor `agent` / `agent:*` / `self`

Structural binding (not crypto/HMAC):

- `scope.planRef`, `repo`, `branch`, `worktree`
- `scope.surfaces` — path globs (including user-visible UI)
- `scope.operations` — `edit` \| `push` \| `pr` \| `merge` \| `settings` \| `deployment` \| `issue_mutation`
- `scope.storyIds` / `issueIds`
- `scope.cohortId` — **required** for product mutations while UAT is active
- `semantics.expiresAt` / `singleUse`

## Fail-closed UAT mutation lease

Start: `deft authz:uat-start -- --campaign <id>`  
Suspend: `deft authz:uat-suspend`  
Inspect: `deft authz:show`

While UAT is **active** (and was started with human-origin provenance):

| Attempt | Result without matching fix-cohort grant |
| --- | --- |
| Product / UI direct write | **deny** |
| `git push` / classifiable push MCP | **deny** |
| `gh pr create` / ready / edit | **deny** |
| `gh pr merge` / classifiable merge MCP | **deny** |
| settings / deploy heuristics | **deny** |
| Test execution (`vitest`, `pnpm test`, …) | **allow** |
| Issue filing (`gh issue create`) | **allow** |
| Evidence / defect capture writes (`xbrief/proposed/**`, `**/evidence/**`, `incidents/**`) | **allow** |

Approving one named fix cohort **does not** clear the UAT lock or authorize adjacent
failures or other operations (e.g. edit grant ≠ push).

## Enforcement order (PreToolUse)

1. Ritual / scope / read-only / spawn gates
2. **Authz Wave 1** — UAT lease + human-origin grant (`#2944`)
3. Runtime authority path + `scopes.edits` / `scopes.push` / `scopes.merge` (#1394 / #2711)

Denials name the missing permission and the human action required (typically
`deft authz:grant -- --cohort <id> --operations … --surfaces …`).

Audit appends to `.deft/authz/audit.jsonl` with:

`humanApprovalRef`, `approvedScope`, `attemptedOp`, `path`, `result`, `code`, `campaignId`.

## CLI

```bash
deft authz:show
deft authz:uat-start -- --campaign uat-2026-07-30
deft authz:grant -- --operations edit --surfaces 'apps/web/src/**' --cohort fix-defect-12 --stories 2944
deft authz:uat-suspend
deft authz:revoke -- grant-…
```

## Explicit non-goals (siblings)

| Concern | Owner |
| --- | --- |
| Shell/MCP push/merge matchers alone | #2711 |
| Slash-command intent ceiling / human merge | #1193 |
| Path write fence schema | #516 / #2443 |
| AFK session-auth / release verbs | #1095 |
| HMAC / hardware-keyed grants | non-goal for MVP |

Refs #2948 #2711 #1394 #1378 #2176 #2402.
