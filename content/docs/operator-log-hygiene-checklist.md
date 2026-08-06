# Operator-log hygiene checklist (#1940)

Copy-paste block for **story acceptance criteria** and **probe locked
decisions**. Full pattern:
[`patterns/operator-log-hygiene.md`](../patterns/operator-log-hygiene.md).

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT, `?`=MAY.

**Load when:** building operator-facing services, adding WARN/ERROR paths
operators triage, multi-process workers, or probing logging decisions.

## Story AC / probe locked decisions (copy-paste)

Use as-is in scope xBRIEF acceptance, probe locked decisions, or PR
checklist. Mark N/A only with a one-line reason.

```markdown
### Operator-log hygiene (#1940)

- [ ] Terminal / completion events on **all** exit paths (success, skip,
      timeout, supersede, cancel, failure) — not happy path only
- [ ] Correlation IDs for multi-process / pool designs (job id, slot,
      phase, parent id as applicable)
- [ ] Infrastructure paths (rotation, flush-before-exit, IPC handoff,
      boot supervision) fail-open where possible and emit structured
      events when they degrade
- [ ] Operator-visible WARN/ERROR use a stable, queryable shape
      (consumer-owned fields; e.g. stable event id + short operator
      summary) — not ticket numbers alone
- [ ] Operator glossary / plain-English docs updated in the **same PR**
      when operator-facing log lines change
- [ ] Explicit non-goals respected: no assumption that core `deft check`
      enforces this; log shape stays consumer-owned
```

## Agent rules when applying the checklist

- ! MUST run this checklist before claiming "logging done" on an
  operator-visible lifecycle path
- ! MUST keep log field names and schemas **project-owned** unless the
  consumer already defined them
- ~ SHOULD attach the checklist under probe locked decisions when the plan
  introduces or changes operator-facing logs
- ⊗ MUST NOT invent a framework-wide required field set (`operatorSummary`,
  etc.) from this checklist alone
- ⊗ MUST NOT treat Product Insights (#2603) or LLM telemetry (#481) as
  substitutes for operator-log hygiene

## Related

- Pattern: `content/patterns/operator-log-hygiene.md`
- Optional consumer pack stub: `content/docs/operator-log-hygiene-consumer-pack-stub.md`
- External case study (reference only): deftai/slizard operator-log hygiene docs and `operator-log:validate` — do not import schema into core
