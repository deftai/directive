# `plan.acceptance` fields `verify:ac` requires (#4380)

Fields the product AC gate actually reads. Not a schema dump. Derivation
(`#3323` / `#3360`) owns the stamp. Setup stays silent on this block.

Legend (RFC2119): `!`=MUST, `~`=SHOULD, `⊗`=MUST NOT, `?`=MAY.

Load when authoring a scope xBRIEF, when `verify:ac` names a missing field, or
when a pass line shows `0 verified`.

## Exclusive writer

- ! `#4374` derivation is the exclusive writer of `plan.acceptance`.
- ⊗ Setup MUST NOT emit `plan.acceptance` (no schema-complete block, no
  hand-authored `clauses[]`). Hand-authored clauses skip derivation, so
  `needsClauseDerivation` is false and missing `ambiguity_attestation` fires.
- ⊗ Recut `#4374` clause derivation from this issue.

## Fields the gate requires

| Field | When required | Who writes it |
| --- | --- | --- |
| `commands` + `none_stated` | Empty commands are allowed only with `none_stated: true` | Intake / derivation |
| `source_rung` | `stated` / `derived` / `project_floor` | Intake / derivation |
| `ambiguity_attestation` | Required when `clauses[]` is non-empty and no clause has ambiguous readings. Value `none_found` | Derivation (`prepareClauseStamp`). ⊗ A second `none_found` default on the derivation path |
| `clauses[].artifact_path` | Bound from declared `plan.metadata.swarm.file_scope` when `source_rung === "derived"` (`#4008`) | Promote bind, not setup |
| `plan.metadata.swarm.file_scope` | Operator-collected declared members for derived-stamp bind | Operator. ⊗ Agent-invented paths. ⊗ Approved-scope digest mint (`#3145` / `#3110` / `#4383`) |
| `plan.references` / `plan.metadata["x-tracking"].parent_issue` | Forge origin for origin-keyed sweeps | Operator-collected or minted by `task issue:emit`. ⊗ Agent-asserted. Same polarity as `file_scope` (`#4426`) |

Missing attestation is **not** "derivation forgot `none_found`". It fires when
setup or an agent wrote clauses and skipped `#3323` / `#3360`. Provenance is a
derivation/ingest constraint, not a `verify:ac` config field.

## Pass lead vs fail-closed (`#3826`)

A clause with no bound artifact is `unverifiable` and non-adjudicable. On
pre-product `verify:ac` / `task check`, that walk is **not** fail-closed solely
because it has no oracle yet (`#3826`). `scope:complete` is a different reader.

The pass **lead** carries the counts on the first line:

```
verify:ac passed (#3284) (0 verified, N unverifiable) [rung=derived]
```

A later lean that wants zero-verified to fail closed MUST reverse `#3826` and
name the reader (`standalone` / `check` / `complete`).

## See also

- `task verify:ac` in [`../commands.md`](../commands.md)
- Clause bind: `packages/core/src/verify-ac/clauses.ts` (`bindClausesToDeclaredScope`)
- Attestation: `packages/core/src/intake/clause-derivation.ts` (`evaluateAmbiguityAttestation`)
