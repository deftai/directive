/**
 * non-product-dirs.ts — one source of truth for the "not product source"
 * directory basenames shared by every Directive filesystem walk (#3487).
 *
 * Directive shipped four independently hand-maintained exclusion sets:
 *
 *   - `EXCLUDE_DIRS`     — `verify-source/verify-stubs.ts`
 *   - `EXCLUDE_DIRS`     — `validate-content/validate-links.ts`
 *   - `SKIP_DIRS`        — `codebase/default-extractor.ts`
 *   - `DEFAULT_EXCLUDES` — `release/build-dist.ts`
 *
 * They drifted from each other, which is exactly how #2953 added
 * `.deft-scratch` / `swarm-worktrees` to some walks and missed the
 * `verify-stubs` walk (#3481), and how none of them ever learned about agent
 * working directories even though Directive ships first-class support for
 * several agent hosts. Because `@deftai/directive-core` is published, a
 * consumer cannot patch any of the four.
 *
 * `NON_PRODUCT_DIRS` is the common core each walk now extends. It carries only
 * basenames that are never product source in any repo: VCS metadata,
 * dependency trees, build output, tool caches, and agent working directories.
 * Walk-specific entries (`tests`, `specs`, `.planning`, `htmlcov`, …) stay with
 * the walk that needs them — this constant is a floor, not a ceiling.
 *
 * Adding a directory here is a one-line change all four walks pick up, and
 * `non-product-dirs.test.ts` fails if any of them stops agreeing.
 *
 * Refs #3487, #3481, #2953, #2954, #1656.
 */

/**
 * Swarm / agent scratch worktree roots (#2953, #1656).
 *
 * `.deft-scratch` is the current layout (`.deft-scratch/worktrees/<story-id>`,
 * built by `swarm/launch.ts`); `swarm-worktrees` is the pre-`.deft-scratch`
 * name, kept for repos that still carry one.
 */
export const AGENT_SCRATCH_DIRS: readonly string[] = [".deft-scratch", "swarm-worktrees"] as const;

/**
 * Agent-host directories that hold host *working* state rather than product
 * source (#3487).
 *
 * Only names with evidence of a real working directory belong here. Directive
 * knows several host directories (`.claude`, `.cursor`, `.grok`, `.codex`,
 * `.github/skills`, `.agents`), but most of them hold nothing except
 * Directive's own committed deposits — `commands.md` § Native multi-host
 * registration (LockedDecision L8) says to *commit* those, so blanket-excluding
 * them would hide committed team surface for no measured gain.
 *
 * `.claude` is different in kind: the Claude Code host keeps live session state
 * in the same directory it keeps config — `settings.local.json`, and agent
 * worktrees under `.claude/worktrees/<agent-id>`, each a full nested checkout.
 * Three such worktrees added ~11,000 walkable entries to this repo
 * (9,128 → 20,393) that no Directive walk skipped. Its Directive-managed
 * contents (`.claude/settings.json`, `.claude/commands/*.md`,
 * `.claude/skills/`) are deposits generated from `content/`, which every walk
 * still visits at the authoring source.
 *
 * Deliberately **not** listed:
 *   - `.openclaw` — there is no project-level `.openclaw/`; the host state dir
 *     is `~/.openclaw` in `$HOME` (see `doctor/openclaw-skills.ts`), and
 *     inventing a project one is explicitly forbidden by
 *     `content/docs/openclaw-agent-host.md` and asserted against in
 *     `slash/openclaw-adapter.test.ts`.
 *   - `.cursor`, `.grok`, `.codex`, `.github` — committed Directive deposits
 *     (`.cursor/hooks.json`, `.grok/commands/`, `.codex/prompts/`,
 *     `.github/skills/`) with no known working/worktree subtree. No evidence
 *     of a scratch convention was found for any of them.
 */
export const AGENT_HOST_WORKING_DIRS: readonly string[] = [".claude"] as const;

/**
 * Directory basenames no Directive walk should descend into.
 *
 * Every walk extends this set; none may shrink it. Keep entries to basenames
 * that cannot be product source in any repo — a name that is merely *usually*
 * uninteresting to one gate (`tests`, `scripts`, `specs`) belongs to that
 * walk's own set, not here.
 */
export const NON_PRODUCT_DIRS: ReadonlySet<string> = new Set<string>([
  // Version-control metadata.
  ".git",
  // Dependency trees and language virtualenvs.
  "node_modules",
  ".venv",
  // Build output and operator backups.
  "dist",
  "backup",
  // Tool caches.
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  // Agent working directories.
  ...AGENT_SCRATCH_DIRS,
  ...AGENT_HOST_WORKING_DIRS,
]);
