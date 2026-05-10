# Change Lifecycle Commands

Workflows for scoped changes to an existing codebase — propose, implement, verify, archive.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [verification/verification.md](./verification/verification.md) | [resilience/continue-here.md](./resilience/continue-here.md) | [vbrief/vbrief.md](./vbrief/vbrief.md)

---

## Overview

Each change is a self-contained unit of work with its own folder in `history/changes/`. The lifecycle is:

```
/deft:change <name>  →  /deft:change:apply  →  /deft:change:verify  →  /deft:change:archive
        │                          │                          │                          │
   Create proposal          Implement tasks           Verify outcomes          Move to archive
```

---

## `/deft:change <name>`

Create a scoped change proposal.

### Process

- ! Create `history/changes/<name>/` with the artifacts below
- ! Read existing specs in the project (if any) to understand current state
- ~ Run `/deft:run:discuss` first if the change has gray areas
- ~ Run `/deft:run:research` first if the domain is unfamiliar

### Artifacts

```
history/changes/<name>/
├── proposal.vbrief.json ← Why/what/how (all narratives in vBRIEF format)
├── tasks.vbrief.json    ← Implementation tasks in vBRIEF format
└── specs/               ← Spec deltas (how requirements change)
    └── <capability>.delta.vbrief.json ← New or modified requirements
```

### proposal.vbrief.json

A vBRIEF v0.5 file with `plan.narratives` capturing both the proposal and the design:

- ! **Problem** — what's wrong or missing
- ! **Change** — what this proposal does about it
- ! **Scope** — what's in, what's explicitly out
- ~ **Impact** — what existing code/specs are affected
- ~ **Risks** — what could go wrong
- ! **Approach** — how to implement the change
- ~ **Alternatives** — what else was considered and why not
- ~ **Dependencies** — what must exist before this works

! All narrative values MUST be plain strings — never objects or arrays.

? The Approach, Alternatives, and Dependencies narratives may be omitted if the change is trivial (< 1 hour of work).

### tasks.vbrief.json

- ! Use vBRIEF format with `blocks` edges for dependencies
- ! Each task has `narrative` with acceptance criteria
- ~ Size tasks for 1–4 hours of work
- ! Status lifecycle: plan-level `draft` → `proposed` → `approved` → `completed`; task-level `pending` → `running` → `completed` / `blocked` / `cancelled`

Example:

```json
{
  "vBRIEFInfo": { "version": "0.5" },
  "plan": {
    "title": "add-dark-mode",
    "status": "draft",
    "items": [
      {
        "id": "t1",
        "title": "Add theme context provider",
        "status": "pending",
        "narrative": { "Action": "Create ThemeContext with light/dark state and toggle" }
      },
      {
        "id": "t2",
        "title": "Create toggle component",
        "status": "pending",
        "narrative": { "Action": "Toggle button wired to ThemeContext" }
      },
      {
        "id": "t3",
        "title": "Add CSS variables for themes",
        "status": "pending",
        "narrative": { "Action": "Define CSS custom properties for light and dark palettes" }
      }
    ],
    "edges": [
      { "from": "t1", "to": "t2", "type": "blocks" },
      { "from": "t1", "to": "t3", "type": "blocks" }
    ]
  }
}
```

### specs/

Spec deltas capture how requirements change as vBRIEF files. See [context/spec-deltas.md](./context/spec-deltas.md) for full format and vBRIEF chain pattern.

Each delta is a vBRIEF v0.5 file at `specs/<capability>.delta.vbrief.json` with `plan.narratives`:

- ! **Baseline** — reference to which spec/section is being modified
- ! **NewRequirements** — new FR/NFR entries being added
- ! **ModifiedRequirements** — changes in "was: X / now: Y" format
- ~ **RemovedRequirements** — any requirements being removed

- ? Create spec delta files only when the change modifies requirements
- ! Each delta captures the **new or changed** requirements, not the full system
- ! All narrative values MUST be plain strings — never objects or arrays
- ~ Organize by capability: `specs/auth-session.delta.vbrief.json`, `specs/checkout-cart.delta.vbrief.json`
- ~ Use RFC 2119 language (MUST, SHOULD, MAY) within narrative values
- ~ Use GIVEN/WHEN/THEN scenarios for behavioral requirements within narrative values
- ~ Link to baseline spec via vBRIEF `references` in `tasks.vbrief.json`
- ⊗ Rewrite the full spec — only capture the delta
- ⊗ Use markdown spec files (`spec.md`) — all spec deltas must be vBRIEF format

---

## `/deft:change:apply`

Implement the active change's tasks.

### Process

- ! Read `tasks.vbrief.json` from the active change folder
- ! Confirm the plan status is `approved` (or prompt user to approve)
- ! Follow task ordering from `blocks` edges
- ! Update task statuses as work progresses
- ! Follow TDD: write tests before implementation
- ~ Reference `proposal.vbrief.json` `Approach` narrative for architectural decisions
- ~ Reference `specs/` for requirement details

