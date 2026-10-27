# Installer refactor — One Version Per Repo (OVPR)

Durable in-repo home for the #5490 / #5514 installer redesign that replaced the Go installer and copied `.deft/core` deposit with a thin global launcher + exact per-repo `@deftai/directive-runtime` pin.

## What lives here

| File | Kind | Use |
| --- | --- | --- |
| [install-ovpr-requirements.md](./install-ovpr-requirements.md) | **Active (normative)** | Full product requirements / ACs. Includes revision **v261027** (entry guards + host `.mjs` outer). Prefer this when changing install/upgrade/uninstall/repair/doctor/hook-deposit behavior. |
| [install-ovpr-architecture.md](./install-ovpr-architecture.md) | **Active (normative)** | Compact architecture map (packages, contract, setup/migrate, self-host, host-hook outer). |
| [install-ovpr-problem-ledger-2026-10-23.md](./install-ovpr-problem-ledger-2026-10-23.md) | **Decision record only** | Sealed 2026-10-23 FINALs for Problems 1–33 and ticket map. **Not requirements.** Points at requirements/architecture as SoT. |
| [install-ovpr-implementation-strategy.md](./install-ovpr-implementation-strategy.md) | **History** | How the work was delivered (YOLO train, sterile field, beta, master merge). Not an AC waiver. |
| [install-ovpr-human-test-plan.md](./install-ovpr-human-test-plan.md) | **Active** | HT-00–HT-17 cases and operator notes. |

## Authority split

1. **Product (what):** `install-ovpr-requirements.md` (from UNIFIED / #5490), including in-place revision tags such as **v261027**.
2. **Architecture (how pieces fit):** `install-ovpr-architecture.md` (same revision tags where applicable).
3. **Methodology (how we branched / published / self-hosted):** #5514 + the history file in this folder.
4. **Disposition history:** `install-ovpr-problem-ledger-2026-10-23.md` — why tickets were sealed; never overrides (1)/(2).
5. **Day-to-day consumer docs:** root `README.md`, `content/UPGRADING.md`, `docs/RELEASING.md`.

On conflict: **requirements win** for installer semantics; architecture explains shape; the problem ledger and implementation-strategy history never relax an AC.

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
