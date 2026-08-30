# Deft Directive — OpenPackage skills

Tiered consumer skills for **Cursor**, **Codex CLI**, and **OpenCode**. This package is distribution-layer (A) only: OpenPackage places native skill files on disk; Directive's npm engine (`@deftai/directive`) still owns gates, lifecycle, and `.deft/core/` refresh. There is **no** runtime skill router and **no** skill enumeration in AGENTS.md.

## Tiers

| Tier | Purpose | Install when |
| --- | --- | --- |
| **daily-core** (default) | setup, sync, build, pre-pr, review-cycle, triage | Every session bootstrap (Cursor native skill injection) |
| **standard** | decompose, feedback, gh-slice, interview, … | On-demand operational workflows |
| **advanced** | release, swarm, debug, article-review | Maintainer / heavy workflows (deferred frontmatter) |

Full skill lists: [`../deft-tiers.json`](../deft-tiers.json).

**Acceptance (spike #2370):** daily-core Cursor `<agent_skill>` frontmatter totals **≤ 2080 B** when only the six daily-core skills are installed — measured at maintainer HEAD via `node packaging/openpackage/measure-daily-core-frontmatter.mjs`.

## Prerequisites

1. **Engine:** `npm i -g @deftai/directive` (Node ≥ 20) — same as the canonical Directive install.
2. **OpenPackage CLI:** `npm i -g opkg`
3. **Sync skills** from `content/skills/` (maintainer checkout or release prep):

   ```bash
   # Default: daily-core only (recommended consumer path)
   node packaging/openpackage/sync-skills.mjs

   # Maintainer / all tiers on disk before release
   node packaging/openpackage/sync-skills.mjs --tier all
   ```

## Install (project)

From your **project root** (after `directive init`):

```bash
# Default — daily-core tier only (lean Cursor frontmatter)
node /path/to/directive/packaging/openpackage/sync-skills.mjs
opkg install /path/to/directive/packaging/openpackage/deft-directive-skills \
  --platforms cursor codex opencode

# Explicit daily-core on Cursor only (same skill set as default sync)
opkg install /path/to/directive/packaging/openpackage/deft-directive-skills \
  --skills deft-directive-setup deft-directive-sync deft-directive-build \
            deft-directive-pre-pr deft-directive-review-cycle deft-directive-triage \
  --platforms cursor
```

Replace `/path/to/directive` with a clone path, or use a published registry snapshot when available.

### Expanding tiers

After the default daily-core install, add deferred workflows by syncing the broader tier and re-running `opkg install`:

```bash
# All tiers (standard + advanced on disk)
node /path/to/directive/packaging/openpackage/sync-skills.mjs --tier all
opkg install /path/to/directive/packaging/openpackage/deft-directive-skills \
  --platforms cursor codex opencode

# Standard tier only (operational workflows, no advanced)
node /path/to/directive/packaging/openpackage/sync-skills.mjs --tier standard
opkg install /path/to/directive/packaging/openpackage/deft-directive-skills \
  --platforms cursor
```

For DD-3 budget reporting aligned with daily-core, set `plan.policy.agentsMdBudget.skillFrontmatterTier` to `daily-core` or export `DEFT_AGENTS_MD_BUDGET_SKILL_TIER=daily-core` (see UPGRADING.md § Always-on bootstrap budget).

## Uninstall

```bash
opkg uninstall @deftai/deft-directive-skills
```

## AGENTS.md contract

Consumer AGENTS.md stays **pointer-thin** — run `npx deft packs:slice skills list` before improvising; do not enumerate skills in the managed section (#2371 / Q1).
