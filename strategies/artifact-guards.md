# Artifact Idempotency Guards

Shared guard rules for strategies that write to vBRIEF artifacts. Referenced by individual strategy files to prevent silent overwrites of approved or completed work.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [vbrief/vbrief.md](../vbrief/vbrief.md) | [strategies/interview.md](./interview.md)

---

## When to Use

This file is not a standalone strategy — it is a shared guard referenced by other strategies. It activates automatically when a strategy writes to vBRIEF artifacts.

- ! Referenced by spec-generating strategies: [speckit](./speckit.md), [enterprise](./enterprise.md), [rapid](./rapid.md)
- ! Referenced by preparatory strategies: [bdd](./bdd.md), [discuss](./discuss.md), [research](./research.md), [map](./map.md)

## Workflow

1. Strategy reaches its output step
2. Strategy follows the appropriate guard (Spec-Generating or Preparatory) from this file
3. Guard checks file existence and status, prompts user if needed
4. Strategy proceeds with the write or aborts based on user response

---

## Spec-Generating Guard (Full)

Applies to strategies that write to `specification.vbrief.json` or `PROJECT-DEFINITION.vbrief.json`: **speckit**, **enterprise**, **rapid**.

! Before writing to `vbrief/specification.vbrief.json` or `vbrief/PROJECT-DEFINITION.vbrief.json`, the strategy MUST perform the following checks:

1. ! **Check existence**: Does the target file already exist?
   - If NO: proceed with the write — no guard needed.
   - If YES: continue to step 2.

2. ! **Read `plan.status`**: Parse the existing file and read `plan.status`.

3. ! **Status: `approved` or `completed`**: Refuse to overwrite without explicit user confirmation.
   - ! Display: "This artifact has status `{status}`. Overwriting will reset it to `draft` and discard approved/completed state. Continue? (yes/no)"
   - ! Accept only explicit affirmative (`yes`, `confirmed`) — not vague responses (`proceed`, `ok`, `go ahead`)
   - ⊗ Silently overwrite an approved or completed artifact

4. ! **Status: `draft` or `running`**: Warn and ask before overwriting.
   - ! Display: "A `{status}` version of this artifact already exists. Replace it? (yes/no)"
   - ~ If the user declines, offer to enrich (merge narratives) instead of replacing

5. ! **Narrative preservation**: When overwriting `PROJECT-DEFINITION.vbrief.json`, read existing `narratives` keys first. If the strategy only writes a subset of narratives (e.g. speckit Phase 1 writes only `Principles`), merge the new narrative into the existing set — do NOT replace all narratives with only the new key.
   - ⊗ Overwrite all `PROJECT-DEFINITION.vbrief.json` narratives when the strategy only produces a single narrative key

---

## Preparatory Guard (Light)

Applies to strategies that write scoped vBRIEFs to `vbrief/proposed/`: **bdd**, **discuss**, **research**, **map**.

! Before writing a scope vBRIEF to `vbrief/proposed/`, the strategy MUST check for existing files with the same scope or feature name:

1. ! **Check for existing file**: Scan `vbrief/proposed/` for files matching the target scope/feature slug (e.g. `*-{feature}-bdd.vbrief.json`, `*-{scope}-context.vbrief.json`).
   - If NO match: proceed with the write — no guard needed.
   - If a match exists: continue to step 2.

2. ! **Warn and ask**: Display: "A vBRIEF for this scope already exists at `{path}`. Replace it, or create a new version? (replace/new)"
   - ! If replace: overwrite the existing file
   - ! If new: append a numeric suffix or use today's date to create a distinct file

3. ~ **Read existing decisions**: If the existing file contains a `LockedDecisions` or similar narrative, surface those decisions to the agent context so they are not lost even if the user chooses to replace.

⊗ Silently overwrite an existing scope vBRIEF with the same feature/scope name without warning the user.

---

## Anti-Patterns

- ⊗ Writing to `specification.vbrief.json` or `PROJECT-DEFINITION.vbrief.json` without checking the file's current status
- ⊗ Silently overwriting an `approved` or `completed` artifact — this discards locked decisions and approval state
- ⊗ Replacing all `PROJECT-DEFINITION.vbrief.json` narratives when the strategy only contributes one narrative key (e.g. `Principles`)
- ⊗ Overwriting a scope vBRIEF in `vbrief/proposed/` without checking if one already exists for the same scope
- ⊗ Accepting vague confirmation (`proceed`, `ok`) when the guard requires explicit confirmation for approved/completed artifacts
