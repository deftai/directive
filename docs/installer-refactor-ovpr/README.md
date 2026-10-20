# Installer refactor — One Version Per Repo (OVPR)

Durable in-repo home for the #5490 / #5514 installer redesign that replaced the Go installer and copied `.deft/core` deposit with a thin global launcher + exact per-repo `@deftai/directive-runtime` pin.

## What lives here

| File | Kind | Use |
| --- | --- | --- |
| [install-ovpr-requirements.md](./install-ovpr-requirements.md) | **Active** | Full product requirements / ACs. Prefer this when changing install/upgrade/uninstall/repair/doctor behavior. |
| [install-ovpr-architecture.md](./install-ovpr-architecture.md) | **Active** | Compact architecture map (packages, contract, setup/migrate, self-host). |
| [install-ovpr-implementation-strategy.md](./install-ovpr-implementation-strategy.md) | **History** | How the work was delivered (YOLO train, sterile field, beta, master merge). Not an AC waiver. |
| [install-ovpr-human-test-plan.md](./install-ovpr-human-test-plan.md) | **Active** | HT-00–HT-17 cases and operator notes. |

## Authority split

1. **Product (what):** `install-ovpr-requirements.md` (from UNIFIED / #5490).
2. **Methodology (how we branched / published / self-hosted):** #5514 + the history file in this folder.
3. **Day-to-day consumer docs:** root `README.md`, `content/UPGRADING.md`, `docs/RELEASING.md`.

On conflict: requirements win for installer semantics. History never relaxes an AC.

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
