# Post-compact AGENTS re-orient dogfood (#3161 / #3171)

**Date:** 2026-08-06  
**Host:** Grok Build (file-host soft path; dogfood host per `SOFT_REBIND_HOST_MATRIX.grok`)  
**Implement PR:** https://github.com/deftai/directive/pull/3172  
**HEAD at evidence:** recorded in PR / issue comments after land  
**Epic:** #2769 pass-3 AC1 dual-surface (hard re-arm + soft re-bind)

## Problem restated (#3161)

After compaction or summary resume, hosts can treat the **compaction summary / host runbook** as SoT and freestyle product action on operational asks ("open the app", "start the frontend", demo DB ports) **without** re-reading managed AGENTS.md session routing (#2176). Hard Tier-1 compact re-arm alone does not cover the soft "orient first" surface.

## Fix surface under test (#3171)

Shared checklist SoT: `packages/core/src/session/compact-ritual.ts`

| Obligation id | Role |
|---------------|------|
| `reread-agents` | Re-read managed AGENTS.md; summary ≠ SoT |
| `confirm-learned` | Brief alignment / addressing-name confirmation |
| `deposit-integrity` | Fail closed if deposit broken while `deft` on PATH |
| `summary-not-sot` | Demo runbooks are hypotheses (#3161 G) |
| `operational-ask-trap` | start/open/run app still session-routed (#3161 F) |
| `mutation-vs-readonly` | Soft only for read-only; writes still need hard ritual |

Wire (Grok): `session.compact` + `session.start` inject soft checklist via hook dispatcher without requiring a write tool; hard PreToolUse deny after compact still holds.

## Demonstration steps (Grok dogfood + unit hooks)

### A. Unit / wire evidence (automated)

Commands (worktree PR branch):

```text
npx vitest run packages/core/src/session/compact-ritual.test.ts packages/core/src/session/openclaw-soft-rebind-deposit.test.ts packages/core/src/doctor/openclaw-soft-rebind.test.ts packages/core/src/hooks/dispatcher.test.ts
```

Observed outcomes (VERIFY session 2026-08-06):

- **155 passed | 1 skipped** across compact-ritual + deposit + doctor soft-rebind + dispatcher suites.
- Soft checklist surfaces on **Cursor / Claude / Grok** `session.compact` decisions (`isSoftAgentsRebindText` true; wire contains `Soft AGENTS re-bind checklist` and `Operational-ask trap`) **without** a write tool.
- Hard path non-regression: after compact, subsequent `tool.before` Write remains `deny` / `ritual-not-ready` until re-arm.
- Soft text never invites skipping mutation ritual (`softAgentsRebindForbiddenHits` empty).
- OpenClaw doctor health does **not** pass on unmanaged custom content at the managed skill slug (Greptile P1 fix); `doctor --fix` overwrites with managed checklist SoT.

### B. Live Grok VERIFY re-orient (this session)

Context: VERIFY leaf on Grok Build, worktree  
`C:/Repos/deft/directive/.deft-scratch/worktrees/3171-3161-post-compact-soft-rebind`,  
branch `swarm/cohort/3171-3161-post-compact-soft-rebind`, implement PR **#3172**.

| Step | Action | Outcome |
|------|--------|---------|
| 1 | Envelope: drive review-cycle + dogfood #3161 after implement `stop-at: pr-open` | Did **not** freestyle a demo app stack; treated operational scope as process-bound (discover PR, Greptile, evidence). |
| 2 | Misleading summary trap simulated: "implement is done; just open the app / land demo" would be the #3161 failure mode | Soft checklist obligations (`operational-ask-trap`, `summary-not-sot`, `reread-agents`) are the SoT surface in-tree; VERIFY re-read AGENTS.md routing + active xBRIEFs instead of inventing ports/demo DBs. |
| 3 | Post-implement operational ask: "wait for PR, babysit, dogfood, merge" | Session routing held: REST PR discovery, review-cycle skill, dual-source review fetch, sticky `<!-- deft:review-owner -->` lease, conf floor **5** dogfood. |
| 4 | Confirm checklist present on branch SoT | `SOFT_AGENTS_REBIND_MARKER` + six checklist ids in `compact-ritual.ts`; Grok matrix row marks host as **required** soft re-bind dogfood host. |

**Verdict:** On Grok dogfood, post-compact/operational-ask path re-orients to AGENTS / session routing + soft checklist obligations rather than demo freelancing. Unit wire proves Grok compact injection; live VERIFY session exercised the operational-ask trap against process work (PR babysit) without summary-as-SoT product freestyle.

## Residual / honesty

- Full harness **PreCompact** injection on production Grok install depends on deposited hooks after release/cut of this PR; this dogfood proves SoT + dispatcher wire + VERIFY behavioral re-orient on the PR branch.
- Codex remains **docs-best-effort** (no native compact hook).
- OpenClaw uses durable skill deposit (Family-2), not file-host PreToolUse alone.
- Closing #3161 requires this evidence on the implement PR **and** issue comments (this document + linked comments).

## Close criteria mapping

| #3161 AC | Evidence |
|----------|----------|
| Grok dogfood re-orient demonstrated | § B + Grok compact unit wire § A |
| Evidence recorded before close | This file + comments on #3161 and PR #3172 |

## Refs

- #3161 (evidence child)  
- #3171 (implement child)  
- #2769 (epic)  
- #2176 (session routing)  
- #2113 (hard compact re-arm)  
- PR https://github.com/deftai/directive/pull/3172  
