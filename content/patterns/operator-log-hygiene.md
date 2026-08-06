# Operator-log hygiene — structured operator-facing logs (#1940)

Guidance for consumer services that humans operate. Declare and keep
structured, operator-facing logs so outages are diagnosable without a
week of reactive firefighting.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** implementing or reviewing services with operator dashboards,
WARN/ERROR paths operators triage, multi-process / parent-child workers,
or story AC / probe locked decisions about logging.

**Not this pattern:**
- Directive Product Insights / remote usage analytics — #2603
- LLM-call telemetry — `patterns/llm-app.md`, `tools/telemetry.md` / #481
- Framework DDD glossary — `glossary.md` / `deft-directive-glossary`

**⚠️ See also**:
- [../docs/operator-log-hygiene-checklist.md](../docs/operator-log-hygiene-checklist.md) — copy-paste build/probe checklist
- [../docs/operator-log-hygiene-consumer-pack-stub.md](../docs/operator-log-hygiene-consumer-pack-stub.md) — optional consumer Taskfile/validator stub
- [./llm-app.md](./llm-app.md) — LLM-specific observability (different lane)
- [../tools/telemetry.md](../tools/telemetry.md) — general telemetry guidance

## Honest value claim

This pattern speeds **second systems**, shared language across services, and
regression prevention when you opt in. It does **not** claim it would have
avoided any first production week, or that the framework knows your field
names. Log **shape** stays consumer-owned.

## Failure modes (case study)

When operator logging is left implicit, the same six deficiencies recur:

1. **Happy-path-only terminals** — sessions finish externally (checks, UI)
   while durable logs omit tail events on skip, timeout, supersede, cancel,
   or error exits.
2. **Missing correlation context** — multi-worker / parent-child designs ship
   without slot, phase, or job-scoped IDs; forensics need archaeology.
3. **Infrastructure treated as debug-only** — log rotation, flush-before-exit,
   IPC handoff, and boot supervision lack fail-open guards and structured
   events until production crashes.
4. **Opaque operator text** — WARN/ERROR carry ticket numbers and engineer
   `msg` strings; operators cannot triage severity or whether work continued.
5. **Dishonest parent/child contracts** — parent logs imply success when IPC
   never delivered; metrics and pollers infer wrong outcomes.
6. **Hygiene lags the log line** — glossary and plain-English summaries land
   in follow-up issues, not the same PR as the log line.

## Positive rules

- ! MUST emit terminal / completion events on **all** exit paths for a unit
  of work that has operator-visible lifecycle (success, skip, timeout,
  supersede, cancel, failure) — not only the happy path
- ! MUST include correlation context for multi-process or pool designs
  (for example job id, slot, phase, parent id) so one incident can be
  reconstructed without log archaeology
- ! MUST treat infrastructure paths that affect operator truth (rotation,
  flush, IPC handoff, boot supervision) as first-class: fail-open where
  possible, with structured events when they degrade
- ~ SHOULD give operator-facing WARN/ERROR a stable, queryable shape
  (stable event id + short operator-readable summary fields are common)
  without requiring a Directive-owned schema
- ~ SHOULD update operator log glossary / plain-English docs in the **same
  PR** that adds or changes operator-facing log lines
- ? MAY wire a consumer-owned validator into *your* `task check` aggregate
  (see the consumer pack stub) — optional, never default-on in core

## Anti-patterns

- ⊗ Terminal events only on success while skip/timeout/error paths stay silent
- ⊗ Multi-worker systems with no job/slot/phase correlation on log lines
- ⊗ Treating rotation, flush, IPC, or boot supervision as "debug detail"
  with no structured signal when they fail
- ⊗ Operator-facing WARN/ERROR that only carry ticket numbers or engineer
  free-text with no stable event identity
- ⊗ Parent logs that claim success when the child message was never delivered
- ⊗ Landing operator log lines without same-PR hygiene (docs/glossary/shape)
- ⊗ Assuming Directive core will enforce your log schema or fail `deft check`
  for every consumer by default

## Explicit non-goals (thin v1)

- ⊗ No core `plan.observability` / setup Phase 2 interview defaults in this
  issue's close path
- ⊗ No core `deft check` hard-fail for consumers who never opted in
- ⊗ No prescription or validation of a fixed field set (`operatorSummary`,
  glossary JSON schema, etc.) inside Directive core
- ⊗ No default-on magic for all "service" project types
- ⊗ No import of any external project's glossary JSON or validate task as
  framework SoT
- ⊗ Not Product Insights (#2603) and not LLM-call telemetry (#481)

Hard-fail enforcement is allowed only when a **consumer** wires their own
gate. Log shape remains consumer-owned.

## External reference (SLizard — reference only)

A production case study lives in **deftai/slizard** (June 2026 postmortem and
follow-on hygiene work). Cite it as an **external reference implementation**,
not as Directive schema:

| External pointer | Role |
|------------------|------|
| SLizard `docs/operator-log-hygiene.md` | Project hygiene write-up |
| SLizard `docs/operator-log-glossary.json` | Consumer-owned glossary shape |
| SLizard `task operator-log:validate` | Consumer ship-gate example |
| SLizard origin issues (e.g. #1394 LD-8, #1402) | How hygiene landed under fire |

- ! MUST treat those paths and schemas as **pointers only**
- ⊗ MUST NOT copy SLizard glossary JSON or validate schema into Directive
  core as a mandatory contract
- ⊗ MUST NOT close framework work by importing that repo's field names as
  universal requirements

## Build and probe

Copy-paste AC / probe bullets:
[`docs/operator-log-hygiene-checklist.md`](../docs/operator-log-hygiene-checklist.md).

Optional consumer Taskfile + validator skeleton:
[`docs/operator-log-hygiene-consumer-pack-stub.md`](../docs/operator-log-hygiene-consumer-pack-stub.md).

## Cross-references

- #1940 — consumer operator-log hygiene thin v1 (this pattern)
- #2603 — Product Insights (different lane)
- #481 — LLM-specific observability (different lane)
- #1516 — product-pulse health report (adjacent ops UX, not log contract)
- #829 — skill usage telemetry (framework internal)
