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

## Activate and promote (#4768)

- ! `scope:activate` and `scope:promote` refuse when clause derivation returns applied false and the brief still has no clauses. The intake floor (`commands: []`, `none_stated: true`) stays legal before that step. It is not committed into `active/` on that no-op.
- ! Recovery is a derivable surface: list items, `test:` lines, or `acceptance:` lines (#4374). Derivation remains the only writer.
- ⊗ Do not treat an empty `none_stated` block as an active stamp. A derived stamp that keeps `none_stated: true` and has `clauses[]` is legal.
- ⊗ Do not recut empty-resolution readers or the #3826 0-verified pre-product pass from this refuse.

## Fields the gate requires

| Field | When required | Who writes it |
| --- | --- | --- |
| `commands` + `none_stated` | Empty commands are allowed only with `none_stated: true` | Intake / derivation |
| `source_rung` | `stated` / `derived` / `project_floor` | Intake / derivation |
| `ambiguity_attestation` | Required when `clauses[]` is non-empty and no clause has ambiguous readings. Value `none_found` | Derivation (`prepareClauseStamp`). ⊗ A second `none_found` default on the derivation path |
| `sentences` | Optional. When present, each entry must match a clause or a `confessions` entry or the oracle walk fails closed (#3550) | On the brief. ⊗ A file selector. ⊗ A comment scrape |
| `confessions` | Optional. Explicit confession that a sentence is not a clause. Text must match the sentence | On the brief |
| `clauses[].artifact_path` | Bound from declared `plan.metadata.swarm.file_scope` when `source_rung === "derived"` (`#4008` / `#4986`) | Promote bind when the clause names a unique matchAny member; otherwise explicit `scope:bind-clause --clause N --path <file_scope member>` before stamp. Empty `file_scope` is a silent no-op. ⊗ Lift a path from issue/comment text (`#3835`) |
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

## Sentence floor (#3550)

When `sentences` is present, the oracle walk fails closed unless each
sentence's text is a clause or listed in `confessions`. An existence clause
or a quoted-token clause that verifies does not cover a different sentence.
The list does not select a file. `behavioral_clause_count` and
`unmapped_sentence_count` are recorded on the verify outcome after that
decision. Absent `sentences` leaves the walk unchanged. Standalone, check,
and scope:complete share the walk.

## See also

- `task verify:ac` in [`../commands.md`](../commands.md)
- Clause bind: `packages/core/src/verify-ac/clauses.ts` (`bindClausesToDeclaredScope`); pathless explicit bind: `packages/core/src/scope/bind-clause.ts` (`scope:bind-clause`, `#4986`)
- Attestation: `packages/core/src/intake/clause-derivation.ts` (`evaluateAmbiguityAttestation`)
