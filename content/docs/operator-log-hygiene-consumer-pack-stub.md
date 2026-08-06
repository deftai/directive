# Operator-log hygiene — optional consumer pack stub (#1940)

Skeleton for **consumer projects** that want a ship-gate for operator-facing
logs. Wire this into *your* check aggregate only if you opt in.

Full pattern: [`patterns/operator-log-hygiene.md`](../patterns/operator-log-hygiene.md).
Checklist: [`operator-log-hygiene-checklist.md`](./operator-log-hygiene-checklist.md).

## Settled boundaries

| Topic | Rule |
|-------|------|
| Default-on | **Off.** Directive core does not enable this for all services. |
| Schema | **Consumer-owned.** You define fields and glossary path. |
| Framework `deft check` | **Does not** hard-fail consumers who never opted in. |
| External refs | SLizard `task operator-log:validate` is a **reference** only. |

## Suggested Taskfile target name

Prefer a project-local name so it does not imply framework ownership:

```yaml
# tasks/observability.yml (consumer-owned example — not shipped by core)
version: "3"

tasks:
  operator-log:validate:
    desc: Validate operator-facing log shape / glossary (consumer-owned)
    cmds:
      - echo "Implement inventory + schema checks for YOUR log contract"
      # - node scripts/validate-operator-log.mjs --strict
```

Optional aliases consumers sometimes use:

- `observability:validate`
- `ops-log:check`

Pick one name and keep it stable in your repo.

## Validator skeleton (comments only)

```js
// scripts/validate-operator-log.mjs  (consumer-owned skeleton)
//
// 1. Inventory: find operator-facing log call sites (WARN/ERROR + terminal events).
// 2. Schema: load YOUR glossary / field contract (path from project config).
// 3. Strict mode: fail if new events lack required consumer fields.
// 4. Exit 0 when clean; exit 1 with actionable paths when not.
//
// ⊗ Do not import SLizard glossary JSON as universal SoT.
// ⊗ Do not expect @deftai/directive to ship or enforce this script.
//
// Reference shape (external): deftai/slizard task operator-log:validate
```

## Wire into *your* check (optional)

```yaml
# In the consumer Taskfile check aggregate — only if you want hard-fail
tasks:
  check:
    deps:
      - operator-log:validate
      # ...other consumer gates...
```

- ! MUST document the gate as **project policy** when enabled
- ⊗ MUST NOT claim framework `deft check` mandates this target by default
- ? MAY keep the script warn-only until glossary coverage is good enough

## Related

- #1940 thin v1 — content + checklist + this stub
- Pattern non-goals: no `plan.observability` core schema, no default-on
