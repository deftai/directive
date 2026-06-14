# Investigation vBRIEF profile

Thin subset of vBRIEF core v0.6 for forensic ledgers. Full schema: `vbrief/schemas/vbrief-core.schema.json`. This profile defines what sub-agents must read and write.

**Path:** `.tmp/investigations/<id>/investigation.vbrief.json`

---

## Required fields

| Field | Purpose |
|-------|---------|
| `vBRIEFInfo.version` | `"0.6"` |
| `vBRIEFInfo.description` | One-line investigation summary |
| `plan.id` | Same as investigation folder slug |
| `plan.title` | The causal question |
| `plan.status` | `running` → `completed` \| `failed` \| `cancelled` |
| `plan.narratives.Problem` | **Anchor** — what/when/where (PR, UTC window, crId, symptom) |
| `plan.items[]` | Logic tree (branches + nested claims) |
| `plan.metadata.x-investigation` | Machine state (see below) |

## Encouraged fields

| Field | Purpose |
|-------|---------|
| `plan.narratives.Hypothesis` | Ranked survivors (synthesizer) |
| `plan.narratives.Observation` | Key evidence notes |
| `plan.narratives.Outcome` | Final conclusion + residual uncertainty |
| `plan.edges[]` | `invalidates`, `informs`, `blocks`, `suggests` |
| `plan.references[]` | Evidence registry (`EV-…`) — see § Evidence reference types |

## Omit (investigation profile)

⊗ `plan.policy`, recurrence, reminders, dueDate, ImplementationPhases, AcceptanceCriteria unless graduating to a story vBRIEF.

---

## `plan.metadata.x-investigation`

```json
{
  "profile": "forensic-research-v1",
  "domain": "slizard-production",
  "wave": 2,
  "anchor": { "crId": "owner/repo#39", "utcFrom": "...", "utcTo": "..." },
  "agents": {
    "orchestrator": "session-id",
    "branch.admission": "agent-id",
    "trap-runner": "agent-id"
  }
}
```

| Field | Notes |
|-------|-------|
| `profile` | Always `forensic-research-v1` |
| `domain` | Pack id from `references/domains/` |
| `wave` | Current wave 0–5 |
| `anchor` | Structured copy of anchor for machines |
| `operatorQuestionVerbatim` | Full operator message or slowness clause (natural language) |
| `mode` | `active` while forensic mode on; ended timestamp on exit |
| `parentInvestigationId` | Set on spawned child; null on root |
| `agents` | Who owns which branch/trap |
| `wavesCompleted` | `{ "1": true, … "4": true }` — orchestrator sets before Wave 5 |
| `validatorPassedAt` | ISO timestamp when validator last passed clean; null until pass |
| `chatEmbargo` | `true` while `plan.status: running` and validator not passed |

---

## Evidence reference types (`plan.references[]`)

| id prefix | `type` | When to use |
|-----------|--------|-------------|
| `EV-LOG-*` | `log-excerpt` | Persistent log grep, phase lines, lifecycle parse |
| `EV-FLEET-*` | `metric-snapshot` | Day-wide started/timeout/completed, phase averages |
| `EV-FLY-*` | `infra-snapshot` | `fly status`, machine events, health checks |
| `EV-GH-*` | `github-api` | PR files, check runs, timeline |
| `EV-SECRETS-*` | `config-runtime` | `fly secrets list`, printenv |
| `EV-STATUS-*` | `metric-snapshot` | `/status` JSON, crs.active gauges |
| `EV-OPERATOR-*` | `operator-assertion` | **High-trust operator context** — host sickness, "lone review", deployment notes. Same evidentiary weight as logs when recorded verbatim with timestamp. Re-verify if operator **challenges** an agent claim. |

Each reference: `{ "id": "EV-…", "type": "…", "description": "one-line fact", "uri": "file://evidence/…" }` when file-backed.

---

## PlanItem conventions

### Branch (top-level `plan.items[]`)

| Field | Value |
|-------|-------|
| `id` | `branch.<name>` e.g. `branch.queue`, `branch.inrun` |
| `title` | Branch question |
| `status` | `pending` → `running` → `completed` \| `failed` \| `cancelled` |
| `items[]` | Child claims |

Branch `failed` = entire causal path ruled out (all dispositive claims falsified).

### Claim (nested items)

