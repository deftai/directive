# Deft Glossary

Canonical vocabulary for Deft v0.20+. When a Deft doc, skill, strategy, or tool uses one of the terms below, it means exactly what this file says -- nothing more and nothing less.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**See also**: [vbrief/vbrief.md](./vbrief/vbrief.md) | [UPGRADING.md](./UPGRADING.md) | [strategies/speckit.md](./strategies/speckit.md) | [core/glossary.md](./core/glossary.md)

---

## Terms

- **Scope vBRIEF** -- A durable unit-of-work record, one per feature / bug / initiative, stored as `YYYY-MM-DD-slug.vbrief.json` inside a [lifecycle folder](#terms). Scope vBRIEFs are the primary work artifact in v0.20 (see [vbrief/vbrief.md -- Scope vBRIEFs and Lifecycle Folders](./vbrief/vbrief.md#scope-vbriefs-and-lifecycle-folders)).

- **Lifecycle folder** -- One of the five subdirectories under `vbrief/`: `proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`. Folder location reflects (but does not define) `plan.status`; see [vbrief/vbrief.md -- Directory Structure](./vbrief/vbrief.md#directory-structure) and [Status-Driven Moves](./vbrief/vbrief.md#status-driven-moves).

- **Plan-level narrative** -- A key under `plan.narratives` in a vBRIEF file, describing the scope/plan as a whole (e.g. `Description`, `Acceptance`, `Traces`). Plan-level narratives describe the *what and why*; see [vbrief/vbrief.md -- Narratives](./vbrief/vbrief.md#narratives).

- **Item-level narrative** -- A narrative string under `plan.items[].narrative` describing a single `PlanItem` (a task / subtask within a scope). Both plan-level and item-level narratives MUST be plain strings -- never objects (see [vbrief/vbrief.md -- Narratives](./vbrief/vbrief.md#narratives)).

- **Filename stem** -- The portion of a vBRIEF filename before `.vbrief.json`. For scope vBRIEFs the stem follows `YYYY-MM-DD-<slug>`; for speckit Phase 4 emissions the stem is `YYYY-MM-DD-ip<NNN>-<slug>` with `NNN` zero-padded to 3 digits (see [vbrief/vbrief.md -- Filename Convention](./vbrief/vbrief.md#filename-convention)).

- **Cross-scope dependency** -- A dependency between two scope vBRIEFs (rather than between items inside a single scope). Cross-scope dependencies live at `plan.metadata.dependencies` as an array of dependency IDs -- plan-level by design (see [vbrief/vbrief.md -- Plan-level metadata](./vbrief/vbrief.md#plan-level-metadata)).

- **Exit Commands** -- The seven deterministic `task scope:*` commands that transition a scope vBRIEF between lifecycle folders: `scope:promote`, `scope:activate`, `scope:complete`, `scope:cancel`, `scope:restore`, `scope:block`, `scope:unblock` (see [tasks/scope.yml](./tasks/scope.yml)). Agents MUST use these instead of moving files by hand.

- **Origin provenance** -- A `references` entry on a scope vBRIEF linking back to the issue / ticket / user-request that spawned it (`type: github-issue`, `jira-ticket`, or `user-request`). Required for ingestion dedup; see [vbrief/vbrief.md -- Origin Provenance](./vbrief/vbrief.md#origin-provenance).

- **Canonical narrative key** -- One of the small set of reserved plan-level narrative keys (`Description`, `Acceptance`, `Traces`) that tooling (`task roadmap:render`, swarm allocator) reads by name. See [vbrief/vbrief.md -- Scope vBRIEF narrative keys](./vbrief/vbrief.md#scope-vbrief-narrative-keys).

- **Preparatory strategy** -- A [strategies/](./strategies/) workflow that gathers context without producing a spec directly (e.g. `research.md`, `discuss.md`, `map.md`, `bdd.md`). Preparatory strategies chain into a [spec-generating strategy](#terms).

- **Spec-generating strategy** -- A [strategies/](./strategies/) workflow that emits `vbrief/specification.vbrief.json` (and optionally scope vBRIEFs) as its authoritative output (e.g. `interview.md`, `speckit.md`, `enterprise.md`, `rapid.md`, `yolo.md`).

- **Rendered export** -- A human-readable `.md` file (`SPECIFICATION.md`, `PRD.md`, `ROADMAP.md`) generated on demand by a `task *:render` command from the underlying `.vbrief.json` file. Rendered exports are read-only views; direct edits are overwritten on the next render (see [UPGRADING.md -- What to expect](./UPGRADING.md#what-to-expect)).

- **Source of truth** -- The file that tooling treats as authoritative for a given piece of information. In v0.20 the `.vbrief.json` files are the source of truth; the corresponding `.md` files are [rendered exports](#terms). Editing a rendered export does not change the source of truth -- edit the `.vbrief.json` instead.

- **Deterministic mode** -- The interaction shape used by every Deft skill that asks the user structured questions (via `ask_user_question` single-select / multi-select) or numbered-menu prompts in skill prose. Every deterministic-mode prompt MUST include `Discuss` and `Back` as the final two numbered options (#767). The canonical rule and verbatim Discuss-pause semantic live at [`contracts/deterministic-questions.md`](./contracts/deterministic-questions.md); skill prose `!` cross-references that contract instead of duplicating the rule body.

- **Branch-protection policy** -- The Deft policy surface that controls whether direct commits to the default branch (master/main) are allowed. The typed flag is `plan.policy.allowDirectCommitsToMaster` on `vbrief/PROJECT-DEFINITION.vbrief.json` (#746); default `false` (enforce feature branches). Three enforcement surfaces back the policy: skill-level guards at the entry of `deft-directive-{swarm,review-cycle,pre-pr,release}` (#746 part C), the detection-bound `scripts/preflight_branch.py` reachable via `task verify:branch` and the `.githooks/pre-commit` + `.githooks/pre-push` hooks (#747), and the CI `branch-gate` workflow asserting `head_ref != base_ref` (#747 part E). Reconfigure via `task policy:show` / `task policy:enforce-branches` / `task policy:allow-direct-commits -- --confirm`. Emergency bypass: `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1`.

- **Policy audit log** -- One-line append-only ledger at `meta/policy-changes.log` recording every transition of `plan.policy.allowDirectCommitsToMaster`. Written by `scripts/policy_set.py` whenever `task policy:enforce-branches` or `task policy:allow-direct-commits -- --confirm` is invoked, including the actor, previous value, and any operator-supplied `--note`. Surface introduced by #746 acceptance criterion G2.
