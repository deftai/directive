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

The pass **lead** carries the counts on the first line. When no clause verified
and no acceptance command ran green, it does not say "passed" (`#6374`):

```
verify:ac: no acceptance evidence yet (#3284) (0 verified, N unverifiable) [rung=derived]
```

With at least one verified clause, or a green acceptance command, the lead is
`verify:ac passed (#3284) (…)` as before. Either way exit 0 means no clause
failed, not that the requested work exists. `ok`, the exit code and the
resolution label are the same for both leads; rapid `check` (`#4866`) and
`scope:complete` (`#4870`) read both.

A `verified` row whose file is unchanged since the commit before a committed
brief entered its non-terminal folder carries the context note "file unchanged
since the commit before this brief entered this folder". The note changes no
outcome; whether such evidence should count is `#6408`.

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

## Quoted-token polarity (#6269)

A quoted literal in a bound clause must be present in the artifact, except in
these complete-sentence forms, where the walk checks exact literal absence:

- `Removes|Deletes|Drops|Recuts "X" from PATH` (singular or plural verb; PATH optional) — X absent.
- `PATH no longer contains "X"` — X absent.
- `Replaces "X" with "Y" in PATH` (PATH optional) — X absent, Y present.

PATH, bare or quoted, must be the bound artifact path exactly. A quoted
file-path literal can be the removed X. Matching is exact: case, inner
whitespace and inner quotes count.

Other removal wording around a quoted literal (negated, past tense, a second
verb, the same literal twice, `replaces` with no `with`, X equal to Y) is
adjudicable `unverifiable`. It keeps `ok` false and never verifies. The
detail names the forms above; rewrite the clause into one of them. Absence
proves only that the literal is gone, not that the surrounding text was kept.

### Negated literals (#7170)

When a clause has no removal wording, a quoted literal whose operator is a
negation is set aside: it is not checked, and it is never inverted into an
absence check. The negation is its operator when:

- the cue comes right before it, or one display verb sits between
  (`never 'X'`, `not 'X'`, `does not show 'X'`, `never contains 'X'`);
- it comes right after it as an optional auxiliary, `not` or `never`, an
  optional `be`/`been`, then a display verb (`'X' is never shown`,
  `'X' must not appear`);
- the literal is joined to an earlier set-aside literal only by a comma, `or`,
  `and` or `nor` (`never 'X' or 'Y'`).

Cues are `never`, `not`, `no`, `nor`, `cannot`, `without`, `instead of`,
`rather than` and a word ending in `n't`. Display verbs are show, display,
render, print, emit, log, return, contain, include, appear, output, say and
write, in their inflected forms. Any other word, punctuation, quoted span or
code span between ends the rule, so `not only 'X'`, `no change to 'X'`,
`without breaking 'X'`, `never omit 'X'` and `never fails to show 'X'` keep the
presence check. Two negations in a row (`cannot not show 'X'`,
`'X' doesn't not appear`) also keep it. So does a contracted auxiliary with no
`not` or `never` after the literal (`'X' isn't shown`).

The other literals keep the presence check. The row names the literals it
checked and each set-aside literal with its cue; a presence failure says that
no removal or negation cue governs the missing literal.

