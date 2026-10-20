# Installer

Legend: !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Current install path (OVPR)

The Go installer (`cmd/deft-install/`, `deft-install`) is **deleted** (AC10.10). Do not download or run it.

! Install the global launcher with `npm i -g @deftai/directive` (or `pnpm add -g @deftai/directive`).
! Activate a project with `directive install` (exact `@deftai/directive-runtime` pin + package-relative wiring).
! Repair wiring with `directive install --repair`; move pin / migrate data with `directive upgrade`.
! Diagnose with read-only `directive doctor`.
⊗ Teach `npx` / `pnpm exec` / `deft-install` as day-to-day identity.
⊗ Copy framework content into `.deft/core/` as the current install location.

See [docs/launcher.md](../docs/launcher.md), [docs/getting-started.md](../docs/getting-started.md), and [UPGRADING.md](../UPGRADING.md) § Current path.

## Retired Go installer (historical)

> **Archaeology only.** Older releases shipped a Go `deft-install` binary with
> Releases API version-currency checks and headless `--yes --upgrade` flags.
> That product surface is gone; the MUST rules that used to live here no longer
> apply. Prefer the OVPR path above.
