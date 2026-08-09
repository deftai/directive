# Consumer check contract (`verify:consumer-check-contract`)

Refs: #3145 · Related: #3070 consumer gate integrity, #1519 check:consumer · Policy: #3189 coverageDebt / checkResume

## Problem

A consumer could omit Directive enforcement gates from its `check` task and CI while local and CI success still looked green. Composition was not machine-checked.

## Contract

`task verify:consumer-check-contract` requires these gates to be defined under `tasks/verify.yml` and composed into consumer/framework check aggregates:

- `verify:test-boundary`
- `verify:scope-provenance`
- `verify:consumer-check-contract`

It fails with a concrete repair path when definitions or explicit check deps omit them. CI workflows that neither invoke the gates nor a composing entrypoint (`task check` / `deft check`) produce **warnings** by default (migration).

### Greenfield include-only Taskfile (#3218)

After `directive init`, the consumer root `Taskfile.yml` is often **include-only**:

```yaml
includes:
  deft:
    taskfile: ./.deft/core/Taskfile.yml
    optional: true
```

Operators run `task deft:check` (namespaced include). Composition lives in the **included** framework `Taskfile.yml` + `.deft/core/tasks/verify.yml`, not in root `check` deps.

`verify:consumer-check-contract` **trusts that included graph** when:

1. The root Taskfile declares the canonical `.deft/core/Taskfile.yml` include, and
2. No local `check` / `check:consumer` / `check:framework-source` aggregate is defined at the root, and
3. The included framework Taskfile defines the required gates in `tasks/verify.yml` and composes them (deps or check orchestrator body).

A **partial local** root check aggregate still fails closed — the include must not conceal incomplete root deps.

Root cause of red `greenfield-python-free-smoke` after #3145: the gate only inspected the root Taskfile, treated include-only greenfield as “no check composition,” and hard-failed (`exit 201` via #3188). That was a **gate false positive** for the intentional deposit shape, not a missing deposit wiring bug.

## Repair path

1. Restore deposit Taskfiles: `deft update` (includes `tasks/verify.yml` under `.deft/core/`)
2. Ensure `check:consumer` / `check:framework-source` deps list the three gates (framework source already ships this wiring), **or** keep the include-only greenfield shape so the gate follows the canonical include
3. Prefer CI that runs `task check` / `task deft:check` / `deft check` rather than a partial custom graph (installer-only workflows such as `deft-core-guard` stay warn-only for CI composition)

## Relation to #3070

`consumer-gate-integrity` proves Taskfile includes resolve. This gate proves the **required enforcement set** is present and composed — not merely that a random verify task exists.

## Coverage-debt hatch and local check resume (#3189)

Release-born hatch and suite-stamp features must not expand to consumers as silent defaults. Project policy lives under `plan.policy` in PROJECT-DEFINITION:

| Field | Shape | Fail-closed when unset |
|---|---|---|
| `coverageDebt` | `status: unset \| decided`, `mode: off \| warn \| hatch`, `autoFile` (hatch only; default false) | mode off — no hatch soft-pass |
| `checkResume` | `status: unset \| decided`, `localStamp: off \| on`, `ciTrustsLocalStamp: false` (fixed v1) | localStamp off; **CI never trusts a laptop stamp** |

**Unset vs decided-off:** Unset keeps fail-closed *behavior* and still **nags** on interactive mutation session-start. Decided-off is quiet. Inspect with `deft policy:show --field=coverageDebt` and `--field=checkResume`. Doctor check `coverage-check-resume-policy` surfaces undecided as an **advisory skip** (never hard-fails doctor or `check:consumer`).

### Skippable session nudge

On interactive cold or re-arm **mutation** session-start, when either field is unset:

- **Why:** long checks fail late or barely miss coverage; the project chooses fail-closed, warn, or hatch with a debt issue on **this** repo; local machines may resume a green suite at the same HEAD; CI must not trust a laptop stamp.
- **What:** one bundled choice — **Strict** (recommended), **Hatch-aware**, or **Later** (plus Discuss / Back per #1470).
- **Later** does **not** set `status=decided`; the next ritual nags again.
- **Stop nag** only after Strict / Hatch-aware (preset write) or **dismiss-with-reason** (visible on policy:show / doctor).
- Headless / CI / non-TTY: nudge is skipped (fail-open; never blocks).

### Expansion gates (after decided)

| Feature | Expand to consumers? | Gate |
|---|---|---|
| Fast-before-slow gate ordering | Yes (universal UX) | No policy wait |
| Local suite stamp resume | When `checkResume.localStamp=on` | Local only; CI ignores |
| Coverage hatch / auto-file | When `coverageDebt.mode=hatch` (+ optional `autoFile`) | Ledger on **this** consumer repo |
| CI trusts local stamp | **Not v1** | Separate RFC |

### Non-goals

- Silent default-on hatch for consumers.
- Auto-filing coverage-debt issues on **deftai/directive** from a consumer tree — the ledger is always **this** repo.
- USER.md as source of truth for ship bars (personal never weakens the project bar).
- Blocking headless CI on the nudge.
