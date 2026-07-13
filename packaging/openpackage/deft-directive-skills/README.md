# Deft Directive — OpenPackage skills

Tiered consumer skills for **Cursor**, **Codex CLI**, and **OpenCode**. This package is distribution-layer (A) only: OpenPackage places native skill files on disk; Directive's npm engine (`@deftai/directive`) still owns gates, lifecycle, and `.deft/core/` refresh. There is **no** runtime skill router and **no** skill enumeration in AGENTS.md.

## Tiers

| Tier | Purpose | Install when |
| --- | --- | --- |
| **daily-core** | setup, sync, build, pre-pr, review-cycle, triage | Every session bootstrap (Cursor native skill injection) |
| **standard** | decompose, feedback, gh-slice, interview, … | On-demand operational workflows |
| **advanced** | release, swarm, debug, article-review | Maintainer / heavy workflows (deferred frontmatter) |

Full skill lists: [`../deft-tiers.json`](../deft-tiers.json).

**Acceptance (spike #2370):** daily-core Cursor `<agent_skill>` frontmatter totals **≤ 2080 B** when only the six daily-core skills are installed — measured at maintainer HEAD via `node packaging/openpackage/measure-daily-core-frontmatter.mjs`.

## Prerequisites

1. **Engine:** `npm i -g @deftai/directive` (Node ≥ 20) — same as the canonical Directive install.
2. **OpenPackage CLI:** `npm i -g opkg`
3. **Sync skills** from `content/skills/` (maintainer checkout or release prep):

   ```bash
   node packaging/openpackage/sync-skills.mjs
   ```

## Install (project)

From your **project root** (after `directive init`):

```bash
# All tiers, Cursor + Codex CLI + OpenCode
opkg install /path/to/directive/packaging/openpackage/deft-directive-skills \
  --platforms cursor codex opencode

# Daily-core only (recommended first pass on Cursor)
opkg install /path/to/directive/packaging/openpackage/deft-directive-skills \
  --skills deft-directive-setup deft-directive-sync deft-directive-build \
            deft-directive-pre-pr deft-directive-review-cycle deft-directive-triage \
  --platforms cursor
```

Replace `/path/to/directive` with a clone path, or use a published registry snapshot when available.

## Uninstall

```bash
opkg uninstall @deftai/deft-directive-skills
```

## AGENTS.md contract

Consumer AGENTS.md stays **pointer-thin** — scan `.deft/core/REFERENCES.md` Skills Index before improvising; do not enumerate skills in the managed section (#2371 / Q1).
