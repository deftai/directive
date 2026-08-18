# Project invariants (`plan.policy.projectInvariants`)

Refs: #3425 · Related: #3238 `coverage_map`, #3241 parent lineage, #516 / #3145 `file_scope`

Authored must-not-break contracts for a shared product. Every running story must
declare how it treats the invariants that apply to its `file_scope`. Empty or
absent list is a no-op.

## Authored list

SoT is PROJECT-DEFINITION `plan.policy.projectInvariants`. Inspect with
`task policy:show --field=projectInvariants`.

Each entry:

- `id` — stable key reused on the scope `coverage_map`
- `statement` — the contract in operator language
- contract surface — `paths` and/or `moduleIds` (module ids resolve through
  `plan.architecture.codeStructure.modules[].pathGlobs`)

## Scope coverage

Reuse the #3238 `coverage_map` shape against **applicable** project IDs:

| Disposition | Required side field |
| --- | --- |
| `covered` | none |
| `deferred` | `provenance.reason` + target |
| `behavioral_delta` | `delta_id` linked in `behavioral_deltas` |
| `not_applicable` | `reason` |

`split` is excluded at project level.

Applicability is contract surface × the story's `file_scope`. Empty intersection
means no disposition is required for that ID.

## Gate

`task xbrief:preflight` and `task verify:story-ready` fail closed when an
applicable ID has no disposition. The message names the omitted ID. Slice-scoped
and worktree-scoped stories use the same check.

The check evaluates the list **as of preflight time**. An ID added after a story
was authored fails that story on its next preflight and names the new ID.

## Honesty limit

The gate verifies **completeness of declarations**, not truth. A scope cannot
break an *undeclared* applicable contract without failing preflight. A declared
`covered` is not executed or scored. Truth-checking is review-cycle / follow-up.

This slice does **not** load the list at session-start or in the preamble.

## Authored examples (not framework oracles)

Operators author product entries. Directive never runs Visage or scores
"module purpose." Two shapes that belong in a consumer PROJECT-DEFINITION, not
in Directive itself:

```json
{
  "plan": {
    "policy": {
      "projectInvariants": [
        {
          "id": "visage-load-save",
          "statement": "Launch-prep must not change a project folder so Visage can no longer load it.",
          "paths": ["src/launch-prep/**"]
        },
        {
          "id": "sibling-purpose",
          "statement": "Existing modules stay independently useful. Integration with a new module is optional; independence is required.",
          "moduleIds": ["project-io", "canvas"]
        }
      ]
    }
  }
}
```