### Active Change Detection

- ! Look for a single change in `history/changes/` with `status: approved`
- ~ If multiple changes exist, ask the user which one to apply
- ⊗ Apply a change that hasn't been reviewed

---

## `/deft:change:verify`

Verify the active change against its acceptance criteria.

### Process

- ! Read acceptance criteria from `tasks.vbrief.json` task narratives
- ! Apply the verification ladder from [verification/verification.md](./verification/verification.md)
- ! Check for stubs (TODO, FIXME, return null, pass)
- ! Verify all spec requirements in `specs/` are satisfied
- ~ Run `task check` as a baseline
- ! Record verification tier reached per task in `tasks.vbrief.json` metadata

---

## `/deft:change:archive`

Archive a completed change.

### Process

- ! Verify all tasks in `tasks.vbrief.json` have a terminal status (`completed`, `blocked`, or `cancelled`)
- ~ If any tasks are `blocked` or `cancelled`, confirm with the user that archiving is intentional
- ! Update `tasks.vbrief.json` plan status to `completed`
- ! Move `history/changes/<name>/` to `history/archive/<date>-<name>/`
- ! Date format: `YYYY-MM-DD` (e.g., `history/archive/2026-03-10-add-dark-mode/`)

### Spec Delta Merge

If the change included spec deltas (`specs/`), merge them into the relevant scope vBRIEF(s) before archiving. See [context/spec-deltas.md](./context/spec-deltas.md) § After Archiving.

- ! Read each `*.delta.vbrief.json` file in the change's `specs/` directory
- ! Read the delta's `Baseline` narrative to identify the target scope vBRIEF
- ! Apply `NewRequirements` narrative content to the corresponding scope vBRIEF in `./vbrief/` (or `specification.vbrief.json` for project-wide changes)
- ! Apply `ModifiedRequirements` narrative — replace the **was** with the **now** in the scope vBRIEF
- ! Apply `RemovedRequirements` narrative — remove the identified requirements from the scope vBRIEF
- ! Verify the scope vBRIEF is internally consistent after merge
- ~ Use `task spec:render` to regenerate rendered output from the vBRIEF source if applicable
- ⊗ Leave spec deltas unmerged — the scope vBRIEF drifts from reality
- ⊗ Parse markdown to extract delta content — read vBRIEF narratives directly

### CHANGELOG Entry

