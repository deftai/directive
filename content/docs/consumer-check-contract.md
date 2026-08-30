# Consumer check contract (`verify:consumer-check-contract`)

Refs: #3145 · Related: #3070 consumer gate integrity, #1519 check:consumer · Policy: #3314 coverageDebt / checkResume (reserved)

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

## Merge-chokepoint gate scoping (#3893)

Some gates are repo-wide by default and must be **narrowed** when composed on a
merge chokepoint. `verify:orphan-active` is the first: composed unscoped it
fails a candidate for lifecycle residue another merge stranded, and N stranded
briefs make N single-brief lifecycle PRs mutually unmergeable.

The contract therefore records a required argument per gate
(`MERGE_CHOKEPOINT_SCOPED_GATE_ARGS`) and reports a check aggregate that lists
the gate without it:

```yaml
  check:consumer:
    deps:
      - task: verify:orphan-active
        vars:
          CLI_ARGS: "--changed-only"
```

The check reads the dependency's effective `CLI_ARGS` value, not the raw entry
text, so the flag appearing in a comment, a sibling variable, or a descriptive
value does not satisfy it.

- **`--framework-source`: fail closed.** This repo owns its own composition, so
  a regression to the unscoped form is a hard failure here.
- **Consumer deposits: warn.** `deft update` re-deposits the Taskfile; the
  warning names the exact one-line repair in the meantime.
- **Aggregates that do not list the gate are silent.** Include-only greenfield
  roots and orchestrator-body `check` tasks are unaffected.

This is a strengthening, not a relaxation: nothing about the detector, the
required-gate set, or any exit code is weakened. Repo-wide residue truth still
runs on the bare verb, at the delivery tip, and on the after-merge
`verify:orphan-active -- --issue N` DONE gate (#3429).

## Repair path

1. Restore deposit Taskfiles: `deft update` (includes `tasks/verify.yml` under `.deft/core/`)
2. Ensure `check:consumer` / `check:framework-source` deps list the three gates (framework source already ships this wiring), **or** keep the include-only greenfield shape so the gate follows the canonical include
3. Prefer CI that runs `task check` / `task deft:check` / `deft check` rather than a partial custom graph (installer-only workflows such as `deft-core-guard` stay warn-only for CI composition)

## Relation to #3070

`consumer-gate-integrity` proves Taskfile includes resolve. This gate proves the **required enforcement set** is present and composed — not merely that a random verify task exists.

## Coverage-debt hatch and local check resume (#3314)

Release-born hatch and suite-stamp features must not expand to consumers as silent defaults. Two **plain optional** fields live under `plan.policy` in PROJECT-DEFINITION. Both default off. Both are **reserved** — `task check` and `task release` do not read them.

| Field | Shape | Fail-closed when absent / invalid / off |
|---|---|---|
| `coverageDebt.mode` | `off \| warn \| hatch` | no hatch soft-pass |
| `checkResume.localStamp` | `off \| on` | no local suite-stamp resume; **CI never trusts a laptop stamp** |

Inspect with `deft policy:show --field=coverageDebt` and `--field=checkResume`. Doctor check `coverage-check-resume-policy` reports a **malformed typed block** (advisory skip). Absent or valid values pass. Interactive mutation session-start prints a one-line disclosure when either field is non-default; silent when both default.

`task check` is fail-closed **by policy**. The live manual hatch is `--allow-coverage-debt=#N` (#2866). Framework `task release` Step 5 hatch is #3187. These flags do not control either path.

### Expansion gates

| Feature | Status | Notes |
|---|---|---|
| Fast-before-slow gate ordering | Available | Universal UX; no policy wait |
| Local suite stamp resume | **Reserved** | Setting exists; consumer expansion not implemented |
| Coverage hatch / auto-file | **Reserved** | Setting exists; consumer expansion not implemented. Live hatch: `--allow-coverage-debt=#N` (#2866) |
| CI trusts local stamp | **Not v1** | Separate RFC |

### Non-goals

- Silent default-on hatch for consumers.
- Auto-filing coverage-debt issues on **deftai/directive** from a consumer tree — the ledger is always **this** repo.
- USER.md as source of truth for ship bars (personal never weakens the project bar).
- A session-start Strict / Hatch-aware / Later quiz.
