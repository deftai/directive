# Upgrading Deft

Version-by-version upgrade guide. Newest versions are at the top.

> **Agents:** ! If you are reading this because a user updated the framework, have them start a **new agent session** after you finish the upgrade. Your current session may still hold stale AGENTS.md / skill references from the previous version.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

<!-- xbrief-backcompat-2111 -->

> **xBRIEF rename (#2034 / #2110):** Projects still on the legacy `vbrief/` layout and `x-vbrief/` reference tokens remain read-accepted until you run `deft migrate:xbrief` (or `task migrate:xbrief`). `deft doctor` and `deft update` signpost unmigrated layouts.

---

## TypeScript 7 side-by-side (pre-7.1) (#2591)

- **Applies when:** a Deft TypeScript project (or agent upgrading its toolchain) needs TypeScript 7 before ~7.1, while `typescript-eslint` and other programmatic consumers still require the TS 6 compiler API. This is **not** a Directive framework-version migration — read [languages/typescript.md](./languages/typescript.md) instead of treating it like a `deft update` step.
- **Safe to auto-run:** Yes for the alias + Dependabot-ignore edits in the project's own `package.json` / `.github/dependabot.yml` when following the documented pattern.
- **Restart required:** No. Re-run `task check` / `npm install` (or your package manager equivalent) after changing devDependencies.
- **Commands:**
  - Read the full pattern: [languages/typescript.md — TypeScript 7 side-by-side (pre-7.1)](./languages/typescript.md#typescript-7-side-by-side-pre-71)
  - After edits: `npm install` (or `pnpm install` / `yarn`) then `task check`
- **References:**
  - [#2591](https://github.com/deftai/directive/issues/2591) — document side-by-side setup for Deft TypeScript projects.
  - [deftai/cartograph#111](https://github.com/deftai/cartograph/pull/111) — precedent implementation.

---

## Helped + health metrics relocation (#2545)

- **Applies when:** any project that upgraded to a release shipping #2545 and still has append logs under `<lifecycle-root>/.eval/results/crud-metrics.jsonl` or `health-history.jsonl` inside the git worktree.
- **Safe to auto-run:** Yes. New runs write to the resolved user-data metrics root; no manual migration of historical rows is required (lost worktree copies are acceptable).
- **Restart required:** No for the filesystem change. Start a **new agent session** after upgrade if agents still cite the old `xbrief/.eval/results/` paths.
- **Commands:**
  - `deft eval:health` (persists to the resolved metrics home on success)
  - Inspect platform default: `%APPDATA%\deft\metrics\` (Windows) or `~/.config/deft/metrics/` (Unix)
  - Headless / CI: set `DEFT_METRICS_HOME` (or `DEFT_EVAL_HOME`) to a job artifact directory

### What changed

- **Helped + health ledgers moved out of the project tree.** `crud-metrics.jsonl` (value / "how we helped") and `health-history.jsonl` (`eval:health` history) now resolve under a shared metrics home with `helped/` and `health/` subdirectories.
- **Resolve ladder:** `DEFT_METRICS_HOME` / `DEFT_EVAL_HOME` override → optional workspace-local `<project>/.deft/metrics/` when `DEFT_METRICS_PROJECT_LOCAL=1` → platform user-data (`%APPDATA%\deft\metrics` / `~/.config/deft/metrics`). No fallback to `xbrief/.eval/results/`.
- **Soft-disable:** when no writable metrics home exists, persistence is skipped (metrics-disabled) instead of dirtying the worktree.
- **Golden-run eval artifacts** (`golden-runs.jsonl`, committed `eval-health-baseline.json`) remain under `<lifecycle-root>/.eval/results/`.

### References

- [#2545](https://github.com/deftai/directive/issues/2545) — metrics relocation.
- [`packages/core/src/metrics/resolve-metrics-home.ts`](../packages/core/src/metrics/resolve-metrics-home.ts) — shared resolver.

---

## Which command do I run? (three-command model)

Directive is driven by three commands, and upgrading is one of them. Route by situation to exactly one:

- **Ordinary upgrade of an existing Directive project** → `directive update` (after `npm i -g @deftai/directive@latest`). This is the one command most upgrades need; the [Canonical upgrade — npm](#canonical-upgrade--npm-v0551) section below is the full walkthrough.
- **Not sure what state you are in, or something looks broken** → `directive doctor`. It is read-only and prints exactly one recommended next step (including "run `directive update`" when the deposit is stale).
- **First-time adoption, or a legacy / pre-v0.20 layout** → `directive init`. It classifies the directory and either scaffolds Directive or routes you to the specific migration path.

Everything below preserves the **advanced and big-jump** detail — multi-version jumps, the frozen pre-v0.20 bridge, legacy Go-installer migration, and the per-version transitions. Ordinary upgraders only need `directive update`; reach into the detailed sections when `directive doctor` or the [big-jump triage](#big-jump-triage--multi-version-upgrades-start-here) points you there.

---

## Canonical upgrade — npm (v0.55.1+)

From v0.55.1 onwards `@deftai/directive` is published on npm. The canonical consumer upgrade path is:

1. **Upgrade the global engine** (Node ≥ 20):

   ```bash
   npm i -g @deftai/directive@latest
   ```

   **Using pnpm?** pnpm installs the same package from the same npm registry — no extra registry or config:

   ```bash
   pnpm add -g @deftai/directive@latest
   ```

   Ensure pnpm's global bin directory is on your `PATH` (`pnpm setup` configures `PNPM_HOME`). A project-local `pnpm add -D @deftai/directive@latest` (run via `pnpm exec directive …`) is equivalent for pnpm-managed repos that avoid global installs. `deft update` / `deft migrate` / `deft doctor` all work identically regardless of which package manager installed the engine.

2. **Refresh the project deposit** from your project root:

   ```bash
   deft update
   ```

   This re-copies the vendored `.deft/core/` payload and refreshes project-root `.githooks/` (#2049).

   **Prettier / format gate (#2534):** managed `.deft/core/` is outside your consumer Prettier gate. `directive init` and `directive update` idempotently deposit or heal a root `.prettierignore` entry for `.deft/core/` so `prettier --check .` (and `task check` when Prettier is wired) does not fail on the vendored framework payload. You do not need to reformat `.deft/core/` after upgrade.

   > **`deft update` is the single canonical upgrade verb (#2064).** The older `deft install-upgrade` (and its `task upgrade` maintainer alias) now print a one-line notice and delegate to this exact `deft update` path — they no longer have their own semantics. Previously `install-upgrade` only rewrote the marker/manifest without swapping the payload, so on a stale deposit it reported a false "Project already at X. Nothing to do." Use `deft update`; there is nothing `install-upgrade` does that `deft update` does not.

3. **Stamp npm provenance (one-time, idempotent):**

   ```bash
   deft migrate
   ```

   Adds `managed_by: npm` to `.deft/core/VERSION` so doctor and future updates recognize the npm channel. Safe to re-run — when already hybrid, migrate is a no-op.

4. **Verify:**

   ```bash
   deft doctor
   ```

Start a **new agent session** after steps 2–3 so the refreshed AGENTS.md and skills load from a clean context.

## OpenPackage tiered skills (optional, #2462)

The npm engine (`npm i -g @deftai/directive`) remains the canonical runtime handler for gates, lifecycle, and `.deft/core/` refresh. **OpenPackage** is an optional cross-harness distribution path for placing tiered consumer skills into Cursor, Codex CLI, and OpenCode native directories — without a Directive-owned skill router.

1. Install OpenPackage CLI: `npm i -g opkg`
2. From a maintainer checkout (or release tree), sync skills into the package (default: **daily-core** only):

   ```bash
   node packaging/openpackage/sync-skills.mjs
   ```

   For all tiers on disk (maintainer release prep): `node packaging/openpackage/sync-skills.mjs --tier all`

3. From your **project root** (after `directive init`):

   ```bash
   opkg install /path/to/directive/packaging/openpackage/deft-directive-skills --platforms cursor codex opencode
   ```

**Default install tier:** **daily-core** (setup, sync, build, pre-pr, review-cycle, triage) — the sync script and `deft-tiers.json` `defaultInstallTier` select this unless you override with `--tier all`, `--tier standard`, or `--tier advanced`. **Standard** covers operational workflows; **advanced** (release, swarm, debug, article-review) stays deferred. Full lists: `packaging/openpackage/deft-tiers.json`. Detail: [`packaging/openpackage/deft-directive-skills/README.md`](../packaging/openpackage/deft-directive-skills/README.md).

Consumer AGENTS.md stays pointer-thin — scan `.deft/core/REFERENCES.md` Skills Index; do not enumerate skills in the managed section.

### Always-on bootstrap budget (DD-3, #2463)

`verify:agents-md-budget` now itemizes the always-on bootstrap surface:

- **Managed AGENTS.md** bytes (fail-closed ratchet via `plan.policy.agentsMdBudget.absoluteMaxBytes`)
- **Harness skill frontmatter** bytes (Cursor `<agent_skill>` shape; advisory unless `skillFrontmatterMaxBytes` is set)
- **Bootstrap hooks** bytes (0 until #2438 ships)

The north-star target is **≤8192 B / ~2k tok for the managed section** (Phase-2) and **≤9216 B / ~2.3k tok combined** (managed + DD-3 + hooks; Phase-3 closeout #2531). On Cursor with all skills injected, managed AGENTS.md plus skill frontmatter can still exceed the combined bar — remediation paths:

1. **Tier skills** — install only the daily-core six (`setup`, `sync`, `build`, `pre-pr`, `review-cycle`, `triage`) via OpenPackage; set `plan.policy.agentsMdBudget.skillFrontmatterTier` to `daily-core` or export `DEFT_AGENTS_MD_BUDGET_SKILL_TIER=daily-core`.
2. **Thin managed AGENTS.md** — continue epic #2369 relocation; push bulk to `commands.md`, `scm/github.md`, and skills.
3. **Shorten SKILL.md descriptions** — advanced-tier skills (`release`, `swarm`, `debug`, `article-review`, …) are the largest frontmatter offenders.
4. **Optional ratchet** — seed `plan.policy.agentsMdBudget.skillFrontmatterMaxBytes` at the measured tier size when you want fail-closed DD-3 growth control. The directive framework tree itself seeds this at daily-core **2080 B** (with `skillFrontmatterTier: daily-core`) as Phase-3 insurance (#2532 / #2531); consumers remain advisory until they opt in.

Non-native-skill harnesses (Codex CLI, OpenCode) report 0 B frontmatter; set `harnessProfile: none` in policy when appropriate.

## xBRIEF layout migration (#2034 / #2110)

After upgrading to a release that ships the xbrief rename, convert legacy on-disk layout if `deft doctor` reports a `vbrief/` tree or `x-vbrief/` reference tokens:

```bash
deft migrate:xbrief
```

(or `task migrate:xbrief` from a maintainer checkout). The command requires a clean working tree unless you pass `--force`. Legacy `vbrief/` paths and `x-vbrief/` tokens remain **read-accepted** until this migration runs; `deft update` may signpost the same guidance on non-patch upgrades.

Post-migration behavior check (#2149): on xbrief-only projects (`vbrief/` removed), `task issue:ingest -- <N>` now emits `xbrief/proposed/*.xbrief.json` with `xBRIEFInfo.version` from `xbrief/PROJECT-DEFINITION.xbrief.json` (fallback `0.8`), while legacy `vbrief/` projects keep `.vbrief.json` + `vBRIEFInfo.version: "0.6"` until migrated. `task project:render` / `project-render` also stays on `xbrief/PROJECT-DEFINITION.xbrief.json` and no longer recreates `vbrief/` in migrated trees.

### AGENTS.md: managed vs unmanaged header (#2154)

`migrate:xbrief` touches your `AGENTS.md` in two distinct regions:

- **Managed section** (between the `<!-- deft:managed-section ... -->` / `<!-- /deft:managed-section -->` markers): regenerated wholesale by `agents:refresh`, so it always reflects the current framework layout. This region is rendered from the framework template — do not hand-edit it.
- **Unmanaged header/tail** (everything outside those markers — your project-specific `Session orientation`, `Lifecycle` examples, `Local dev` notes): preserved verbatim across upgrades so your consumer notes survive. Because it is preserved, a rename migration would otherwise leave stale `vbrief/` path literals here. `migrate:xbrief` now applies a **bounded, idempotent** rewrite over the unmanaged region only, replacing the known crossover tokens (`vbrief/` → `xbrief/`, `*.vbrief.json` → `*.xbrief.json`, `vbrief:preflight` → `xbrief:preflight`) while leaving freeform prose untouched. It prints a summary of the replacements.

If you upgraded before this fix landed and your header still points at `vbrief/`, `deft doctor` now emits an `AGENTS.md header drift:` signpost. Re-run `deft migrate:xbrief` (idempotent) to patch the header, or hand-edit the offending path literals.

**Option A (canonical, #2065):** new installs scaffold a **bounded** unmanaged header only — a project one-liner plus a **Session orientation** pointer at the canonical sources below. Do **not** add freeform `Status`, `Next:`, or `Known Issues` blocks; they are retired because the framework preserves the header verbatim while `deft doctor` only checks the managed section (#794, #1308). Session orientation comes from:

- `xbrief/PROJECT-DEFINITION.xbrief.json` (project identity)
- `xbrief/` lifecycle folders (scoped work)
- `deft triage:queue` / `deft triage:welcome` (ranked queue)
- GitHub issues (tracked bugs)

If your header still carries `Status` / `Known Issues` from an older handoff, replace them with the Session orientation pointer (reference implementation: [deftai/cartograph#75](https://github.com/deftai/cartograph/pull/75)). Ephemeral shell quirks MAY stay under a `Local dev` heading only.

## Public contract layer — `@deftai/directive-types` (#1799)

Downstream TypeScript projects can import the canonical xBRIEF/policy contract instead of hand-mirroring JSON shapes:

```typescript
import type { XBriefDocument, PlanPolicy, Status } from "@deftai/directive-types";
```

JSON Schema for non-TS consumers ships from the same package:

```json
{
  "$schema": "https://xbrief.dev/schemas/xbrief-core-0.8.schema.json"
}
```

Or import the artifact directly:

```javascript
import schema from "@deftai/directive-types/schemas/xbrief-core-0.8.schema.json" assert { type: "json" };
```

**Supported public API:** `@deftai/directive-types` and its published schema subpaths only. **`@deftai/directive-core` is published for npm dependency resolution but is not a supported library surface** — use the `deft` / `directive` CLI for behavior.

**Schema source of truth:** `content/vbrief/schemas/vbrief-core.schema.json` in the directive repo. The types package mirrors it to `packages/types/schemas/` at build time; `deft` install also deposits schemas under project-root `xbrief/schemas/`. When in doubt, treat the directive repo canonical file as authoritative and refresh mirrors with `deft update` (install) or `@deftai/directive-types` (npm).

### `deft migrate` vs pre-v0.20 document-model migration

These commands are unrelated — do not confuse them:

| Command | When to use | What it does |
| --- | --- | --- |
| `deft migrate` / `directive migrate` | Canonical-vendored `.deft/core/` deposit after npm upgrade (#1941) | Stamps `managed_by: npm` into the install manifest. Idempotent; never downloads payload. |
| Pre-v0.20 document-model migration | Legacy authoritative `SPECIFICATION.md` / `PROJECT.md` only | **Not shipped on current npm releases (#2068).** Use the [frozen-release path](#frozen-pre-v020-document-model-migration-2068) below. |

### Frozen pre-v0.20 document-model migration (#2068)

Current `@deftai/directive` npm releases no longer ship `task migrate:vbrief` or `scripts/migrate_vbrief.py` on the consumer deposit path (#2022 Phase 3). If your project still uses the pre-v0.20 flat document model (authoritative root `SPECIFICATION.md` / `PROJECT.md` without vBRIEF lifecycle folders), migrate **once** on a pinned release that still bundles the Python migrator, then join the normal npm upgrade path.

> **Durability & support horizon (#2297).** This is a **best-effort** path for a document model that predates v0.20. The permanence anchor is the **`v0.59.0` git tag** — GitHub serves a source tarball for any tag on demand (`https://github.com/deftai/directive/archive/refs/tags/v0.59.0.tar.gz`), so recovery does **not** depend on any uploaded release asset staying attached. As long as the tag exists, the migrator is reachable. If you cannot reach the frozen payload at all, use the **[Fresh-start fallback](#fresh-start-fallback-2297)** below.

**Applies when:** `deft doctor` reports `Pre-cutover: migration needed`, or `task migrate:preflight` exits non-zero with a `document-model` FAIL line.

**Pinned tag:** `v0.59.0` — the last release before the Python-free npm deposit; the tagged tree includes `scripts/migrate_vbrief.py`.

**This is a two-hop chain.** The pre-v0.20 flat model does not migrate straight to the current layout: hop 1 is `task migrate:vbrief` on **v0.59.0** (flat → vBRIEF v0.6); hop 2 is `deft migrate:xbrief` on **current npm** (vBRIEF v0.6 → xBRIEF v0.8). Steps 5–6 below cover hop 2.

**Steps:**

1. Install **Python 3.11+** and **[uv](https://docs.astral.sh/uv/)** on the migration machine.
2. Deposit framework **v0.59.0** using one of (git-tag methods first — they survive even if release assets are removed):
   - **Source tarball from the tag:** `curl -fsSL https://github.com/deftai/directive/archive/refs/tags/v0.59.0.tar.gz | tar xz` (full source tree including the migrator), or
   - **Git clone / submodule:** `git checkout v0.59.0` in your framework checkout, or
   - **Frozen Go installer** at [GitHub Releases tag v0.59.0](https://github.com/deftai/directive/releases/tag/v0.59.0) (legacy bridge; relies on the uploaded asset, so prefer a git-tag method above for durability).
3. From the project root, preview then apply:
   ```bash
   task migrate:preflight
   task migrate:vbrief -- --dry-run
   task migrate:vbrief
   ```
   Fallback when the consumer Taskfile has no deft include: `task -t ./.deft/core/Taskfile.yml migrate:vbrief`.
4. Regenerate exports once: `task roadmap:render`, `task project:render`, and `task prd:render -- --force` when you maintain a `PRD.md`.
5. Upgrade to current npm: `npm i -g @deftai/directive@latest`, then `deft update`, `deft migrate`, `deft doctor`.
6. Start a **new agent session** so refreshed AGENTS.md and skills load from a clean context.

⊗ Run `npm i -g @deftai/directive@latest` / `deft update` on a project that still has authoritative pre-v0.20 root docs — the current deposit cannot run the migrator; follow the frozen path first.

#### Fresh-start fallback (#2297)

The automated migrator is a convenience, not the only route. If the `v0.59.0` payload is genuinely unreachable (tag deleted, no network, Python/uv unavailable, or the migrator errors on an unusual legacy shape), you are **not** stranded — port forward manually:

1. On **current npm**, scaffold a clean project beside the old one: `directive init` (or `npx @deftai/directive init`). This produces the current xBRIEF layout directly, skipping both hops.
2. Hand-port your content: copy the substance of the old `SPECIFICATION.md` / `PROJECT.md` into the new project definition and scope xBRIEFs the setup flow creates. Your prose is the source of truth; only the container format changed.
3. Keep the old tree read-only for reference until the new project's `deft doctor` is green, then archive it.

This is lossless for content (you re-author the container, not the substance) and depends on nothing but current npm — so it is the guaranteed floor under the best-effort automated path.

See [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for what migration produces and how content is preserved.

### One-time migration from the Go installer (legacy → npm)

If your current install uses the frozen Go installer (`deft-install`), migrate once:

1. Install Node ≥ 20 if not already present.
2. Run `npm i -g @deftai/directive@latest` to install the engine from npm.
3. In your project, run `deft update` to refresh `.deft/core/` and `.githooks/`.
4. Run `deft migrate` once to stamp npm provenance (idempotent).
5. Run `deft agents:refresh` if the AGENTS.md managed section is stale.
6. Verify with `deft doctor` — install integrity confirms the npm payload is current.

The frozen Go installer remains available at [GitHub Releases](https://github.com/deftai/directive/releases) as a legacy / offline bridge but receives no further updates (#1912); Node ≥ 20 is still required to run Deft afterward. After this one-time step, the four-step npm path above is all you need for every future upgrade.

> **Security (#2305): only run the migration bridge against a repository you trust.** A malicious repo can commit `.deft` / `.deft/core` (or a parent) as a symlink that escapes the tree, causing the deposit to write framework content outside the project directory under your account. The canonical npm CLI now refuses a symlink-escaping deposit boundary, but the **frozen Go installer** (`cmd/deft-install/upgrade.go`) is **not** patched — it is explicitly won't-fix / risk-accepted (no further Go releases, #1912). Run it only on repositories you control or trust.

---

## Legacy layout refused by the npm CLI (#1912)

If you run `npx @deftai/directive init` (or `update`) on a project that still
uses a **legacy on-disk layout**, the npm CLI **refuses** and exits non-zero
**without depositing or refreshing anything**. The npm path never migrates a
legacy layout; the frozen final Go installer is the one-and-only migration
bridge. This is the run-from-npm, use-time gate that backs the one-time
migration above.

> **Security (#2305): trust the repo before running the frozen migration bridge.** The npm CLI refuses a deposit whose `.deft` / `.deft/core` (or a parent) is a symlink escaping the resolved project tree, so a malicious repo cannot redirect the deposit to an arbitrary location under your account. The one residual exposure the npm gate cannot cover is running the **frozen Go bridge** against an untrusted repo during legacy migration (the Go binary acts before npm ever runs); it is explicitly won't-fix / risk-accepted (#1912). Only run the migration bridge against a repository you trust.

**Legacy layouts the npm CLI refuses:**

- a git-clone or git-submodule deposit of the framework;
- a legacy `deft/`-prefixed install root (the canonical root is `.deft/core/`);
- a pre-v0.27 AGENTS.md with a sentinel-only managed-section (no v2/v3
  managed-section markers);
- an orphan `.deft/VERSION` manifest with no `.deft/core/` directory.

**The two-step recovery (version-neutral):**

1. **Run the frozen final Go bridge installer** to migrate the old layout to the
   canonical `.deft/core/` vendored layout. Download the binary for your
   platform from [GitHub Releases](https://github.com/deftai/directive/releases)
   (see [Legacy and offline install](https://github.com/deftai/directive#legacy-and-offline-install-go-installer-1912))
   and run it from your project directory. The bridge is **frozen** — always
   the latest published release; there is no version to memorise.
2. **Re-run the npm path** once the layout is canonical-vendored:

   ```bash
   npx @deftai/directive init      # or: npx @deftai/directive update
   ```

After step 1 the layout is `.deft/core/`, so the npm CLI takes over cleanly and
`npm i -g @deftai/directive@latest` is your only future upgrade command.

> **Why a pointer, not a baked command?** The npm CLI, `directive doctor`, and
> AGENTS.md never bake a Go-installer version number or a literal upgrade command
> into your installed files. They signpost this stable doc + the Releases page so
> the bridge always resolves fresh — the upgrade instructions can never go stale
> inside the artifact being upgraded.

`directive doctor` emits the same signpost (a `legacy-layout` check that fails
with this URL) whenever it detects a legacy layout, so an agent or operator who
runs the doctor first gets pointed at this exact two-step before touching `init`.

---

## Big-jump triage — multi-version upgrades (start here)

> **Multi-version jump?** Start here. This guide is ordered newest-first, so a consumer jumping several minor versions otherwise has to read every section to infer which ones apply and in what order. This entry point maps **version-range buckets** to the sections that apply and the **apply-order** to run them in.

**How to use this triage:**

1. Find the bucket for the version you are upgrading **from** (your current `.deft-version`, or the `tag` field in `<install>/VERSION`).
2. Apply the listed transitions in **apply-order: oldest applicable first**, working forward to the newest. Because the sections in this file are ordered newest-first, that means working **bottom-up** through the file.
3. Each bucket is flagged **auto-handled** (the canonical installer / `task doctor` / `task upgrade` does it for you) or **manual** (you run a migration / relocate / cache step yourself).

**Version-range buckets (apply-order, oldest applicable first):**

- **From pre-v0.20 (very old) — manual.** Run the pre-cutover migration on pinned **v0.59.0**, then refresh AGENTS.md: [Frozen pre-v0.20 document-model migration (#2068)](#frozen-pre-v020-document-model-migration-2068) and [From pre-#768 AGENTS.md → managed-section AGENTS.md](#from-pre-768-agentsmd--managed-section-agentsmd). Agents: when the project shows BOTH a stale AGENTS.md and pre-cutover artifacts, follow [QUICK-START.md Case G+H](./QUICK-START.md#case-gh--combined-stale-agentsmd--pre-cutover-migration-big-jump-one-session) to complete both in one session instead of two.
- **From v0.20–v0.24 — auto-handled (opt-in).** Triage v1 is purely additive; nothing breaks if you skip it: [Migration to triage v1](#migration-to-triage-v1).
- **From v0.25.x — manual (breaking).** The deft-cache on-disk layout changed: [From v0.25.x → v0.26.0](#from-v025x--v0260-deft-cache-unified-layer-breaking).
- **From v0.26.x — auto-handled (interactive).** Run the triage adoption ritual: [From v0.26.x → v0.27](#from-v026x---v027-triage-adoption-via-task-triagewelcome).
- **From v0.27.x — mostly auto-handled.** Pick up the install manifest and the `deft/` → `.deft/core/` layout: [From v0.27.x → v0.28](#from-v027x---v028-canonical-install-manifest-at-installversion), [From deft/ → .deft/core/](#from-deft---deftcore), and [From drifted AGENTS.md → current install](#from-drifted-agentsmd---current-install-task-upgrade-repair-path-1061).
- **From v0.60.x — manual (hook refresh).** After #2049, consumer `.githooks/` dispatch through the `deft` CLI only. Run [From v0.60.0 → v0.61.x (refresh project-root git hooks, #2049)](#from-v0600--v061x-refresh-project-root-git-hooks-2049) after every framework upgrade that touches hook templates.
- **From v0.28–v0.36 (and the final hop to current) — auto-handled.** If still on the Go-installer layout, follow the [One-time migration from the Go installer](#one-time-migration-from-the-go-installer-legacy--npm) above, then `npm i -g @deftai/directive@latest` for all future upgrades.
- **From v0.70.x — auto-handled (lazy).** The triage working-set cache moved off `.eval/` to `.triage-cache/`; run any triage/scope/doctor command once after upgrade to trigger the lazy migration: [From v0.70.x → v0.71.0 (triage cache relocation, #1703)](#from-v070x--v0710-triage-cache-relocation-1703).

**Final step for every bucket.** Finish on the canonical npm upgrade path, then let the doctor confirm you are current:

```bash
npm i -g @deftai/directive@latest
deft update
deft migrate
deft doctor
```

Run those from your project root after any bucket-specific hops (`deft update` refreshes `.deft/core/` and `.githooks/`; `deft migrate` stamps npm provenance once and is idempotent). If still on a Go-installer layout, follow the [One-time migration from the Go installer](#one-time-migration-from-the-go-installer-legacy--npm) first.

---

## From v0.70.x → v0.71.0 (triage cache relocation, #1703)

- **Applies when:** any project on deft v0.70.x (or earlier releases that stored the triage working-set under `<lifecycle-root>/.eval/`) that upgrades to v0.71.0+. Detection: after upgrade, triage append-only logs (`candidates.jsonl`, `slices.jsonl`, `summary-history.jsonl`, `scope-lifecycle.jsonl`, `subscription-history.jsonl`, `doctor-state.json`, `decompositions/`, `README.md`) still live under `<lifecycle-root>/.eval/` instead of `<lifecycle-root>/.triage-cache/`. The `<lifecycle-root>` is `xbrief/` or legacy `vbrief/` depending on your layout.
- **Safe to auto-run:** Yes (lazy, idempotent). The engine migrates each known legacy file/dir from `.eval/` → `.triage-cache/` the first time any triage/scope/doctor path is resolved after upgrade — for example `deft triage:summary`, `deft triage:bootstrap`, `deft doctor`, or any scope transition that touches the triage cache. Nothing to do manually beyond running one of those commands once; re-runs are no-ops.
- **Restart required:** No for the filesystem migration itself. Start a **new agent session** after upgrade if your session still cites the old `.eval/` triage paths in AGENTS.md or skill prose loaded before the deposit refresh.
- **Commands:**
  - `deft triage:summary` (or any other triage/scope/doctor verb — triggers lazy migration on first resolve)
  - `deft doctor` (also resolves triage-cache paths during install-integrity checks)
  - `ls <lifecycle-root>/.triage-cache/` (confirm relocated files after the first trigger)

### What changed

- **Triage working-set moved.** Append-only triage logs, decomposition scratch, and the deposited triage README now resolve under `<lifecycle-root>/.triage-cache/` instead of `<lifecycle-root>/.eval/`.
- **`.eval/` reclaimed for framework eval.** The `.eval/` namespace is now the version-eval results store at `<lifecycle-root>/.eval/results/` (health/golden/crud ledgers from #1703). This store had no prior home — it is not a rename of the triage cache.
- **Lazy migration, not upgrade-triggered.** `deft update`, `deft migrate`, and `deft migrate:xbrief` do **not** relocate the triage working-set. The last copies `vbrief/.eval/` → `xbrief/.eval/` as-is when crossing the xbrief rename; the triage relocation fires only on triage/scope/doctor path resolve. There is no dedicated `migrate:triage-cache` verb.
- **Conflict policy (canonical wins).** When both a legacy `.eval/` copy and a canonical `.triage-cache/` copy of the same basename exist, the legacy `.eval/` entry is skipped — the canonical `.triage-cache/` file wins. The migration is idempotent.

### References

- [#1703](https://github.com/deftai/directive/issues/1703) — triage working-set relocation + framework-eval results store.
- [#2349](https://github.com/deftai/directive/issues/2349) — operator-facing upgrade documentation for this relocation.
- [`packages/core/src/triage/cache-path.ts`](../packages/core/src/triage/cache-path.ts) — `migrateLegacyTriageCacheFromEval()` implementation.

---

## From v0.60.0 → v0.61.x (refresh project-root git hooks, #2049)

- **Applies when:** your project was on deft v0.60.x (or earlier) with `.githooks/` installed via `deft setup` / the npm deposit path, and hooks still invoke legacy Python scripts (`scripts/preflight_branch.py`, `scripts/preflight_gh.py`, etc.). Detection: `deft verify:hooks-installed` fails with "still dispatches through Python scripts (expected deft CLI only, #2049)" or pre-commit/pre-push errors mentioning missing `scripts/*.py` on Python-free installs.
- **Safe to auto-run:** Yes. `deft update` from the project root re-deposits the current `.githooks/` templates and refreshes the vendored `.deft/core/` payload. No manual hook editing required when the update completes cleanly.
- **Restart required:** No for hook wiring — but start a **new agent session** after update so AGENTS.md and skills reflect the refreshed managed section.
- **Commands:**
  - `npm i -g @deftai/directive@latest` (upgrade the global CLI/engine)
  - `deft update` (from project root — refreshes `.deft/core/` + `.githooks/`)
  - `deft verify:hooks-installed` (confirm pre-commit/pre-push dispatch via `deft verify:branch`, `deft verify:encoding`, `deft preflight-gh`)
  - `deft doctor` (install integrity + managed-section freshness)

If `deft update` is unavailable (older deposit), run `deft init` on a greenfield tree or upgrade the global CLI first — `task setup` / `deft setup` only wires `core.hooksPath` and refuses when project-root `.githooks/` is missing (#2530).

---

## Canonical installer + doctor handoff (v0.37+ / Epic-5+6 #1339 #1340, #1409)

> **Note (v0.55.1+):** npm is now the canonical install and upgrade path. See [Canonical upgrade — npm](#canonical-upgrade--npm-v0551) above. The Go-installer install path documented here is a **frozen legacy bridge** (#1912); it remains accurate for consumers still on that layout.

**Legacy Go-installer path (for archaeology / migration reference):**

1. Download and run the platform-specific installer binary from GitHub Releases.
2. The installer writes the payload + manifest + AGENTS.md + skills, then **deterministically calls `scripts/doctor.py --session --json`** at the end.
3. Doctor (now the single owner of all health/install-integrity/staleness logic) reads the `<install>/VERSION` manifest and, when the recorded sha lags the remote ref, emits a **clear recommendation** to run the canonical headless upgrader: `deft-install --yes --upgrade --repo-root . --json`.
4. On subsequent sessions `task doctor` / `run doctor` (thin shims to the canonical `scripts/doctor.py`) continue to surface the same guidance.

### Canonical headless upgrade command (consumers + CI/agents) (#1409)

! The canonical, one-command payload refresh for an **existing** install is:

```bash
deft-install --yes --upgrade --repo-root . --json
```

- `--yes` / `--non-interactive` skips all prompts (ideal for CI / agents).
- `--upgrade` forces the update path even when the framework dir already exists.
- `--repo-root .` targets the current project (or pass an explicit path).
- `--json` emits a single machine-readable result object on stdout; **drop `--json` for human-readable output**.

Run it from your project root. Unlike the legacy metadata-only verbs, this command actually **replaces the framework payload** in `.deft/core/` AND refreshes the manifest + AGENTS.md, so doctor logic, skills, and scripts all advance to the current snapshot. This is the command the doctor's payload-staleness check now recommends verbatim.

**Version-skew note:** consumers on an installer binary that predates the Epic-4/5/6 headless work do not have these flags. Download the latest `deft-install` binary from GitHub Releases first, then run it with `--yes --upgrade --repo-root . --json`.

**Legacy paths (back-compat only / de-emphasized):**
- `task upgrade` / `run upgrade` -- **metadata-only acknowledgment**: refreshes the `.deft-version` marker, the `<install>/VERSION` manifest, and the AGENTS.md managed section, but does NOT replace the framework payload. Use the headless installer command above for a real payload refresh.
- `task relocate -- --confirm` (and the `task relocate:relocate -- --confirm` form) -- **back-compat only**: moves / reinstalls the framework dir for the rare install-path-consistency relocate, not for routine upgrades.
- `run install --force` -- back-compat reinstall path superseded by `--yes --upgrade`.
- `task framework:doctor`, `run doctor` direct old shims, `scripts/framework_doctor.py` (retired #1336)
- Manual git submodule updates or cloning `deft/` by hand (the installer is the reproducible, manifest-stamped mechanism)
- Old AGENTS.md thin pointers and upgrade prose that pre-date the unified handoff

All documentation (README, AGENTS.md, this file, `deft-directive-sync` skill) now points agents at the headless installer command + doctor handoff as the authoritative flow. Old sections below are retained for migration archaeology only.

---

## Coverage hotspots + pre-PR headroom (#2683)

After `deft update` / deposit, consumer projects gain:

- `deft coverage:hotspots` (and deposited `task coverage:hotspots`) — cheap branch headroom + hotspot report from the latest `coverage/coverage-final.json`; `--json` for agents.
- Updated `deft-directive-pre-pr` guidance — run targeted coverage on changed modules first, exercise both sides of new branches, aim for ≥ project floor + 0.3–0.5pp headroom, then use `coverage:hotspots` before full `task check`.

This complements (does not replace) `deft verify:forward-coverage` (#1310) or `--allow-coverage-debt=#N` (#2573).

---

## Node runtime (#1828 / #1530)

After Wave 8, live deft gates run through the TypeScript engine. **Node.js and pnpm are required consumer runtimes** alongside Python (`uv`) — not optional extras for framework contributors only.

- Install **Node 20+** (the framework pins `.nvmrc`; currently Node 24).
- Enable pnpm via Corepack: `corepack enable && corepack prepare pnpm@latest --activate`
- Verify from your project root: `task toolchain:check` (or `deft toolchain:check`). When Node or pnpm is missing, the check exits non-zero and prints an actionable remediation line instead of failing later with an opaque stack trace.

---

## From v0.53.0–v0.53.1 → v0.53.2 (vitest no longer discovers vendored framework tests, #1878)

- **Applies when:** your project uses **vitest** AND you upgraded to v0.53.0 or v0.53.1, whose deposit vendored the TypeScript engine under `.deft/core/packages/` **including** the framework's own `*.test.ts` / `*.spec.ts` files. Detection: your vitest run discovers ~80+ files under `.deft/core/packages/` via its default include glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) and CI fails with `ERR_MODULE_NOT_FOUND` for `@deftai/core` plus framework parity assertion failures. Projects that do not use vitest (or that already exclude `.deft/core/**`) are unaffected.
- **Safe to auto-run:** Yes. The installer now prunes the vendored `*.test.*` / `*.spec.*` files from the `.deft/core/packages/` deposit on every install and upgrade (and the release archive omits them too), leaving no framework test files for your vitest to discover. The prune touches only the framework's own test SOURCE files; non-test engine sources are left intact. No operator action is required once you are on v0.53.2+.
- **Restart required:** No -- the prune is a filesystem change to the vendored deposit; the agent's in-memory context does not depend on it.
- **Commands:**
  - `deft-install --yes --upgrade --repo-root . --json` (refreshes the `.deft/core/` deposit; the prune runs automatically as part of the install)
  - Interim manual workaround **only if you are mid-upgrade on a still-red v0.53.0/v0.53.1 PR**: add `.deft/core/**` to your vitest config's `test.exclude` (and `coverage.exclude`) so vitest skips the vendored payload, then re-run CI:

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '.deft/core/**'],
    coverage: { exclude: ['.deft/core/**'] },
  },
});
```

This manual exclude is harmless to keep, but it becomes unnecessary once the installer prune lands in your deposit. Note: the deft-core-guard workflow (#1430) refuses a PR that mixes a `.deft/core/**` change with your own files, so apply the vitest-config exclude in a **separate** PR from the framework deposit.

---

<!-- 1046-prb: From v0.27.x -> v0.28 install-manifest transition BEGIN -->
## From v0.27.x -> v0.28 (canonical install manifest at `<install>/VERSION`)

- **Applies when:** any project on deft v0.27.0, v0.27.1, or v0.27.2 that has an existing `./.deft-version` marker but no `<install>/VERSION` YAML provenance manifest at the install root (`./.deft/core/VERSION` for canonical installs, `./deft/VERSION` for legacy state-A installs). Detection: `task framework:doctor` reports the `manifest-agreement` check as FAIL with `missing-manifest`; the upgrade gate emits a one-line advisory (`[deft framework:doctor] 1 check(s) drifted (manifest-agreement). Run \`task framework:doctor\` for the full report. Refs #1046.`) on every CLI invocation. Pre-v0.27 projects skip this section -- they pick up the manifest on first `task upgrade` after landing v0.28.
- **Safe to auto-run:** Yes. The transition is fully automatic on first `task upgrade` (or `run upgrade`, or `run install --force`) post-v0.28 install. `cmd_upgrade` / `cmd_install` write the canonical YAML manifest at the install root with `fetched_by: run-upgrade` / `run-install`, current framework VERSION as `tag`, resolved git SHA as `sha`, and UTC `fetched_at`. The bare `.deft-version` is regenerated from the manifest's `tag` field (matching the v0.27 single-string format). No operator action required -- the gate advisory is purely informational and never blocks the CLI invocation.
- **Restart required:** No -- the manifest is structural state on disk; the agent's in-memory context does not depend on it. Future `task framework:doctor` invocations transition the `manifest-agreement` check from FAIL to PASS without a session restart.
- **Commands:**
  - `task framework:doctor` (read the four-check report; FAIL on the `manifest-agreement` check is the canonical pre-transition state)
  - `task framework:doctor -- --json` (machine-readable form -- the `checks` array carries per-check status; useful for CI assertions)
  - `task upgrade` (writes the canonical manifest + regenerates the derivative; idempotent on re-run -- a second invocation against a current manifest is a no-op)
  - `run install --force <path>` (rewrites the framework dir AND stamps a fresh manifest; the operator-consent path for reinstalls)

### What changes for consumers

- **Canonical manifest.** `<install>/VERSION` (YAML provenance: `ref`, `sha`, `tag`, `fetched_at`, `fetched_by`) is the canonical source of truth for what the framework believes about itself on disk. See [`docs/install-manifest.md`](../docs/install-manifest.md) for the full field reference and write-rail catalogue.
- **`.deft-version` is now a derivative.** The bare project-root file is regenerated from the manifest's `tag` field on every install / upgrade. Operators should NOT hand-edit it -- update the manifest and re-run `task upgrade`.
- **Doctor probe.** `task framework:doctor` adds four checks: `quick-start-resolves`, `skill-paths-resolve`, `manifest-agreement`, `install-path-consistency`. Three-state exit (0 clean / 1 drift / 2 config error). The probe is read-only -- it NEVER mutates state. Mutation belongs to `task upgrade`.
- **Upgrade-gate advisory.** `_check_upgrade_gate` runs the doctor probe in lazy-import mode after the install-layout prompt and emits a one-line advisory on positive drift. Informational only; never sets `needs_prompt` and never blocks the gate.
- **Managed-section marker v2 -> v3.** Refreshed AGENTS.md files carry a v3 marker (`<!-- deft:managed-section v3 sha=<framework-sha> refreshed=<iso> session=<id> -->`) with refresh-time provenance. The v2 form is parsed for one release cycle (v0.28 only; v0.29 deprecates v2) and forces a refresh-to-v3 on the next `task upgrade` / `run agents:refresh` invocation. Session-boundary detection: when `DEFT_SESSION_ID` is set AND matches the embedded `session=` token, the gate emits a warn telling the operator to start a new session before re-running the refresh (#1046 finding #6 -- prevents Case G no-op re-entry within the same session).

### What `task framework:doctor` does NOT do

- ⊗ It does NOT mutate any filesystem state during detection or emission.
- ⊗ It does NOT block the CLI invocation it fires alongside; the gate stays exit-0 for manifest drift (mirrors the #801 remote-version probe's informational-only contract).
- ⊗ It does NOT auto-rewrite the manifest -- writing belongs to `task upgrade` / `run install` / `oz-agent-upgrade`.
- ⊗ It does NOT call `read_yn` / interactive confirm helpers; the advisory is a one-line warn, not a prompt.

### Rollback

The transition is one-way -- v0.28 has no shim back to the bare-only marker. To revert to v0.27.x behaviour, pin the framework to a v0.27.x tag and delete `<install>/VERSION`. The bare `.deft-version` survives the rollback and is read by the v0.27 upgrade gate verbatim.

### References

- [#1046](https://github.com/deftai/directive/issues/1046) -- install / refresh contract umbrella (PR-B AC-3 + AC-4 + AC-5 ship the doctor, manifest, and v3 sentinel respectively).
- [#992](https://github.com/deftai/directive/issues/992) -- canonical install layout (`.deft/core/`) -- the install root this manifest is anchored to.
- [#410](https://github.com/deftai/directive/issues/410) -- original upgrade gate + `.deft-version` marker (predecessor surface).
- [`docs/install-manifest.md`](../docs/install-manifest.md) -- canonical manifest field reference + write-rail catalogue.
- [`scripts/framework_doctor.py`](../scripts/doctor.py) -- doctor probe source (PR-B AC-3).
- [`tasks/framework.yml`](../tasks/framework.yml) -- `task framework:doctor` Taskfile fragment.

---
<!-- 1046-prb: From v0.27.x -> v0.28 install-manifest transition END -->

<!-- 1061: AGENTS.md drift repair via task upgrade BEGIN -->
## From drifted AGENTS.md -> current install (`task upgrade` repair path, #1061)

> **Consolidation note (#2064):** `deft install-upgrade` and its `task upgrade` maintainer alias now delegate to the single canonical `deft update` path (see [Canonical upgrade — npm](#canonical-upgrade--npm-v0551)). The legacy `.deft/VERSION` retirement described below (backed up as `.deft/VERSION.premigrate`) is folded into `deft update`, so the drift-repair steps here still apply verbatim — the doctor now names `deft update` as the fix.

- **Applies when:** `task framework:doctor` reports drift on any of the four checks (`quick-start-resolves`, `skill-paths-resolve`, `manifest-agreement`, `install-path-consistency`). Common causes: a canonical-reinstall over a pre-v0.27 AGENTS.md (the #1060 recurrence pattern), a marker-version mismatch where AGENTS.md still carries the v1 / v2 managed-section sentinel after a framework bump, or an install-path-consistency mismatch detected via the new `install_root` manifest field that #1062 added to `<install>/VERSION` (the doctor reads the manifest's `install_root` first, then falls back to the AGENTS.md install-root parse, and FAILs when the resolved directory does not exist on disk).
- **Safe to auto-run:** Yes. `task upgrade` is the canonical user-facing entrypoint added in #1061; it wraps `run upgrade` and is idempotent on re-run (a second invocation against a current manifest + AGENTS.md is a no-op). The wrapper: (1) re-pulls the framework version marker by writing / refreshing `.deft-version`; (2) re-writes the canonical install manifest at `<install>/VERSION` (`ref` / `sha` / `tag` / `install_root` / `fetched_at` / `fetched_by`); (3) refreshes AGENTS.md to the current marker version (v3 sentinel with sha / refreshed / session attributes) via `cmd_agents_refresh`. Pre-v0.27 AGENTS.md files (no managed-section markers, or v1 markers) are migrated in place: content above and below the bracketed block is preserved verbatim, only the framework-owned managed section is rewritten.
- **Restart required:** Recommended. The agent's current session may still hold stale AGENTS.md / skill references from the pre-upgrade marker. After `task upgrade` completes, start a new agent session so the refreshed prose loads from a clean context.
- **Commands:**
  - `task framework:doctor` -- read the four-check report; identify which checks FAIL and which command the doctor recommends.
  - `task framework:doctor -- --json` -- machine-readable form; per-check `data.suggested_fix` field (added in #1061) carries the named command the doctor recommends for each failure.
  - `task upgrade` -- canonical drift repair (wraps `run upgrade`; rewrites manifest + .deft-version + AGENTS.md managed section). Use this when the framework on disk is correct and AGENTS.md / the manifest is out of date.
  - `.deft/core/run agents:refresh` (Unix) / `.deft\core\run agents:refresh` (Windows) -- AGENTS.md-only refresh; useful when `task upgrade` is not available (e.g. the consumer project has no Taskfile) or when only the managed-section block needs rewriting.
  - `task relocate:relocate -- --confirm` -- use this ONLY when the framework needs to move to a different on-disk path (rare; the doctor's `install-path-consistency` FAIL is the only check that recommends this). The doubled-namespace form (`relocate:relocate`) is the canonical go-task target name because the include namespace `relocate:` and the inner task `relocate:` carry the same key in `tasks/relocate.yml` (no root-level alias exists today, unlike the `install:install` / `install:upgrade` shortcuts wired in `Taskfile.yml`).

### AGENTS.md drift symptoms and detection

The doctor surfaces AGENTS.md drift across two complementary axes:

1. **Mismatched marker version.** When `cmd/deft-install/setup.go::WriteAgentsMD` detects a pre-v0.27 sentinel in the existing AGENTS.md, it skips rewriting the deft entry (treating the legacy sentinel as evidence the entry is already present). On a canonical reinstall over such a file, the AGENTS.md keeps its pre-v0.27 prose while the on-disk framework has migrated to `.deft/core/`. Symptom: `quick-start-resolves` and `skill-paths-resolve` FAIL because the paths AGENTS.md references no longer match the on-disk layout. Repair: `task upgrade` (or `.deft/core/run agents:refresh` if a Taskfile is not available).
2. **Install-path mismatch via the manifest's `install_root` field (#1062).** The doctor's `install-path-consistency` check reads `<install>/VERSION` for the `install_root` field first; when present, it uses that as the authoritative install-layout source (the field was added in #1062 as the single source of truth for the install-layout contract). When the field is absent (pre-v0.29 manifests), the doctor falls back to parsing the install root out of AGENTS.md and surfaces an INFO note in the check `detail` so operators can see when the legacy parse was taken. FAIL fires when the resolved install root does not exist as a directory on disk -- e.g. AGENTS.md / the manifest claims `.deft/core` but only `deft/` exists. Repair: `task upgrade` to rewrite the manifest + AGENTS.md to match the on-disk framework, OR `task relocate:relocate -- --confirm` to move the framework to the path AGENTS.md / the manifest claims (pick the relocate only when AGENTS.md is the correct source of truth).

### What to do if the doctor's failure prose looks wrong

The doctor's FAIL `detail` strings name the exact commands the operator should run. If a recommendation looks wrong (the named command does not exist, or the recommendation does not match the failure mode), this is a regression in the failure prose itself -- the prose-regression test at `tests/cli/test_framework_doctor_prose.py` (added in #1061) asserts every command string surfaced in FAIL details either exists as a Taskfile target or matches a documented `run` subcommand. File a new issue against [`deftai/directive`](https://github.com/deftai/directive/issues/new) with:

- The full `task framework:doctor -- --json` output (the `checks[].detail` fields carry the prose; the `data.suggested_fix` / `data.suggested_fix_alt` fields carry the structured recommendation).
- The on-disk state that produced the FAIL (`ls -la .deft/core/`, `cat .deft/core/VERSION` if present, `cat AGENTS.md` -- redact any consumer-private content above / below the managed-section markers first).
- A reference to the originating issue [#1061](https://github.com/deftai/directive/issues/1061) so the maintainer can chain the regression back to the prose contract.

### References

- [#1061](https://github.com/deftai/directive/issues/1061) -- doctor failure prose sharpening + `task upgrade` wrapper + this UPGRADING.md section.
- [#1060](https://github.com/deftai/directive/issues/1060) -- canonical-reinstall-over-pre-v0.27-AGENTS.md root cause that motivates the repair path.
- [#1062](https://github.com/deftai/directive/issues/1062) -- `install_root` manifest field consumed by the doctor's `install-path-consistency` check.
- [`scripts/framework_doctor.py`](../scripts/doctor.py) -- doctor probe source (FAIL `detail` strings + `suggested_fix` data field).
- [`tasks/install.yml`](../tasks/install.yml) -- `task install:upgrade` wrapper definition.
- [`Taskfile.yml`](../Taskfile.yml) -- root-level `task upgrade` alias for the wrapper.

---
<!-- 1061: AGENTS.md drift repair via task upgrade END -->

<!-- 992-pr3: From deft/ -> .deft/core/ migration BEGIN -->
## From deft/ -> .deft/core/

- **Applies when:** `.deft/core/run gate` reports a non-A install layout state (`B`, `C`, or `D`) -- equivalently, the new `_check_upgrade_gate` install-layout auto-prompt fires `[deft] install layout state: <X> (<description>). Run .deft/core/run relocate to upgrade. (Y/n)` on every CLI invocation. The four states inspected by the detector are: **A** pure `deft/` (legacy install; AGENTS.md + framework agree at the legacy path -- working today, no action required), **B** pure `.deft/core/` (current installer / sync skill / oz output -- AGENTS.md may still say `deft/` and the contract diverges), **C** hybrid (both `deft/` and `.deft/core/` present -- agents follow whichever they read first), **D** AGENTS.md only (managed-section markers present but no framework directory -- partial install). State A is the only non-firing state in v0.27 -- a future cycle decides whether to deprecate the legacy path. (#992)
- **Safe to auto-run:** No -- the relocator is wipe-and-reinstall by design and operator consent is required at every gate-prompt invocation. The cmd_gate auto-prompt is purely informational: it asks `(Y/n)` as a visual consent affordance but the gate itself NEVER invokes `task relocate` automatically and NEVER mutates filesystem state. This mirrors the **#884 ghx-install consent gate** precedent (`task setup` prompts before invoking the upstream installer; the only non-interactive paths are explicit `--yes` or env-var opt-out). The relocator's own `task relocate` surface ALSO prompts `[y/N]` on bare invocation; pass `--confirm` to skip the prompt in scripted use, never as a default. The relocator writes a gzip snapshot tarball to `.deft-cache/relocate-snapshot-<UTC-timestamp>.tar.gz` BEFORE any wipe so a botched relocate is recoverable.
- **Restart required:** Yes -- the marker v1 -> v2 bump (PR1) intentionally fires `agents-md=stale` on every current install on the first `cmd_gate` invocation post-v0.27. After the relocator completes, AGENTS.md is re-rendered with the v2 managed-section markers; chase with a fresh agent session so the refreshed `AGENTS.md` (Implementation Intent Gate, Branch Policy Disclosure, Multi-agent orchestration discipline, etc.) loads from a clean context. Your current session still holds the pre-relocate `AGENTS.md` in memory; restarting closes that drift.
- **Commands:**
  - `task relocate -- --dry-run` (preview the planned wipe-and-reinstall; never writes; no consent prompt because no mutation)
  - `task relocate` (apply -- prompts `[y/N]` on bare invocation; writes gzip snapshot tarball to `.deft-cache/relocate-snapshot-<UTC-timestamp>.tar.gz` before any wipe; idempotent across states A/B/C/D/F)
  - `task relocate -- --confirm` (apply non-interactively -- scripted-use ONLY; the consent prompt is the default for a reason)
  - `task relocate -- --rollback` (extract the most recent snapshot back into project root if the relocate landed badly)
  - `task relocate -- --force` (override the pre-flight hard-fails for **customized framework dir** [preserved-files list printed] OR **active swarm** [`vbrief/active/*.vbrief.json` with `plan.status == "running"`]; required when either condition is detected)
  - `uv run python scripts/relocate.py --help` (full flag surface reference)

### Install-layout state classification

The gate-side detector inspects three filesystem facts at the consumer project root: presence of `deft/` (legacy framework dir), presence of `.deft/core/` (canonical framework dir), and presence of managed-section markers in `AGENTS.md`. The four states map onto those facts as follows:

- **State A** -- `deft/` present, `.deft/core/` absent. Legacy install. **No prompt fires.** Working today; relocate is OPTIONAL in v0.27. Operators on state A can keep their legacy install indefinitely or relocate proactively.
- **State B** -- `deft/` absent, `.deft/core/` present. Current installer / sync skill / oz output. **Prompt fires.** AGENTS.md may still reference `deft/` paths (pre-PR1 contract); the relocator re-renders AGENTS.md with the v2 markers and aligns the contract.
- **State C** -- both `deft/` AND `.deft/core/` present. Hybrid. **Prompt fires.** Agents follow whichever path they read first; the relocator wipes both and reinstalls into `.deft/core/` only (single-namespace contract per the v0.27 DesignChoice).
- **State D** -- neither directory present, AGENTS.md with managed markers present. Partial install. **Prompt fires.** Typically a cancelled / interrupted install; the relocator does a fresh canonical install into `.deft/core/`.

### What the relocator does

`task relocate` runs `scripts/relocate.py` (PR2). The implementation is wipe-and-reinstall by design: one idempotent code path across states A/B/C/D/F that enforces the canonical `.deft/core/` namespace contract from #11 (read-only packaged assets), has a trivial test surface (state matrix x relocator -> assert end state), catches stale framework versions for free (state B benefits even though no path move is needed), and aligns with the npm rail packaging semantics that #11 ships. Per phase, the relocator:

1. **Pre-flight gates** -- hard-fails without `--force` when the framework dir is git-tracked + customized (preserved-files list printed) OR any `vbrief/active/*.vbrief.json` has `plan.status == "running"` (active swarm).
2. **Snapshot** -- writes a gzip tarball to `.deft-cache/relocate-snapshot-<UTC-timestamp>.tar.gz` covering `deft/` + `.deft/core/` + `AGENTS.md` so the operation is reversible via `task relocate -- --rollback`.
3. **Wipe** -- removes both `deft/` (if present) and `.deft/core/` (if present) -- the operation is contractually idempotent across source states.
4. **Reinstall** -- copies the framework source into `.deft/core/`. The bootstrap path fetches a fresh framework copy to a temp dir and runs the relocator FROM that copy, so the in-place framework about to be wiped never executes its own wipe (BOOTSTRAP NEVER SELF-DESTRUCTIVE).
5. **AGENTS.md re-render** -- bumps the managed-section bytes to the v2 marker contract using the `_wrap_legacy_in_markers` semantics from `run` (#794) so consumer notes outside the bracketed region survive verbatim.
6. **`.gitignore` update** -- ensures `.deft/core/` is gitignored by default per the #845 / `.deft-cache/` precedent (hidden-namespace contract).
7. **Advisory grep** -- scans consumer files OUTSIDE `.deft/core/` for legacy framework path references and prints findings (CI workflows, external scripts, dotfiles that hardcode the pre-v0.27 path). See `scripts/_relocate_states.py::advise_external_hardcodes()` for the exact search constant + grep semantics. The relocator NEVER auto-rewrites these -- CI / external tooling that hardcodes the legacy path is out of framework's control; the operator decides whether to update each surface.

### Snapshot rollback

A botched relocate is reversible:

```bash
task relocate -- --rollback
```

The rollback extracts the most recent `.deft-cache/relocate-snapshot-*.tar.gz` back into the project root. Snapshots are timestamped (UTC) so multiple back-to-back relocates each leave their own snapshot; the rollback always picks the most recent. If you need to roll back further, extract the older snapshot manually with `tar -xzf .deft-cache/relocate-snapshot-<timestamp>.tar.gz -C <project_root>`.

The rollback restores **byte-equivalent pre-relocate state** for the four tracked paths (`deft/`, `.deft/core/`, `AGENTS.md`, `.gitignore`): captured paths are restored from the tarball; uncaptured tracked paths (relocator-created `.gitignore` when the project had none pre-relocate) are removed so `git status --porcelain` is clean post-rollback. The `.deft-cache/` directory is intentionally outside the byte-equivalent contract because it hosts the snapshot tarball and the relocator's working state -- removing it would break re-rollback against the same snapshot. (F3 #1015)

### Manual edits required after relocate (above-marker prose)

The relocator preserves consumer-authored prose ABOVE the AGENTS.md managed-section markers verbatim per the [#794](https://github.com/deftai/directive/issues/794) `_wrap_legacy_in_markers` contract -- this is by design so hand-rolled notes survive the migration. As a consequence, **legacy `deft/run` references the consumer wrote into their own AGENTS.md (or other consumer-owned files outside `.deft/core/`) survive the relocate verbatim**. The relocator's advisory grep flags these as fix-manually hits at the end of the run; the operator decides whether to update each surface.

The relocator does NOT auto-rewrite consumer-owned files (the canonical reason: external CI workflows, dotfiles, and tooling outside the framework's control may also hardcode the legacy path -- the framework cannot mechanically distinguish a benign reference from a load-bearing one). After the relocate, scan the advisory grep output and update each occurrence by hand:

- `AGENTS.md` head/tail (above and below the managed-section markers) -- replace `deft/run` with `.deft/core/run` and `Full guidelines: deft/main.md` with `Full guidelines: .deft/core/main.md`.
- CI workflow files (`.github/workflows/*.yml`) -- replace any `deft/run <task>` invocations.
- Project scripts (`scripts/`, `Makefile`, `Taskfile.yml`, dotfiles) that hardcode the legacy path.
- README / docs / contributor-onboarding prose that points new contributors at `directive bootstrap` for first-time setup (replaces legacy `deft/run bootstrap` / `run project` / `run spec` shims).

The advisory grep output is the operator's worklist; treat it as a finite todo. Once every flagged occurrence is either updated to `.deft/core/run` or explicitly acknowledged as legacy-friendly redirect-stub content (e.g. the `skills/deft-{sync,setup,...}/SKILL.md` redirect stubs that intentionally retain `deft/run` per [#411](https://github.com/deftai/directive/issues/411)), commit the changes alongside the relocate. (F1 #1015)

### What the cmd_gate auto-prompt does NOT do

The gate-side prompt is informational only:

- ⊗ It does NOT invoke `task relocate` automatically; the operator runs the command on consent.
- ⊗ It does NOT mutate any filesystem state during detection or emission.
- ⊗ It does NOT block the CLI invocation it fires alongside; the gate stays exit-0 for layout drift (mirrors the #801 remote-version probe's informational-only contract).
- ⊗ It does NOT call `read_yn` / interactive confirm helpers; the `(Y/n)` suffix is purely a visual consent affordance.

The operator-consent contract is identical to the #884 `task setup` ghx-install consent gate: detection signals that work needs doing; the operator authorizes the work explicitly.

### References

- [#992](https://github.com/deftai/directive/issues/992) -- adopt `.deft/core/` as canonical install layout (parent issue).
- [#11](https://github.com/deftai/directive/issues/11) -- origin of the `.deft/core/` layout choice (read-only packaged assets contract).
- [#768](https://github.com/deftai/directive/issues/768) -- universal upgrade gate + AGENTS.md managed-section markers (PR1 bumps the marker from v1 to v2).
- [#794](https://github.com/deftai/directive/issues/794) -- pre-#768 AGENTS.md legacy migration (`_wrap_legacy_in_markers` reused by the relocator's AGENTS.md re-render path).
- [#884](https://github.com/deftai/directive/issues/884) -- `task setup` ghx-install consent gate (operator-consent precedent).
- [`scripts/relocate.py`](../scripts/relocate.py) -- relocator source (PR2).
- [`scripts/_relocate_states.py`](../scripts/_relocate_states.py) -- state classifier shared with cmd_gate.
- [`tasks/relocate.yml`](../tasks/relocate.yml) -- `task relocate` Taskfile fragment.
- [`tests/cmd_gate/test_state_detection.py`](../tests/cmd_gate/test_state_detection.py) -- gate-side state-detector + auto-prompt regression coverage (PR3).

---
<!-- 992-pr3: From deft/ -> .deft/core/ migration END -->

<!-- 1143: From v0.26.x -> v0.27 triage adoption ritual BEGIN -->
## From v0.26.x -> v0.27 (triage adoption via `task triage:welcome`)

- **Applies when:** any project on deft v0.26.0 or later that has not yet run the v0.27 triage adoption ritual. Detection: `vbrief/PROJECT-DEFINITION.vbrief.json` has neither `plan.policy.triageScope` nor `plan.policy.wipCap` set, OR `.deft-cache/github-issue/` is absent / empty. The v0.27 cycle introduced 16+ new `task triage:*` / `task scope:*` verbs (the #1119 governance swarm: D1/#1121, D2/#1122, D5/#1127, D6/#1130, D10/#1129, D11/#1128, D12/#1131, plus the network children N9/#1149 + N3/#1143); without a chained command, operators had to learn each verb individually from the v0.27 release notes.
- **Safe to auto-run:** Yes (interactive). `task triage:welcome` (#1143 / N3) is the single chained command for the v0.27 cycle's onboarding. The ritual is idempotent and detection-bound -- each phase emits an informational stderr line and skips when its precondition is already satisfied, so a re-run after a partial completion resumes cleanly without redoing work. The two destructive phases (subscription / `wipCap` writes to `PROJECT-DEFINITION`, plus the optional WIP-relief `task scope:demote --batch` invocation) are gated by numbered-menu prompts per [`contracts/deterministic-questions.md`](./contracts/deterministic-questions.md) (`Discuss` and `Back` are the canonical final two options); the relief preview is always shown before any real demote, and the operator must explicitly confirm before the relief runs.
- **Restart required:** No -- the ritual writes typed flags on `PROJECT-DEFINITION` and runs subprocess hops into existing verbs; no `AGENTS.md` rewrite is involved (N9 / #1149 owns the v0.27 AGENTS.md updates and already landed).
- **Commands:**
  - `task triage:welcome` -- run the 6-phase ritual (detect prior state, prompt subscription scope, run `task triage:bootstrap`, prompt `wipCap`, offer WIP relief if needed, print `task triage:summary` + pointer to `skills/deft-directive-triage/SKILL.md`).
  - `task triage:welcome -- --no-subprocess` -- test-mode flag that suppresses the bootstrap / scope:demote / triage:summary subprocess hops; never set in production runs.

### What the ritual does

Six phases, each detection-bound so a partial re-run resumes cleanly:

1. **Detect prior state.** Reads `plan.policy.triageScope[]` and `plan.policy.wipCap` from `vbrief/PROJECT-DEFINITION.vbrief.json`; walks `.deft-cache/<source>/<owner>/<repo>/` for cache entries; counts vBRIEFs in `vbrief/pending/ + vbrief/active/`. Pure -- no writes.
2. **Prompt subscription scope.** Numbered menu over three presets: **Small** (`all-open` -- recommended for repos <200 open issues), **Mid** (curated `labels` rule + `opened-since 60d` -- recommended 200-2000), **Mega** (`explicit-watch` + `referenced-by-vbrief` -- recommended 2000+). Default = Mid. Writes the typed array via the D12 / #1131 surface (`scripts/triage_scope.py::validate_scope_rules` is consulted for schema validation before the write commits). Skipped when already set.
3. **Run `task triage:bootstrap`.** Subprocess hop into the existing D10 (#1129) / cache (#883) bootstrap. The D10 auto-classify pass runs on by default per its acceptance criteria. Skipped when the cache is already populated.
4. **Prompt `wipCap`.** Numbered menu (8 small team / 10 default / 15 large team / custom). Default = **10** per umbrella #1119 Current Shape v3 (NOT 12 from older issue-body wording). Writes `plan.policy.wipCap` via the hand-rolled typed-flag writer that mirrors `scripts/policy.py::set_policy`; once D4 (#1124) lands its dedicated `policy_set.py wip-cap` subcommand the writer body becomes a thin delegation. Skipped when already set.
5. **Offer WIP relief.** When `vbrief/pending/ + vbrief/active/` exceeds the chosen cap, preview the planned `task scope:demote -- --batch --older-than-days 30` (#1121 / D1) invocation: count + name the eligible vBRIEFs, show ineligibles. The relief is opt-in -- the operator must answer `y` to the explicit confirmation prompt (default `[y/N]`) before the real demote runs. Declining leaves the cap over by the existing delta and the ritual proceeds.
6. **Final summary.** Emits `task triage:summary` (#1122 / D2) and points the operator at `skills/deft-directive-triage/SKILL.md` (#1130 / D6) for the next step.

### Audit trail

Every policy write (Phase 2 / Phase 4) appends an entry to `meta/policy-changes.log` with `actor=triage-welcome`, the field name, the new value, the previous value, and a `changed=true|false` token. This mirrors the existing `scripts/policy.py::set_policy` audit format so `git grep triage-welcome meta/policy-changes.log` surfaces every ritual run.

### References

- [#1143](https://github.com/deftai/directive/issues/1143) -- N3: `task triage:welcome` 6-phase onboarding ritual (this section).
- [#1119](https://github.com/deftai/directive/issues/1119) -- umbrella: triage-eval governance swarm.
- [#1131](https://github.com/deftai/directive/issues/1131) -- D12: typed `plan.policy.triageScope[]` subscription surface (Phase 2 writes).
- [#1124](https://github.com/deftai/directive/issues/1124) -- D4: typed `plan.policy.wipCap` (Phase 4 writes; the ritual hand-rolls until D4 ships its writer subcommand).
- [#1121](https://github.com/deftai/directive/issues/1121) -- D1: `task scope:demote --batch` (Phase 5 relief invocation).
- [#1122](https://github.com/deftai/directive/issues/1122) -- D2: `task triage:summary` (Phase 6 final-state emission).
- [#1129](https://github.com/deftai/directive/issues/1129) -- D10: triage auto-classification (consumed inside Phase 3).
- [#1130](https://github.com/deftai/directive/issues/1130) -- D6: triage skill pointer (Phase 6 forward-pointer).
- [#1149](https://github.com/deftai/directive/issues/1149) -- N9: `welcome` / `onboard triage` / `triage setup` skill-routing entry in AGENTS.md (already landed).
- [`contracts/deterministic-questions.md`](./contracts/deterministic-questions.md) -- numbered-menu contract every prompt follows.
- [`scripts/triage_welcome.py`](../scripts/triage_welcome.py) -- ritual entry point.
- [`tasks/triage-welcome.yml`](../tasks/triage-welcome.yml) -- `task triage:welcome` Taskfile fragment.

---
<!-- 1143: From v0.26.x -> v0.27 triage adoption ritual END -->

<!-- 883-story-4: v0.25.x -> v0.26.0 migration BEGIN -->
## From v0.25.x → v0.26.0 (deft-cache unified layer; breaking)

- **Applies when:** any project on deft v0.25.0, v0.25.1, or v0.25.2 that has run `task triage:bootstrap` (i.e. has a populated `.deft-cache/issues/<owner>-<repo>/<N>.{json,md}` flat-sidecar layout). Detection: `Test-Path .deft-cache/issues/` returns `True` AND `Test-Path .deft-cache/github-issue/` returns `False`. Pure-additive opt-out projects (no `.deft-cache/`) skip this section -- they pick up the v0.26.0 surface on first `task triage:bootstrap`.
- **Safe to auto-run:** No. The on-disk layout changed; the legacy `.deft-cache/issues/` tree is NOT migrated in place. Operators MUST delete the legacy tree and re-populate via `task cache:fetch-all` (one-shot; mirrors the v0.25.x bootstrap-populate timing). The audit log at `vbrief/.eval/candidates.jsonl` is preserved verbatim across the migration -- accept/reject/defer history is untouched.
- **Restart required:** Yes. The agent's current session still holds stale skill prose pointing at `task triage:cache` / `task triage:show`. After the cache re-populate completes, start a new agent session so the refreshed `skills/deft-directive-refinement/SKILL.md` Phase 0 (rebound onto `cache:*`) loads from a clean context.
- **Commands:**
  - `Remove-Item -Recurse -Force .deft-cache/issues/` (PowerShell) or `rm -rf .deft-cache/issues/` (bash) -- drop the legacy flat-sidecar layout.
  - `task cache:fetch-all -- --source=github-issue --repo=OWNER/NAME` -- re-populate under the new `.deft-cache/<source>/<key>/{raw.json,content.md,meta.json}` layout (~5 min for a ~200-issue corpus; idempotent on re-run via TTL skip-fresh).
  - `task cache:get -- github-issue <owner>/<repo>/<N>` -- per-issue read replacing the removed `task triage:show <N>` form.
  - `task triage:bootstrap` -- still works; now delegates to `cache:fetch-all` end-to-end.

### Surface changes

- **`task triage:cache` REMOVED.** Replaced by `task cache:fetch-all --source=github-issue --repo=OWNER/NAME`. The unified surface is the canonical entry point for all cache populates (github-issue today; URL / email / file deferred to v2).
- **`task triage:show` REMOVED.** Replaced by `task cache:get github-issue <owner>/<repo>/<N>`. Returns the schema-validated `meta.json` envelope plus the path to `content.md` (or a structured stale-with-flag response when `expires_at` has elapsed; pass `--no-stale` to fail closed instead).
- **On-disk layout changed.** Old: `.deft-cache/issues/<owner>-<repo>/<N>.{json,md}` (flat sidecar). New: `.deft-cache/<source>/<key>/{raw.json,content.md,meta.json}` (per-entry directory; schema-validated meta envelope). `cache:get` validates `meta.json` against `vbrief/schemas/cache-meta.schema.json` on every read so a corrupt or version-incompatible file fails closed.
- **Audit log UNCHANGED.** `vbrief/.eval/candidates.jsonl` preserves accept / reject / defer / needs-ac / mark-duplicate / reset records across the migration. The Story 3 Tier-2 short-circuit (terminal-decision skip on bulk-* re-runs) operates on the same file.
- **All other `triage:*` actions UNCHANGED.** `triage:accept` / `triage:reject` / `triage:defer` / `triage:needs-ac` / `triage:mark-duplicate` / `triage:bulk-accept` / `triage:bulk-reject` / `triage:bulk-defer` / `triage:bulk-needs-ac` / `triage:status` / `triage:reset` / `triage:history` / `triage:refresh-active` keep their v0.25.x surface byte-for-byte (13 aliases). The rebind onto `cache:get` is internal. `triage:bootstrap` keeps its v0.25.x command surface but its on-disk output is the new `.deft-cache/<source>/<key>/` per-entry layout (now delegates to `cache:fetch-all`); see the Commands list above.

### Rollback

The migration is one-way; v0.26.0 ships no shim back to the flat-sidecar layout. To revert to v0.25.2 behaviour, pin `deft/` to the v0.25.2 tag, delete `.deft-cache/`, and re-run `task triage:bootstrap` against the v0.25.2 surface. The audit log at `vbrief/.eval/candidates.jsonl` is forward / backward compatible -- v0.25.x and v0.26.0 read the same JSONL schema.

### References

- [#883](https://github.com/deftai/directive/issues/883) -- deft-cache unified content cache + quarantine epic (this migration is the v1 cutover).
- [`vbrief/schemas/cache-meta.schema.json`](./vbrief/schemas/cache-meta.schema.json) -- frozen JSON Schema 2020-12 contract for `meta.json` (validated on read AND write).
- [`docs/quarantine-spec.md`](../docs/quarantine-spec.md) -- formal spec for the #583 injection-quarantine algorithm consumed by `cache:put`.
- [`docs/privacy-nfr.md`](../docs/privacy-nfr.md) -- privacy contract for `.deft-cache/` (gitignore default; opt-in commit path; private-repo body treatment).

---
<!-- 883-story-4: v0.25.x -> v0.26.0 migration END -->


## Migration to triage v1

- **Applies when:** any project on deft v0.24.0 or later that wants to opt in to the pre-ingest triage workflow (#845). Triage v1 is **purely additive** -- existing skills (`deft-directive-refinement`, `deft-directive-swarm`, `deft-directive-build`, etc.) keep working byte-identically when the triage surfaces are absent. Detection: run `task triage:bootstrap` and observe whether `.deft-cache/` exists at the project root. If not, you have not opted in yet.
- **Safe to auto-run:** Yes. `task triage:bootstrap` is idempotent and reversible -- a second run is a no-op, and the entire opt-in can be undone by deleting `.deft-cache/` and removing the `.deft-cache/` line from `.gitignore`. The bootstrap performs five steps: (1) populate the local issue cache for all open upstream issues; (2) backfill `vbrief/.eval/candidates.jsonl` with `accepted` audit entries for items already in `vbrief/proposed/`, `vbrief/pending/`, or `vbrief/active/` (preserves audit trail; intentionally skips `vbrief/cancelled/` to avoid reanimating rejected items); (3) add `.deft-cache/` to `.gitignore` if absent; (4) install `gitcrawl` if missing (skipped if already on PATH); (5) print a recap of the actions taken.
- **Restart required:** No. Triage v1 is a new opt-in surface; existing agent sessions continue to work without any awareness of the cache. Future sessions will see the new `task triage:*` targets in `task --list` once the parent `Taskfile.yml` `includes:` block resolves the four fragment files.
- **Commands:**
  - `task triage:bootstrap` (one-time install, ~5 min for ~200 open issues -- mostly the cache populate step). The `triage:bootstrap` colon-form is wired as a top-level alias by Story 6 and works immediately after this PR merges.
  - The remaining commands ship as **namespaced** targets via the parent Taskfile `includes:` block. Use the `<namespace>:<task>` form against the include key:
    - `task triage-cache:cache` / `task triage-cache:show <N>` (Story 1)
    - `task triage-actions:accept <N>` / `task triage-actions:reject <N> -- --reason <r>` / `task triage-actions:defer <N>` / `task triage-actions:needs-ac <N>` / `task triage-actions:status <N>` / `task triage-actions:history <N>` (Story 3)
    - `task triage-bulk:bulk-accept` / `task triage-bulk:bulk-reject` / `task triage-bulk:refresh-active` etc. with `--label` / `--author` / `--age-days` filters (Story 4)
  - The shorthand `task triage:cache` / `task triage:accept <N>` / etc. forms are intentionally NOT wired in Story 6 because go-task v3 cannot share an `includes:` namespace key across multiple files; consolidating top-level aliases into a single `triage:*` surface is tracked as a follow-up cleanup PR after the four-fragment cascade has fully landed and the inner task names are stable on master. Use the namespaced forms above until that follow-up ships.

### What changes for consumers

- **Additive nature.** Nothing existing breaks. The refinement skill's Phase 0 (Story 5) auto-skips when the cache is empty, so a consumer who never runs `task triage:bootstrap` sees the same v0.24.0 refinement experience.
- **Opt-in path is fast.** `task triage:bootstrap` finishes in ~5 minutes for a ~200-issue corpus. Larger corpora scale linearly with `gh issue list` throughput. The bootstrap is interruptible -- a Ctrl-C mid-populate leaves `.deft-cache/` in a partial state that the next run completes idempotently.
- **Gitignore default.** `.deft-cache/` is gitignored by default. The bootstrap step (3) ensures the line is present. See [docs/privacy-nfr.md](../docs/privacy-nfr.md) for the privacy contract that motivates the default.
- **Opt-in commit-cache contract.** Consumers who want to commit the cache for shared-cache scenarios MUST manually edit `.gitignore` to comment out the `.deft-cache/` line. Deft tooling will not perform this edit automatically -- the manual step is the deliberate-action gate. See `NFR-2` in [docs/privacy-nfr.md](../docs/privacy-nfr.md).
- **Quarantine on the cache write path.** Cached issue bodies are passed through `quarantine_body` (Story 1) before being written to `.deft-cache/issues/<owner>-<repo>/<N>.md`. Headings whose text matches imperative tokens (`STEP`, `TASK:`, `IMPORTANT:`, etc.) are wrapped in fenced code blocks with the `quarantined` info string so downstream LLM consumers can treat the enclosed bytes as untrusted user input. See [docs/quarantine-spec.md](../docs/quarantine-spec.md) for the full algorithm + escape-hatch overrides.
- **Private-repo body content.** Bodies from private repos are stored verbatim on the local filesystem under `.deft-cache/`. The framework never transmits cache contents externally. Operators in regulated environments should review NFR-3, NFR-4, NFR-5 in `docs/privacy-nfr.md`.

### Rollback

The entire triage v1 opt-in is reversible:

```bash
rm -rf .deft-cache/
# remove the `.deft-cache/` line from .gitignore
rm -rf vbrief/.eval/candidates.jsonl
```

This returns the project to its pre-bootstrap state. Existing scope vBRIEFs in `vbrief/proposed/` / `vbrief/pending/` / `vbrief/active/` are untouched -- the audit log only tracks decisions, not the vBRIEFs themselves.

### References

- [`docs/quarantine-spec.md`](../docs/quarantine-spec.md) -- formal spec for the #583 injection-quarantine algorithm consumed by Story 1's cache writer.
- [`docs/privacy-nfr.md`](../docs/privacy-nfr.md) -- privacy contract for `.deft-cache/` (gitignore default, opt-in commit path, private-repo body treatment).
- [#845](https://github.com/deftai/directive/issues/845) -- pre-ingest triage workflow umbrella.
- [#583](https://github.com/deftai/directive/issues/583) -- original injection-quarantine specification.

---

## From pre-#768 AGENTS.md → managed-section AGENTS.md

- **Applies when:** `./AGENTS.md` exists at your project root AND does **not** contain the `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->` sentinel markers. This is the canonical pre-#768 state -- the file pre-dates the Deft-managed-section contract added in v0.20.0 (#768) -- and is reported as `agents-md=missing` by `.deft/core/run gate`. (Distinct from `agents-md=absent`, which means no `AGENTS.md` exists at all.)
- **Safe to auto-run:** Yes. `.deft/core/run agents:refresh` performs a **one-time legacy migration**: your existing `AGENTS.md` content is preserved verbatim ABOVE the rendered managed-section block (separated by one blank line). The framework only ever owns the bytes between the two sentinel markers; content outside that bracketed region is never modified. Run `.deft/core/run agents:refresh --dry-run` first to preview the planned change, or `.deft/core/run agents:refresh --check` to interrogate the current state without writing.
- **Restart required:** Yes -- after the managed section is appended, the agent's current session still holds the pre-#768 `AGENTS.md` in context. Start a new agent session so the refreshed `AGENTS.md` (Implementation Intent Gate, Branch Policy Disclosure, Pre-Cutover Check, etc.) is loaded from a clean context.
- **Commands:**
  - `python .deft/core/run agents:refresh --dry-run` (preview; never writes)
  - `python .deft/core/run agents:refresh` (apply -- one-time append for state=`missing`, byte-replace for state=`stale`, no-op for state=`current`, fresh write for state=`absent`)
  - `python .deft/core/run upgrade` (records the framework version in `vbrief/.deft-version` AND chains into `agents:refresh` -- equivalent end state to running both above)

### What `agents:refresh` does on a pre-#768 file

The gate (`.deft/core/run gate`) classifies every project's `AGENTS.md` into one of four states; pre-#768 files land in `missing`:

- `current` -- markers present and bracketed bytes match the rendered template. No-op.
- `stale` -- markers present but bracketed bytes have drifted from the rendered template. Byte-replace the bracketed region in place.
- `missing` -- file exists but no markers (pre-#768 legacy file). **One-time append** of the rendered managed section, preserving existing content verbatim above the markers.
- `absent` -- file does not exist. Create from the rendered template.

### Long-term contract: sentinel-only rewrite

After the one-time legacy migration, every subsequent `.deft/core/run agents:refresh` against the same project follows a **sentinel-only-rewrite** contract: the framework reads only the bytes between `<!-- deft:managed-section v1 -->` and `<!-- /deft:managed-section -->`, replaces them in place when the rendered template drifts (`stale` state), and never touches content above or below those markers. Hand-authored notes, custom rules, project-specific gates, and any text that lived in your `AGENTS.md` before the one-time append survive every future framework upgrade verbatim.

The contract is byte-stable by construction:

- `agents:refresh --check` exits 0 only when the bracketed bytes match the rendered template byte-for-byte; this is the regression guard against silent drift.
- The bracketed region is the SOLE byte sequence the framework owns. Edits inside the markers are not preserved across upgrades; edit the consumer-section above or below the markers instead.
- The migration is idempotent: re-running `.deft/core/run agents:refresh` against an already-migrated file is a no-op.

### References

- [`templates/agents-entry.md`](./templates/agents-entry.md) -- the canonical rendered managed-section template; this is the source of the bytes that `.deft/core/run agents:refresh` writes between the sentinel markers.
- [`QUICK-START.md`](./QUICK-START.md) Case G -- agent-prescriptive coverage of the same scenario for agents that read `QUICK-START.md` (rather than invoking `.deft/core/run agents:refresh` directly).
- [#768](https://github.com/deftai/directive/issues/768) -- the universal upgrade gate that introduced the managed-section markers and the `agents:refresh` reference implementation.

---

## From any pre-v0.20 version → v0.20.0 (historical; use frozen path)

> **Current releases (#2068):** follow [Frozen pre-v0.20 document-model migration](#frozen-pre-v020-document-model-migration-2068) instead of upgrading straight to latest npm. The section below documents what the v0.20 cutover changed; commands assume framework **v0.59.0** (or another pinned release that still ships `migrate_vbrief.py`).

- **Applies when:** `deft doctor` / `task migrate:preflight` reports pre-cutover state. Legacy `SPECIFICATION.md` / `PROJECT.md` without the `<!-- deft:deprecated-redirect -->` sentinel is the canonical signal.
- **Safe to auto-run:** No — `task migrate:vbrief` on the pinned release rewrites `SPECIFICATION.md` and `PROJECT.md` into deprecation-redirect stubs and creates lifecycle folders; review `--dry-run` first.
- **Restart required:** Yes — after migration completes, stop the session and start fresh so rewritten AGENTS.md and v0.20 skills load cleanly.
- **Commands (on pinned v0.59.0 payload):**
  - `task migrate:vbrief -- --dry-run` (preview)
  - `task migrate:vbrief` (apply)
  - `deft upgrade` or `task upgrade` (record framework version + refresh AGENTS.md managed section)
  - `task roadmap:render` / `task project:render` / `task prd:render -- --force` (regenerate exports)
  - `deft check` or `task check` (verify)

### Remote probe (#801)

- **Applies when:** the periodic remote-version probe (added in this section's source release) prints a `⚠ Upstream directive v<N> is available (you are on v<M>)` warn line below the existing recorded-vs-current banner, OR `task framework:check-updates` exits non-zero (status `BEHIND`).
- **Safe to auto-run:** Yes for the probe itself (read-only `git ls-remote --tags --refs <upstream>`, never mutates project state, throttled 24h per tag, opt-out via `DEFT_NO_NETWORK=1`). The remediation -- pulling the upstream submodule -- is NOT auto-run; the operator decides when to update.
- **Restart required:** No for the probe. Once you actually update the framework (refresh the `./deft` submodule), the standard "start a new agent session" rule from the recorded-vs-current upgrade flow applies.
- **Commands:**
  - `task framework:check-updates` (synchronous probe, exit 1 on BEHIND; pass `-- --force` to bypass the 24h throttle and `-- --json` for machine-parseable output)
  - `git submodule update --remote --merge deft && git add deft && git commit -m "chore(deft): bump submodule"` (canonical update path -- mirrors `skills/deft-directive-sync/SKILL.md` Phase 2)
  - `.deft/core/run upgrade` (after the bump, to record the new framework version in `vbrief/.deft-version` and refresh the AGENTS.md managed section)
  - `DEFT_NO_NETWORK=1 task <anything>` (CI / air-gapped opt-out: probe short-circuits before any subprocess call)

**What changed:** Deft moved from a flat document model (`SPECIFICATION.md`, `PROJECT.md`, `ROADMAP.md` as authoritative) to a **vBRIEF-centric model** with lifecycle folders. All skills were renamed from `deft-*` to `deft-directive-*`.

### One-paragraph summary

After you update `deft/` to v0.20.0, `vbrief/*.vbrief.json` files are the source of truth; the familiar `PRD.md`, `SPECIFICATION.md`, and `ROADMAP.md` are **rendered views** generated by `task *:render`. Scope vBRIEFs live in lifecycle folders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`). Every legacy skill path (`skills/deft-sync/`, `skills/deft-setup/`, …) now contains a small redirect stub pointing at `deft/QUICK-START.md`, which rewrites your stale `AGENTS.md` and runs migration. The deft framework itself detects the state and tells your agent what to do.

### Upgrade steps

1. **Update the framework.** Pick whichever matches how you installed deft:
   - **Submodule:** `cd deft && git fetch && git checkout v0.20.0 && cd ..` then `git add deft && git commit -m "chore(deft): bump to v0.20.0"`.
   - **Installer binary:** run the new installer against your existing project directory; it updates the clone and appends any new skill thin pointers idempotently.
   - **Direct clone:** `cd deft && git pull --rebase && git checkout v0.20.0`.
2. **Have your agent read `deft/QUICK-START.md` and follow it.** Example prompt: *"Read `deft/QUICK-START.md` and follow it."* QUICK-START detects your project state and refreshes `AGENTS.md` idempotently; if it needs to rewrite the Deft-managed section or run migration, it tells you and instructs your next step.
3. **Run migration** (if QUICK-START asks for it): `task migrate:vbrief`. See [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for a detailed walkthrough of what migration does and how to preserve existing content.
4. **Regenerate rendered exports.** v0.20.0's `task migrate:vbrief` does not yet auto-invoke the renderers at the end (tracked: [#630](https://github.com/deftai/directive/issues/630), slated for v0.21). Run them manually once after migration so `ROADMAP.md` and any pre-existing `PRD.md` reflect the migrated `vbrief/` source of truth:
   ```bash
   task roadmap:render
   task project:render        # refresh PROJECT-DEFINITION items registry
   task prd:render -- --force # only if you previously maintained a PRD.md
   # task spec:render         # optional; re-emits SPECIFICATION.md from narratives
   ```
   The `deft-directive-pre-pr` skill auto-renders `PRD.md` / `SPECIFICATION.md` at Phase 3b on every PR, so you only need to run these explicitly once post-migration. `ROADMAP.md` is not covered by Phase 3b auto-render.
5. **Record the framework version** so the CLI upgrade gate stops warning on every invocation: `.deft/core/run upgrade` writes `vbrief/.deft-version`.
6. **Start a new agent session.** Your current session still holds stale rules from the previous `AGENTS.md`. Close the tab / session and open a new one; the agent will read the refreshed `AGENTS.md` and v0.20 skills on its own.
7. **Verify.** Run `task check` -- the full pre-commit pipeline (fmt + lint + typecheck + tests + vbrief validation + link check) must be green. If `task vbrief:validate` warns about `SPECIFICATION.md` or `PROJECT.md`, the deprecation redirect stubs were not written correctly; re-run `task migrate:vbrief` or patch the stubs to include the `<!-- deft:deprecated-redirect -->` line on the first line.

### Upgrade safety

~ When running `task migrate:vbrief` against a non-trivial project for the first time, test it on a fork or a clean working copy before applying it to your primary checkout. The migration is designed to be idempotent and preserves existing narratives, but real-world repos vary -- exercising the migration once against a disposable copy lets you review the redirect stubs, lifecycle folder contents, and `task check` output before accepting the changes.

### What to expect

- Your `SPECIFICATION.md` and `PROJECT.md` are replaced with short redirect stubs containing `<!-- deft:deprecated-redirect -->` on the first line. Existing content is migrated into `vbrief/specification.vbrief.json` narratives + `vbrief/pending/` scope vBRIEFs + `vbrief/PROJECT-DEFINITION.vbrief.json` narratives. `ROADMAP.md` remains an **actively rendered view** (not a deprecation redirect) -- it is backed up to `ROADMAP.premigrate.md` and is regenerated by `task roadmap:render` from the migrated scope vBRIEFs in `vbrief/pending/` and `vbrief/completed/`.
- `.md` files continue to exist as **rendered views**, generated on demand via `task spec:render`, `task prd:render`, `task roadmap:render`. ⊗ Edit them directly — your changes are overwritten on the next render; edit the underlying `.vbrief.json` instead.
- Skills live under new `deft-directive-*` directory names. Legacy `skills/deft-*/SKILL.md` files contain small redirect stubs that point agents at `deft/QUICK-START.md`; they exist for one release cycle so v0.19 `AGENTS.md` files that still reference old paths keep working until you re-run QUICK-START.
- The CLI (`.deft/core/run`) now has a **non-fatal upgrade gate** (issue #410). After updating, the gate warns once per invocation until you run `.deft/core/run upgrade` or `task migrate:vbrief`. Interactive sessions get a `Continue anyway? [y/N]` prompt; non-interactive sessions (CI, cloud agents) warn and continue.
- **New `task issue:ingest`** (#454) -- materialise GitHub issues as scope vBRIEFs in `vbrief/proposed/` (single-issue mode `task issue:ingest -- <N>` or bulk `task issue:ingest -- --all [--label L] [--status S] [--dry-run]`). Deduplicates against existing origin-provenance references so the `task reconcile:issues` unlinked section stops growing monotonically post-GA.

### Troubleshooting

- **Agent says it can't find `deft/skills/deft-sync/SKILL.md`:** that is a stale v0.19 `AGENTS.md` path. Tell your agent: *"Read `deft/QUICK-START.md` and follow it."* If the dummy redirect stub is read, it also points at QUICK-START.md.
- **`task check` fails on `task vbrief:validate`:** typical causes are filename convention (must be `YYYY-MM-DD-<lowercase-slug>.vbrief.json`), folder/status mismatch (use `task scope:activate|complete|cancel|restore|block|unblock` to move files), or missing `overview` / `tech stack` narrative keys on `PROJECT-DEFINITION.vbrief.json`.
- **CLI keeps warning about version drift:** run `.deft/core/run upgrade` to record the current framework version in `vbrief/.deft-version`.
- **"My existing `AGENTS.md` additions got wiped":** QUICK-START refreshes only the Deft-managed section (bounded by the `deft/main.md` sentinel region). If you saw content outside that region change, please file an issue with `discovered-during-402` so we can tighten the detection.

### References

- [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) — detailed brownfield adoption / migration walkthrough.
- [QUICK-START.md](./QUICK-START.md) — agent-facing bootstrap + upgrade detection.
- [vbrief/vbrief.md](./vbrief/vbrief.md) — canonical vBRIEF file taxonomy.
- [glossary.md](./glossary.md) — canonical v0.20 vocabulary (Scope vBRIEF, lifecycle folder, canonical narrative keys, rendered export, source of truth, ...).
- [CHANGELOG.md](../CHANGELOG.md) — full v0.20.0 change list.

---

Future upgrade sections will be prepended here as new releases ship. Each section starts with `## From <prev> → <new>` and follows the same shape: summary, steps, expectations, troubleshooting, references.