- ~ Add a CHANGELOG.md entry summarizing the change
- ~ Use the change's `proposal.vbrief.json` Problem/Change narratives as the source
- ~ Follow the existing CHANGELOG format ([Keep a Changelog](https://keepachangelog.com/en/1.0.0/))
- ? Link to the archived change folder for full context

### What Gets Archived

The entire change folder moves as-is. The archive is a historical record — never modify archived changes.

- ⊗ Delete archived changes
- ⊗ Modify files in `history/archive/`
- ? Prune old archives periodically if disk space is a concern

---

## Command Lifecycle: `run` vs `task`

Deft uses two complementary command surfaces that together cover the full document lifecycle:

### `run` commands — Interactive creation

`run` commands handle conversational, agent-friendly creation workflows:

- `.deft/core/run bootstrap` — Interactive setup for USER.md and PROJECT-DEFINITION.vbrief.json
- `.deft/core/run spec` — AI-assisted specification interview (produces scope vBRIEFs)
- `.deft/core/run validate` — Check deft configuration
- `.deft/core/run doctor` — Check system dependencies
- `.deft/core/run reset` — Reset config files

These are the entry points for humans and agents starting new work.

### `task` commands — Scripted rendering, migration, and validation

`task` commands handle deterministic, CI-friendly operations:

- `task spec:render` — Regenerate `SPECIFICATION.md` from `specification.vbrief.json`
- `task spec:pipeline` — Full spec validation and rendering pipeline
- `task roadmap:render` — Regenerate `ROADMAP.md` from `vbrief/pending/` scope vBRIEFs
- `task roadmap:check` — Detect drift between ROADMAP.md and pending/ contents
- `task project:render` — Regenerate `PROJECT-DEFINITION.vbrief.json` items registry from lifecycle folders
- `task migrate:vbrief` — One-time migration from pre-v0.20 model to vBRIEF lifecycle folders
- `task vbrief:validate` — Validate vBRIEF schema, filenames, folder/status consistency (runs as part of `task check`)
These transform

### Why the split?

The split is intentional: `run` commands are conversational and agent-friendly (they prompt for input, adapt to context); `task` commands are deterministic and scriptable (same input always produces the same output). For the full document lifecycle:

1. **Create** with `run` — bootstrap, interview, generate spec
2. **Render** with `task` — produce markdown artifacts from vBRIEF sources
3. **Validate** with `task` — enforce schema, naming, and consistency rules
4. **Migrate** with `task` — one-time structural upgrades

See also: [README.md — Document Generation & vBRIEF Tooling](./README.md#-document-generation--vbrief-tooling) | [vbrief/vbrief.md](./vbrief/vbrief.md)

---

## Backlog triage & cache tasks

User-facing surface for the **Phase 0 triage workflow** (refinement skill) and the **unified content cache** (#883). Use these to walk an existing backlog locally without draining the shared GitHub GraphQL bucket. End-to-end walkthrough lives in [`docs/getting-started.md` § Working an existing backlog](./docs/getting-started.md#working-an-existing-backlog); the canonical agent-facing description is in `skills/deft-directive-refinement/SKILL.md` Phase 0.

### Triage tasks

- `task triage:bootstrap -- [--repo OWNER/NAME] [--limit N] [--state {open|closed|all}] [--batch-size N] [--delay-ms N]` — **Seed the local triage cache for the first time.** Runs `cache:fetch-all` for the configured source, backfills the audit log from existing lifecycle folders, and ensures `.deft-cache/` and `vbrief/.eval/` are gitignored. Idempotent; re-runs skip fresh cache entries.
- `task triage:accept -- <issue>` — **Accept a candidate.** Appends an `accept` record to `vbrief/.eval/candidates.jsonl` and delegates to `task issue:ingest` so a scope vBRIEF lands in `vbrief/proposed/` with the canonical slug + references shape. Idempotent on re-accept.
- `task triage:reject -- <issue> [--reason "why"]` — **Reject a candidate.** Appends a `reject` audit-log record, closes the upstream GitHub issue with the reason, and applies the `triage-rejected` label. Audit entry rolls back if the upstream close fails.
- `task triage:defer -- <issue>` — **Defer a candidate (non-terminal).** Records a `defer` audit-log entry; the candidate resurfaces on the next Phase 0 pass.
- `task triage:needs-ac -- <issue>` — **Flag a candidate as missing acceptance criteria (non-terminal).** Records a `needs-ac` audit-log entry and posts a comment on the upstream issue requesting AC.
- `task triage:mark-duplicate -- <issue> <of-issue>` — **Mark a candidate as a duplicate (terminal).** Cross-links the duplicate target via the audit log and the upstream issue.
- `task triage:bulk-accept|bulk-reject|bulk-defer|bulk-needs-ac -- [--label L] [--author A] [--age-days N] [--cluster K]` — **Bulk verbs for predictable patterns.** Combinable AND-semantics filters loop through the matching cached candidates and dispatch the per-issue action through the same audit-log path. Zero-match exits clean.
- `task triage:refresh-active` — **Pre-swarm freshness gate.** Walks `vbrief/active/*.vbrief.json`, compares each cached `meta.json.fetched_at` against the live REST `updated_at` for the issue (`gh api repos/<owner>/<repo>/issues/<N>` -- preferred over `gh issue view --json` per the REST-over-GraphQL rule, see `AGENTS.md` § Multi-agent orchestration discipline), and surfaces drift via a three-way prompt (proceed-with-stale / refresh-and-update-local / defer-from-this-batch). Run before dispatching a swarm.
- `task triage:status -- <issue>` — Show the latest decision for a single issue.
- `task triage:history -- <issue>` — Show the full decision history for a single issue (reset chains included).
- `task triage:reset -- <issue>` — Append a `reset` record so a prior decision can be revisited; history is never deleted.

### Cache tasks

- `task cache:fetch-all -- --source=github-issue --repo OWNER/NAME [--limit N] [--state {open|closed|all}] [--batch-size N] [--delay-ms N]` — **Populate or refresh the unified content cache.** Idempotent (fresh entries within TTL are skipped). Batched delays plus automatic 429 retries via the upstream `Retry-After` header keep the populate inside the REST budget. Layout: `.deft-cache/<source>/<owner>/<repo>/<N>/{raw.json, content.md, meta.json}`.
- `task cache:get -- <source> <key>` — **Read a single cache entry.** Validates `meta.json` against the frozen `vbrief/schemas/cache-meta.schema.json` schema and returns the cached content. Marks `stale` when the entry is past its TTL but does not auto-refresh.
- `task cache:invalidate -- <source> <key>` — **Delete one cache entry and append an audit record.** Idempotent.
- `task cache:prune -- [--source S] [--older-than-days N] [--dry-run] [--to-cap]` — **Drop expired entries, run LRU eviction to cap, or preview either.** Honors `DEFT_CACHE_MAX_BYTES` / `DEFT_CACHE_MAX_ENTRIES` quotas (defaults 100 MB / 10 000 entries; `0` disables either).

For the surrounding workflow — trigger words, three-tier inventory model (cache → audit log → accepted backlog), the deterministic numbered action menu, and the rationale behind the scoped flags — see [`docs/getting-started.md` § Working an existing backlog](./docs/getting-started.md#working-an-existing-backlog).

---

## Anti-Patterns

- ⊗ Creating a change without a proposal (jumping straight to code)
- ⊗ Applying a change that hasn't been reviewed/approved
- ⊗ Modifying archived changes
- ⊗ Having multiple active changes without explicit user coordination
- ⊗ Skipping verification before archiving
