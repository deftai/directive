# Installer refactor — One Version Per Repo (OVPR)

Durable in-repo home for the #5490 / #5514 installer redesign that replaced the Go installer and copied `.deft/core` deposit with a thin global launcher + exact per-repo `@deftai/directive-runtime` pin.

## What lives here

| File | Kind | Use |
| --- | --- | --- |
| [install-ovpr-requirements.md](./install-ovpr-requirements.md) | **Active (normative)** | Full product requirements / ACs. Includes revisions **v261119** (hook locator from any subfolder or worktree; payload root is the Git checkout top), **v261118** (old projects keep working; one recovery table; `.prettierignore` hook line; named per-checkout ignore lines; `.deft/core` edit list; `deft-hook` blocking response; launcher entry order; old-repo message) and **v261027** (entry guards + host `.mjs` outer). Prefer this when changing install/upgrade/uninstall/repair/doctor/hook-deposit behavior. |
| [install-ovpr-architecture.md](./install-ovpr-architecture.md) | **Active (normative)** | Compact architecture map (packages, contract, setup/migrate, self-host, host-hook outer). |
| [LLM-CONTEXT.md](./LLM-CONTEXT.md) | **Harness primer (not ACs)** | AI-audience OVPR context: ownership boundary (polfer install vs Scott dispatcher), verb matrix, entry guards / `.mjs` outer, Dependabot+AC8.6, anti-rathole. Read before triage/plan/feature work that intersects install. |
| [install-ovpr-problem-ledger-2026-10-23.md](./install-ovpr-problem-ledger-2026-10-23.md) | **Decision record only** | Sealed 2026-10-23 FINALs for Problems 1–33 and ticket map. **Not requirements.** Points at requirements/architecture as SoT. |
| [install-ovpr-implementation-strategy.md](./install-ovpr-implementation-strategy.md) | **History** | How the work was delivered (YOLO train, sterile field, beta, master merge). Not an AC waiver. |
| [install-ovpr-human-test-plan.md](./install-ovpr-human-test-plan.md) | **Active** | HT-00–HT-17 cases and operator notes. |

## Authority split

1. **Product (what):** `install-ovpr-requirements.md` (from UNIFIED / #5490), including in-place revision tags such as **v261027**.
2. **Architecture (how pieces fit):** `install-ovpr-architecture.md` (same revision tags where applicable).
3. **Harness primer (AI context only):** `LLM-CONTEXT.md` — ownership boundary, anti-rathole, verb/entry-guard summary. **Never overrides** (1)/(2).
4. **Methodology (how we branched / published / self-hosted):** #5514 + the history file in this folder.
5. **Disposition history:** `install-ovpr-problem-ledger-2026-10-23.md` — why tickets were sealed; never overrides (1)/(2)/(3).
6. **Day-to-day consumer docs:** root `README.md`, `content/UPGRADING.md`, `docs/RELEASING.md`.

On conflict: **requirements win** for installer semantics; architecture explains shape; `LLM-CONTEXT.md`, the problem ledger, and implementation-strategy history never relax an AC.

### v261119 (2026-11-19)

Operator amendment: where a host runs hooks from the agent's current folder, the hook entry is a no-shell Node locator (`node -e <locator> -- <outer args>`). It walks up to the top of the Git checkout it is in, stops there, and runs that checkout's committed outer; no checkout exits as outside a repository (O-08); a checkout with no outer blocks with the install message. The payload's project root is the top of the Git checkout that contains the payload's working folder, never the nearest `package.json` (AC9.1, AC9.4). Fixes hooks run from a subfolder (#5959) and from Claude worktrees (#6594).

### v261118 (2026-11-18)

Operator amendment: old projects keep working until someone upgrades them. In a project that depends on a pre-split `@deftai/directive`, the launcher hands every call (except `upgrade`, `uninstall`, `--version`, `--help`) to the copy installed in that project's own `node_modules`; it never runs a global or different-version copy. With no project copy installed it stops with "This project uses an older version of Directive that isn't installed. Run `npm install` (or `pnpm install`) to keep using it, or run `directive upgrade` to update." A bare `deft-hook` call in a project that pins the runtime is out-of-date wiring that automatic setup rewrites (§A5.3, §A5.6, §A6.7, §A7 row 12, §A9, AC3.3, AC10.2, AC10.11, AC12.5, D4 rule 2; architecture "Legacy conversion"). This replaces the old-repo message and the 0.126.2 exception listed below.

Operator amendment: one recovery table (AC9.7). The project install (`npm install` / `pnpm install --frozen-lockfile`) for a missing or mismatched runtime; `directive install --repair` for wiring; `directive upgrade` for data and old layouts; `npm i -g @deftai/directive` only for a missing launcher. Does not change what any verb mutates. Implement via P4-U3a to P4-U3d.

Operator amendment: when a root `.prettierignore` already exists, setup adds one Directive-owned line, `**/deft-hook-*.mjs`, so the committed host hook files don't fail the project's formatter check (AC8.5, AC13.3, §A6.1, D4 rule 11).

Operator amendment: setup may add a short, named list of per-checkout runtime files to `.gitignore`, including `.deft/pre-pr-execution-private/` (a signing secret) and `.deft/orientation-state.json`. Uninstall keeps these lines while it keeps the files (AC8.5, AC13.3, §A6.1, §A7 row 13, §A9, INIT-12, D4 rule 11).

Operator amendment: when Git tracks or reports untracked files under `.deft/core`, the conversion plan lists them (first 20, then a count) before removing it. No extra prompt, no refusal (AC10.6, §A9).

Operator amendment: the launcher's `deft-hook` may know each host's blocking response and which event runs before a tool, so a `deft-hook` failure blocks (AC3.3, §A5.6, D4 rule 2).

Operator amendment: with no runtime pin, launcher entry points check for a pre-OVPR layout right after the disable flag, so an old repo gets the old-layout message, not an install message. The host `.mjs` outer never makes this check (AC9.12; architecture "Legacy conversion").

Operator amendment: the old-repo message becomes "This repo uses pre-OVPR Directive. Run `directive upgrade`, or keep the old tools: `npm i -g @deftai/directive@0.126.2`." Pre-OVPR layouts are recognised more widely, for that message only; `deft-hook` blocks with it (§A5.3, §A5.6, §A6.7, AC3.3, AC10.2, AC12.5, D4 rule 2).

### v261027 (2026-10-27)

Operator amendment: unified entry guards (disable → missing pin → project PM install → run pin); registered host hooks are committed Node `.mjs` outers that load pin `hook-bin.js`. Does **not** adopt #5956 tiered-deadline / D-9 / repair-primary allow-list mega-design. Implement via sealed tickets (e.g. #5807, #5809, #5869) against the updated ACs.

## Testing after master

Installer automation lives under [`tools/install-harness/`](../../tools/install-harness/README.md) (ht-auto + repo-upgrade), runnable without the YOLO sterile field.

```bash
# public npm / master
./tools/install-harness/ht-auto/run-all.sh --registry npm --tag latest
# Verdaccio tip (optional)
./tools/install-harness/ht-auto/run-all.sh --tag yolo-cp-wave4i
```

Results go to gitignored `.deft-scratch/install-harness/` (see that harness README).

External sanity sidecar (optional): `~/Projects/directive-install-sanity`.

## Tracking

- Product epic: [#5490](https://github.com/deftai/directive/issues/5490)
- Methodology / cutover: [#5514](https://github.com/deftai/directive/issues/5514)
- Pre-merge safety tag: `pre-ovpr-installer-master-merge`