| Field | Value |
|-------|-------|
| `id` | `claim.<branch>.<n>` e.g. `claim.queue.B1` |
| `title` | Falsifiable statement |
| `status` | `pending` \| `running` \| `completed` (verified) \| `failed` (falsified) \| `blocked` (unknown, no path) |
| `metadata.x-claim` | See below |

### `metadata.x-claim`

```json
{
  "requiredEvidence": "crs.active.github at incident time vs maxConcurrentReviews",
  "prediction": "If concurrency caused delay, active count >= 80% of cap during wait window",
  "evidenceRefs": ["EV-003", "EV-004"],
  "ruledOutReason": "active=2, cap=8 at T — saturation disproved"
}
```

| Field | Required when |
|-------|----------------|
| `requiredEvidence` | Always |
| `prediction` | Always (diagnose-style falsifiable) |
| `evidenceRefs` | `status: completed` or `failed` |
| `ruledOutReason` | `status: failed` |

---

## Evidence references (`plan.references`)

| Field | Value |
|-------|-------|
| `uri` | `file://.tmp/investigations/<id>/evidence/<file>` or external URL |
| `type` | `x-vbrief/research` or `x-investigation/<kind>` |
| `title` | Short label |
| `description` | What this proves (optional) |

**Id convention:** reference `title` or metadata id = `EV-001`, `EV-002`, … Orchestrator assigns ids; branch agents append only new ids.

Store bulky output in `evidence/` files; ledger holds pointers only.

---

## Edges (`plan.edges`)

| type | Meaning |
|------|---------|
| `invalidates` | Evidence or claim disproves target branch/claim |
| `informs` | Supports but does not alone verify |
| `blocks` | Target cannot proceed until source resolved |
| `suggests` | Weak lead — not sufficient for conclusion |

Example: `{ "from": "claim.queue.B1", "to": "branch.queue", "type": "invalidates" }` when B1 falsified.

---

## Status mapping

| Investigation meaning | PlanItem `status` |
|-----------------------|-------------------|
| Verified | `completed` |
| Falsified | `failed` |
| No path to check | `blocked` |
| Not yet examined | `pending` |
| Agent working | `running` |

---

## Write boundaries (sub-agents)

| Agent | May write |
|-------|-----------|
| trap-runner | Trap claims, edges, references, branch `failed` |
| branch.* | Own `branch.<x>` subtree, related references, edges from its claims |
| falsifier | Edges `invalidates`, claim status updates, new references |
| red-team | Same as falsifier for lead theory only |
| synthesizer | `narratives.*`, `plan.status`, `outcome.md` |
| orchestrator | Scaffold, `x-investigation.wave`, merge conflicts, dispatch |

⊗ Branch agent edits another branch's items. ⊗ Synthesizer invents evidence refs.

**Merge:** bump `plan.sequence` (if present) or `vBRIEFInfo.updated` on each write. `lastModifiedBy.agent` = role name.

---

## Validator pass (orchestrator, before Wave 5)

Run after Waves 1–4 complete. On pass: set `metadata.x-investigation.validatorPassedAt` and `chatEmbargo: false`. On fail: fix ledger/waves; ⊗ write `outcome.md`; ⊗ causal chat.

Hard failures — investigation cannot close:

1. `wavesCompleted` missing `"3": true` or `"4": true` (falsifier + red-team skipped — CF-2)
2. `plan.status` still `running` when attempting Wave 5 synthesis
3. Any `failed` claim lacks `ruledOutReason` + `evidenceRefs`
4. Any `completed` claim lacks `evidenceRefs`
5. Any recommendation in `narratives.Outcome` cites a claim not `completed`
6. Cited `EV-*` id missing from `plan.references`
7. Branch `failed` but no `invalidates` edge from a falsified child claim
8. Trap marked `failed` in domain pack but branch still `pending` without explicit override note in `Observation`
9. Operator asked slowness question but `outcome.md` §2 is only phase durations or timeout (tautology — see `question-framing.md`)
10. Dominant phase named but no `branch.mechanism.<phase>` items exist (Wave 2b skipped)
11. Mechanism claim `completed` with indirect evidence (or any `blocked` mechanism sibling) but `outcome.md` lacks §2b Observability gaps
12. Concurrency/queue cited in `Outcome` but domain pack concurrency trap not `completed` or `failed` with evidence
13. Host/pressure mechanism inference without §2b listing absent telemetry (verified negative grep counts)

Soft warnings — note in `Outcome`:

- Multiple survivors with equal evidence strength
- Residual `blocked` claims on live branches
- Sub-agent returned `blocked: needs_shell` — note orchestrator prefetch gap