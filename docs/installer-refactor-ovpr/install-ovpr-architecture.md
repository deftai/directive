# Install OVPR — Architecture (active)

Compact map of the One Version Per Repo installer. Normative detail lives in [install-ovpr-requirements.md](./install-ovpr-requirements.md).

## Packages

| Package | Role |
| --- | --- |
| `@deftai/directive` | Thin **global launcher** (empty runtime deps). Bins: `directive`, `deft`, hook entry. |
| `@deftai/directive-runtime` | **Exact project pin**. Commands, hooks, content, engine. Staged/bundled so consumers do not fetch private triad packages. |

Retired as consumer installs: `@deftai/directive-core`, `-content`, `-types`, and the Go `cmd/deft-install` tree (AC10.10).

## Contract

- Runtime `package.json` carries `directive.contract` (integer).
- Launcher supports contracts `1 … max`.
- If installed or target runtime contract exceeds launcher max → stop and tell the operator to update the global launcher **before** mutating the project (upgrade preflight).

## Verbs

| Verb | Mutates pin? | Mutates wiring? | Migrates xbrief/vbrief? |
| --- | --- | --- | --- |
| `directive install` | First-time yes | Setup yes | No (seeds only when missing on first install) |
| `directive install --repair` | Restore pin via PM if needed | Setup refresh | **Never** |
| `directive upgrade` | Yes (V→W) | Setup when stale | **Yes** (only install-management path that migrates) |
| `directive uninstall` | Removes runtime pin | Removes owned wiring | No (preserves `xbrief/`) |
| `directive doctor` | No | No | No (read-only; names `upgrade` / `install --repair`) |

Configured project + bare `install` without `--repair` → exit 2 naming repair (does not silently repair/upgrade).

## Layout on disk (consumer)

- Exact pin: `devDependencies["@deftai/directive-runtime"] = "<version>"` (no range).
- Wiring paths are package-relative: `node_modules/@deftai/directive-runtime/…` (AGENTS managed section, skill pointers, host hooks, git hooks, Taskfile).
- Readiness: `.deft/directive/wiring-ready.<runtime-version>.json` (withheld when git/hooksPath cannot activate).
- Ownership / generation: `GENERATION.json`.
- **No** `.deft/core` content copy on the OVPR path.

## Preapproval

Install / upgrade / uninstall use one bounded launcher plan and a single approval (`--yes` or interactive `[y/N]`). `--dry-run` = plan only. Default human plans are plain-language effect bullets; exact PM argv at `-v` / `--verbose`.

## Legacy conversion

- **Latest legacy (L0):** exact pre-split `@deftai/directive` pin + copied `.deft/core` → `directive upgrade` converts in place (strip triad + lockfile purge, pin runtime, setup, migrate).
- **Older shapes (Wave 3):** detect → removal-step strategies or honest unsupported; see requirements AC10 / AC14 and history file.

## Self-hosting (`deftai/directive` itself)

After cutover (#5514):

1. Exact `@deftai/directive-runtime` pin in the monorepo root (ordinary consumer).
2. Global launcher only as launcher; HEAD is **not** the install engine for this checkout.
3. `task` / hooks use the pinned runtime; build/release scripts may import HEAD as a library.
4. Managed `AGENTS.md` lags the release like any consumer; maintainer header above the marker is the HEAD overlay.

During the integration train, this repo used a sterile field (no governing install) and outside-tree fixtures. That process is historical; see [install-ovpr-implementation-strategy.md](./install-ovpr-implementation-strategy.md).

## Release pairing

Publish **launcher and runtime together at the same version** (AC13.4). Dist-tags:

- `@latest` — production pair after GA
- `beta` — paired prerelease (allowed from integration tip before master merge)
- Local Verdaccio `yolo-cp-*` — YOLO inner loop only

## Doctor compose

`directive doctor` = install-sync diagnosis, then `--- product doctor ---`, then full product suite. `--data-status` stays machine-only.
