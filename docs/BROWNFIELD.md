# Adding Deft to an Existing Project (Brownfield Adoption)

Adding Deft to an existing codebase is the harder path and the one most likely to go wrong without guidance. This guide walks you through the steps, what changes, and how to preserve existing spec content.

**Greenfield users:** If you are starting a new project from scratch, follow the [Getting Started](../README.md#-getting-started) flow in the README instead. This guide is only for projects that already have code, docs, or a pre-v0.20 Deft layout.

> **See also:** [README.md](../README.md), [QUICK-START.md](../QUICK-START.md), [vbrief/vbrief.md](../vbrief/vbrief.md), and `UPGRADING.md` at the repo root (added in v0.20 -- issue #411).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

---

## 1. Install Deft in Your Project

You have three ways to add the `deft/` framework to an existing project. Pick the one that fits your workflow:

### Option A: Git submodule (recommended)

```bash
git submodule add https://github.com/deftai/directive.git deft
git submodule update --init --recursive
```

- ~ Pin to a release tag so framework updates are explicit:
  ```bash
  cd deft && git checkout v0.20.0 && cd ..
  git add deft && git commit -m "chore(deft): pin framework to v0.20.0"
  ```
- ~ Update later with `cd deft && git fetch && git checkout <new-tag>`.
- ! Commit the submodule pointer after every version bump so teammates do not drift.

### Option B: Installer binary

If you downloaded the Deft installer (see [GitHub Releases](https://github.com/deftai/directive/releases)), run it against your existing project directory:

```bash
./install-<platform>-<arch>
```

- The installer clones `deft/` into the project root, wires it into `AGENTS.md` (append-mode if the file already exists), and creates your user config directory.
- Your existing `AGENTS.md` content is preserved; Deft entries are appended with two blank lines before them.

### Option C: Direct clone (no installer, no submodule)

```bash
git clone https://github.com/deftai/directive.git deft
```

- ~ Fine for experimentation; use submodule or installer for anything durable.
- ! Tell your agent: "Read `deft/QUICK-START.md` and follow it." QUICK-START creates your `AGENTS.md` idempotently.

---

## 2. Migrate Existing Docs (`task migrate:vbrief`)

If your project already contains `SPECIFICATION.md`, `PROJECT.md`, or `ROADMAP.md`, run the one-shot migration:

```bash
task migrate:vbrief
```

The migration is **idempotent** -- safe to re-run on a partially-migrated project.

### What migration does

1. **Parses** existing `specification.vbrief.json` (if present) + `PROJECT.md` and generates `vbrief/PROJECT-DEFINITION.vbrief.json` with a `narratives` map (project identity) and an `items` registry (scope).
2. **Creates** the five lifecycle folders: `vbrief/proposed/`, `vbrief/pending/`, `vbrief/active/`, `vbrief/completed/`, `vbrief/cancelled/`.
3. **Converts** `ROADMAP.md` items into individual `pending/` scope vBRIEFs with origin provenance (`references` array pointing back to GitHub issue numbers, if available).
4. **Replaces** `SPECIFICATION.md` and `PROJECT.md` with deprecation redirect stubs containing `<!-- deft:deprecated-redirect -->` -- the sentinel that tells future `task vbrief:validate` runs these files are no longer authoritative.
5. **Preserves** user-customized content it cannot parse: anything non-standard in `PROJECT.md` is stored in a `ProjectConfig` narrative on `PROJECT-DEFINITION.vbrief.json` instead of being discarded.

### Preserving existing spec content (#397 ingestion)

`task migrate:vbrief` also reads structured `## ` sections from `PRD.md` and `SPECIFICATION.md` (Problem Statement, Goals, User Stories, Requirements, Success Metrics, Non-Functional Requirements, Open Questions) and maps them to canonical narrative keys on `vbrief/specification.vbrief.json`. Existing keys are never overwritten.

- ~ Review the generated `vbrief/specification.vbrief.json` after migration; fill in any narrative the parser could not map.
- ~ If the parser missed content you care about, copy it into the appropriate narrative before deleting the old file backup.

---

## 3. What Changes After Migration

### Source of truth: `.vbrief.json` files

- `vbrief/PROJECT-DEFINITION.vbrief.json` replaces `PROJECT.md` as the project identity gestalt (tech stack, strategy, coverage, architecture, branching convention).
- `vbrief/specification.vbrief.json` replaces `SPECIFICATION.md` as the project spec source of truth.
- Individual units of work live in `vbrief/{proposed,pending,active,completed,cancelled}/` as `YYYY-MM-DD-<slug>.vbrief.json`.

### Rendered views: `.md` artifacts

`.md` files like `PRD.md`, `SPECIFICATION.md`, and `ROADMAP.md` become **rendered views**, generated on demand:

```bash
task spec:render         # vbrief/specification.vbrief.json -> SPECIFICATION.md
task prd:render          # vbrief/specification.vbrief.json narratives -> PRD.md
task roadmap:render      # vbrief/pending/ scope vBRIEFs -> ROADMAP.md
task project:render      # lifecycle folders -> PROJECT-DEFINITION.vbrief.json items registry
```

- ⊗ Edit the rendered `.md` files directly -- your changes are overwritten on the next `task *:render` run.
- ! Edit the underlying `.vbrief.json` instead, then run `task *:render` to refresh the export.
- ~ `task spec:render` and `task prd:render` are also invoked automatically by `skills/deft-directive-pre-pr/SKILL.md` Phase 3b if the export files already exist.

### Deprecation sentinels

After migration, the root `SPECIFICATION.md` and `PROJECT.md` contain a redirect stub with a sentinel comment on its first line followed by a short pointer. The exact output is produced by `_deprecation_redirect()` in `scripts/migrate_vbrief.py`; the first line is always `<!-- deft:deprecated-redirect -->`, which is the only line `scripts/vbrief_validate.py` checks. A simplified representation:

```markdown
<!-- deft:deprecated-redirect -->
# PROJECT.md -- DEPRECATED

This file has been migrated to `vbrief/PROJECT-DEFINITION.vbrief.json`.

**See instead:**
- `vbrief/PROJECT-DEFINITION.vbrief.json` (project identity)
- scope vBRIEFs in `vbrief/{proposed,pending,active,completed,cancelled}/`
```

(The actual generated body may include additional context; the sentinel comment on line 1 is what the validator enforces.)

`scripts/vbrief_validate.py` warns if these files exist without the sentinel; `skills/deft-directive-build/SKILL.md` Pre-Cutover Detection Guard redirects to `task migrate:vbrief` if it detects pre-v0.20 state on first setup.

---

## 4. Pre-Cutover Detection Guard

On first interactive session after adding Deft, the agent-driven path runs a **pre-cutover detection guard** from `skills/deft-directive-setup/SKILL.md` and `skills/deft-directive-build/SKILL.md`. The guard detects legacy artifacts and redirects to the migration command instead of silently proceeding with a mismatched project layout.

**Detection criteria** (any one triggers the guard):

1. `SPECIFICATION.md` exists and does **not** contain `<!-- deft:deprecated-redirect -->`.
2. `PROJECT.md` exists and does **not** contain `<!-- deft:deprecated-redirect -->`.
3. `vbrief/specification.vbrief.json` exists but the lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`) do **not**.

**Action on detection:** the agent stops with an actionable message such as "Run `task migrate:vbrief` to upgrade to the vBRIEF-centric model."

### CLI path (`deft/run`)

The CLI has a companion non-fatal upgrade gate (issue #410): `deft/run` warns on every invocation when `vbrief/.deft-version` does not match the framework `VERSION`, or when legacy artifacts are found without the sentinel. Interactive sessions get a `Continue anyway? [y/N]` prompt; non-interactive sessions (CI, cloud agents) warn once and continue so CI is never blocked.

After completing migration, record the framework version so the CLI gate stays silent:

```bash
deft/run upgrade         # writes vbrief/.deft-version = <current VERSION>
```

---

## 5. Post-Migration Checklist

Run these in order once `task migrate:vbrief` completes:

1. ! `task vbrief:validate` -- should report zero errors and zero warnings about `SPECIFICATION.md` / `PROJECT.md`. Deprecation-sentinel warnings from `scripts/vbrief_validate.py` fire when the sentinel is **missing** from those files -- if you see them, the redirect stubs were not written correctly and the migration is incomplete; re-run `task migrate:vbrief` or patch the stubs to include the `<!-- deft:deprecated-redirect -->` line.
2. ! `task check` -- the full pre-commit pipeline (fmt + lint + typecheck + tests + coverage + vbrief validation + link check). Must be green before your first Deft-aware commit.
3. ~ `task project:render` -- regenerate `vbrief/PROJECT-DEFINITION.vbrief.json` items registry to reflect the newly-migrated scopes.
4. ~ `task roadmap:render` and `task spec:render` -- refresh the rendered views so teammates browsing the repo see current content.
5. ~ Review the generated `vbrief/proposed/` and `vbrief/pending/` scope vBRIEFs; promote / activate / cancel them as appropriate via `task scope:promote|activate|complete|cancel|restore|block|unblock`.
6. ~ Commit the migration in a focused PR with a conventional-commit subject such as `chore(deft): migrate to vBRIEF-centric document model (v0.20)`.

---

## 6. Troubleshooting

- **`task vbrief:validate` fails on my scope vBRIEFs:** filename must follow `YYYY-MM-DD-<lowercase-slug>.vbrief.json` (D7); folder must match `plan.status` (D2); PROJECT-DEFINITION must have `overview` and `tech stack` narrative keys after `.lower()` (D3).
- **`task migrate:vbrief` did not migrate my roadmap:** the migration parser recognises task-based (`- \`X.Y.Z\` Title`) and plain (`- Title`) list item formats under `## ` headings. Custom formats fall through to synthetic IDs -- review the generated vBRIEFs and rename / reshape as needed.
- **My agent hits a missing `deft/skills/deft-*/` path:** that is a stale v0.19 `AGENTS.md` from before the `deft-directive-*` rename. Tell your agent "Read `deft/QUICK-START.md` and follow it" -- QUICK-START refreshes the Deft-managed section of `AGENTS.md` idempotently. See `UPGRADING.md` (present in repositories on v0.20 or later) for the detailed upgrade flow.
- **I edited `SPECIFICATION.md` by accident:** revert the file to the redirect stub (`<!-- deft:deprecated-redirect -->` + the three-line note), then edit `vbrief/specification.vbrief.json` and run `task spec:render`.

---

## 7. Related Reading

- [README.md](../README.md) -- product overview and greenfield flow.
- [QUICK-START.md](../QUICK-START.md) -- agent bootstrap (also handles the brownfield AGENTS.md append case).
- [vbrief/vbrief.md](../vbrief/vbrief.md) -- canonical vBRIEF file taxonomy, lifecycle folders, and status mapping.
- [commands.md](../commands.md) -- full `run` vs `task` command lifecycle.
- `skills/deft-directive-build/SKILL.md` -- Pre-Cutover Detection Guard implementation.
- `skills/deft-directive-setup/SKILL.md` -- greenfield path for comparison.
- `UPGRADING.md` (repo root, v0.20+) -- version-by-version upgrade guide.
