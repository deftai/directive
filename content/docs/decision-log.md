# Structured agent decision log (#1396)

Durable **intent-debt** records for significant agent and operator choices.

Git history records *what* changed. Decision records capture *why* A won over B, under which rule, and when a later agent should re-open the choice.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to record

! Record a decision when the choice is **significant**:

- architecture
- product behavior
- security
- public / private boundary
- data model
- runtime topology
- hard-to-reverse process

⊗ Record a decision for every trivial scope or routine bugfix.

## Commands

```bash
# Write (flags and/or --body-file JSON)
task decision:write -- \
  --decision "Prefer dual location for decision records" \
  --governing-rule "Significant choices leave durable rationale" \
  --governing-path "content/docs/decision-log.md" \
  --governing-rfc MUST \
  --alternative "scope-only narratives" \
  --alternative "ADR-only" \
  --why-winner "Covers scope-bound and cross-cutting without ADR noise" \
  --confidence high \
  --revisit-trigger "If list/find is painful, revisit folder layout" \
  --scope xbrief/active/2026-08-09-example.xbrief.json \
  --related-issue 1396 \
  --tag process

# List / filter
task decision:list --
task decision:list -- --query mirror --json
task decision:list -- --issue 1423
task decision:list -- --scope xbrief/active/
```

On Windows, prefer `--body-file` for multi-line fields (UTF-8 no BOM temp file).

Invalid schema fails closed (exit 2).

## Schema (lightweight, not xBRIEF lifecycle)

| Field | Required | Notes |
|-------|----------|--------|
| `schemaVersion` | yes | `deft.decision.v1` |
| `id` | yes | kebab slug (derived from decision if omitted) |
| `decision` | yes | what was decided |
| `governingRule` | yes | `{ description, path?, rfc2119? }` or string |
| `alternativesConsidered` | yes | non-empty array of `{ option, whyNot? }` |
| `whyWinner` | yes | why the chosen path won |
| `confidence` | yes | `low` \| `medium` \| `high` |
| `activeScopeRefs` | no | relative scope xBRIEF path(s) |
| `timestamp` | yes | ISO-8601 UTC |
| `revisitTrigger` | yes | when/why to re-open |
| `tags` / `relatedIssues` | no | list filters |

Files: `xbrief/decisions/YYYY-MM-DD-<slug>.decision.json` (committed; not gitignored).

## Dual location

1. **Always** write the JSON file under `xbrief/decisions/`.
2. When `--scope` points at a scope xBRIEF, also append a pointer line under `plan.narratives.Decisions` (string narrative; validators accept extra narrative keys).
3. Use `--standalone` to skip scope attach even if scope refs are present.

Cross-cutting process/architecture decisions often have empty `activeScopeRefs`.

## Enforcement (v1)

! Guidance only in build / pre-pr / portfolio (and related) skills for **significant** choices.

⊗ Do **not** require a decision record before every `scope:complete` in v1 (deterministic complete-hook is later work).

## Split from other surfaces

| Surface | Role |
|---------|------|
| This decision log (#1396) | Single durable rationale events |
| Lessons / compound memory (#1513) | Reusable patterns and anti-patterns |
| `docs/decisions/ADR-*.md` | Heavyweight architecture ADRs — leave alone |
| Portfolio brief (#3198/#3201) | Propose-not-apply; **dispose** into `decision:write` |
| Chat / transcripts | Non-goal |
| Full inter-run memory (#2741) | Related consumer later; not owned by this surface |

## Overlap-cluster dispose (#3315)

! Human-dispose an overlap cluster with `task decision:write`. Put **every** member issue number in `relatedIssues`. Repeat `--related-issue` once per member, or pass `--body-file` JSON with `relatedIssues: [N, M, ...]`. Include a `revisitTrigger`. Free-text MAY name the relationship (duplicate / consolidate / not-duplicate / parent-child / related) and a proposed canonical. No new schema.

! Before re-recommending an overlap, portfolio-priority runs `task decision:list -- --issue N --json` per cited member and parks only when a dispose decision's `relatedIssues` covers this overlap's members, unless `revisitTrigger` applies. This is **advisory skill diligence**, not a `task check` gate.

⊗ Treat the portfolio brief as the decision record (#3198/#3201). ⊗ Auto-close member issues from a dispose write. ⊗ Replace `triage:mark-duplicate`. ⊗ Project cluster labels.

**Boundaries**

| Surface | Role |
|---------|------|
| #886 | Governance tracker |
| #1178 | Pre-filing |
| #786 | PR-output cluster |
| #3198/#3201 | Brief is never the decision record |
| #1396 (this log) | Phase-1 home for dispose records |
| `triage:mark-duplicate` | Unchanged |
| Cluster labels | No projection |

**Ledger earning condition**

A dedicated tracked ledger (`xbrief/.triage-cache/duplicate-clusters.jsonl` + verbs) is **deferred**. Build only when a portfolio/coupling pass re-litigates a cluster **despite** a dispose decision already listing the member issue numbers. Design archive: #3310 (do not re-derive).

## Consumers

- Portfolio dispose (#3198 / #3201 / pilot #3200)
- Overlap-cluster dispose (#3315); ledger archive #3310
- Process policy dogfood (SCM label-mirror first mass-apply #1423)
- Multi-agent handoff continuity (related #2741 class)

## Dogfood seeds

- `xbrief/decisions/2026-08-08-scm-label-mirror-first-mass-apply.decision.json`
- `xbrief/decisions/2026-08-09-portfolio-dispose-into-decision-log.decision.json`

## Cold-path discovery (#3211)

! Always-on AGENTS managed pointer (via `content/templates/agents-entry.md` + `task agents:refresh`), Level-0 `REFERENCES.md` under context/long tasks, and [`inter-run-learning.md`](./inter-run-learning.md) link this surface so a fresh session can name `decision:list` without loading build or pre-pr skills.

## See also

- [`xbrief/decisions/README.md`](../../xbrief/decisions/README.md)
- `task decision:write` / `task decision:list` in [`commands.md`](../commands.md)
- [`inter-run-learning.md`](./inter-run-learning.md) (cold memory SoTs; this log is the durable *why* lane)