An absence phrase (`does not exist`, `must be absent`) is not an existence
claim, and neither is a clause whose only literals were set aside. Such a
clause walks as a behavioral claim (non-adjudicable `unverifiable`, #4240),
and the #3550 sentence count treats it as behavioral. Limit: a clause that
makes an existence claim about the bound file next to an unrelated absence
phrase loses that existence check.

Completion is unchanged. A clause left with no check is decided where it is
today: on `scope:complete`, a walk with no `verified` row still needs a green
executable run or the #7047 declared-test floor. A mixed clause whose checked
literal is present is `verified`, so `verified-pass` and the AC pass bank work
as before; that row covers only the checked literals.

## Admitted command forms (#6886)

One record rule covers `plan.acceptance.commands` and
`plan.metadata.literal_acceptance_commands`. `scope:activate`,
`xbrief:activate` and `verify:ac` read the same record list and print the same
reason text.

| First token | Admitted arguments |
| --- | --- |
| `task` | `check`, `doctor`, `test`, `verify:<name>`, `help`, `--version` (closed arguments may follow), and exactly `<name>:test` with nothing after it (`<name>` matches `[a-z0-9][a-z0-9_-]*`) |
| `deft`, `directive` | `check`, `doctor`, `test`, `verify:<name>`, `help`, `--version` (closed arguments may follow) |
| `npx` | `vitest run …`, `--version`, `--help` |
| `pnpm`, `npm`, `yarn`, `bun` | `test …`, `exec vitest run …`, `run vitest …`, `run <script> …`, `--version`; `<script>` is exactly `test`, `check`, `test:<name>` or `check:<name>` |
| `vitest` | `run …`, `--version` |
| `python`, `python3`, `py` | `-m pytest …` |
| `node` | `--test …` |

Shell metacharacters (including `%`) are refused in every form.
`task web:test web:deploy`, `task web:test --dir x`, `task a:b:test` and
`task web:deploy` are refused.

**Closed argument grammar.** Every argument after the admitted verb, on both
sides of `--`, is either a plain relative path (no `..`, no leading `/`, no
`:`, `=` or `\`) or an admitted flag:

- Test runner: `--run`, `--fail-fast`, `--changed`, `--coverage`,
  `--coverage.enabled=true|false`, `--reporter <built-in>`, `-t <test name>`.
- npm before `--`: `--prefix <relative dir>` (once), `-w` / `--workspace
  <package>`. pnpm: `--filter <package>`.
- `task` / `deft` / `directive`: verification flags such as `--json`,
  `--full`, `--enforce`, `--strict`, `--tier <word>`, `--base-ref <ref>`,
  `--issue <n>`. No positional before `--` (a second task or `VAR=value`);
  `task` flags before `--` attach their value with `=`.
- `python -m pytest`: `-q`, `-v`, `-x`, `-s`, `-k`, `-m`, `--tb`,
  `--maxfail`, `-n`, and `path::name` node ids.
- `node --test`: relative paths, with `*` globs, and exactly these flags:
  `--test-reporter <spec|tap|junit|lcov|dot>`, `--test-name-pattern`,
  `--test-skip-pattern`, `--test-only`, `--test-force-exit`,
  `--test-concurrency <n>`, `--test-timeout <n>`, `--test-shard <i>/<n>`,
  `--test-isolation <process|none>`, `--experimental-test-coverage`.

Other package-manager, runner and interpreter options are refused, and so is
`--if-present`. A quote must wrap a whole argument (or a whole `--flag=` value).

JS workspace example. Either record passes activation and `verify:ac`:

```json
{ "command": "npx vitest run src/app.test.ts", "cwd": "web" }
```

```json
{ "command": "task web:test" }
```

`pnpm exec vitest run <path>` with `cwd: web` is also admitted.

- **`cwd` grammar (warning).** A `cwd` conforms when it is absent, empty, `.`,
  or one or more segments joined by `/`, each matching
  `[A-Za-z0-9_][A-Za-z0-9._-]*`. Any other form (`..`, an absolute or rooted
  path, `C:x`, a UNC path, a backslash) prints the `acceptance-cwd-grammar`
  warning at activation and in `verify:ac`. It never refuses.
- **Run-time check (refusal).** Just before it runs any command, `verify:ac`
  resolves the real path of the project root and of the `cwd`. When the
  directory is missing or its real path is outside the project root (a symlink
  that leaves the root included), `verify:ac` exits 2 with `refused:` and
  spawns nothing (`acceptance-cwd-containment`, enforce). An absolute `cwd`
  inside the root runs there, with the grammar warning. An `npm --prefix`
  directory gets the same real-path check, resolved from the `cwd`.
- **Promotion.** A capture-only record (`source: task_statement`) runs only
  when an agent-promoted peer with the same command, `cwd` and expected exit
  exists. Read the command first and confirm it is an admitted form that runs
  only this repository's own tests; then record it in
  `plan.metadata.swarm.verify_commands`. Otherwise record the string in
  `plan.metadata.literal_acceptance_not_commands`.
- **Activation warns.** Activation prints one `acceptance-record-activate` or
  `acceptance-cwd-grammar` line per record that `verify:ac` would refuse before
  any run, per unpromoted capture and per `cwd` outside the grammar. It does
  not refuse on them. The existing refusal for a brief with acceptance-shaped
  narratives and an invalid `plan.acceptance` is unchanged.
  `deft verify:ac --capture-only` lists each record and its reason.

This rule is command-form admission and initial working-directory containment,
under the assumption that repository test code is trusted. It is not
isolation: a test runner still runs repository code with the inherited
environment. The closed argument grammar keeps the run on the repository's own
test scripts and paths; what those scripts do is the repository's trust.

## See also

- `task verify:ac` in [`../commands.md`](../commands.md)
- Clause bind: `packages/core/src/verify-ac/clauses.ts` (`bindClausesToDeclaredScope`); pathless explicit bind: `packages/core/src/scope/bind-clause.ts` (`scope:bind-clause`, `#4986`)
- Attestation: `packages/core/src/intake/clause-derivation.ts` (`evaluateAmbiguityAttestation`)
