# Wave 3 historical survey — install layouts + xbrief/vbrief schemas

| | |
| --- | --- |
| Ticket | deftai/directive#5490 / UNIFIED-GITHUB-V2.md AC10.8 / AC14.32 / AC15.2 follow-up |
| Strategy | `IMPLEMENTATION-STRATEGY-YOLO-WAVE3-V1.md` (survey method); **WAVE3-V2** (`IMPLEMENTATION-STRATEGY-YOLO-WAVE3-V2.md`) supersedes L2 user-facing uninstall-reinstall refuse for convert shapes |
| Clarifications | `specs/5490-wave3-v2-unified-clarifications.md` (C1–C8) |
| Tip surveyed | `yolo/wip-wave3a` / `yolo/cp-wave2zb` @ `0be7813c47929967a6a2e73b6ea91cb19f2d3780` |
| WAVE3-V2 base | `yolo/cp-wave3c` @ `2a38865d8c04522e5228c6eb70377476c06c8336` |
| xbrief ref | `~/Projects/xbrief` @ `56824ed4da99b4f6817e21809d998bf463163519` (`v0.8.0-3-g56824ed`) |
| Status | **3a–3c complete.** WAVE3-V2 **3d–3f**: survey lean **convert**; **3f fixtures delivered** (upgrade --yes converts without dump-out refuse). |
| Architecture | **L0 sacred** (new→new + latest-legacy→new). **L2** = detect → removal strategy → L0 arrival (WAVE3-V2). Bookend refuse may remain until 3f greens. Keep tight. |

Raw archaeology (not committed): `~/yolo-5490/logs/wave3/`  
(`xbrief-schema-inventory.md`, `install-era-clusters.md`, seed lists, co-change logs).

---

## Completeness gate (UNIFIED §D5 3a)

| Named shape | Covered by | Verdict |
| --- | --- | --- |
| Go installer tarballs | `go-tarball-deft-root` | PASS |
| Vendored `.deft/core` | `vendored-core-go`, `npm-hybrid-pin-copied-core` | PASS |
| `deft/` folders | `go-tarball-deft-root`, `dual-layout-deft-and-core` | PASS |
| Submodules | `submodule-deft` | PASS |
| Pre-0.27 `AGENTS.md` | `pre-v0.27-agents-md` | PASS |
| Every npm-era shape | `npm-bridge-refuse-legacy`, `npm-hybrid-pin-copied-core`, `npm-ranged-or-pin-only`, dual/orphan | PASS (era clusters) |
| xbrief/vbrief schemas | Track A inventory (0.5–0.8 + hybrid/dual) | PASS |

**Not found in this git (documented):** `install.py` / early Unix wrappers; `webinstaller/` and `oz-agent-upgrade` sources (separate rails).  
**Archaeology SoT:** release tags `v0.*` (esp. `v0.125.0`). Local `master` / `origin/master` are YOLO orphan grafts — do not walk install history there.

---

## Part A — xbrief / vbrief schemas (priority)

### Tip migrate contract (L1)

| Hop | Command | On tip? | What it does |
| --- | --- | --- | --- |
| 1 | `migrate:vbrief` | **No** — frozen @ tag `v0.59.0` only | Pre-0.6 / 0.5 story |
| 2 | `migrate:xbrief` | **Yes** | Layout `vbrief/`→`xbrief/` + envelope **0.6→0.8** (classic or hybrid) |

Accepted engine versions on tip: **`0.6` and `0.8` only** (`ACCEPTED_VBRIEF_VERSIONS`). Upstream libxbrief reads `0.5`–`0.8`.

Rename epoch: format **0.7.0** (`005e912`) — vBRIEF→xBRIEF (`vBRIEFInfo`→`xBRIEFInfo`, `.vbrief.json`→`.xbrief.json`, `x-vbrief/`→`x-xbrief/`). Feature-complete 0.7 was re-cut as **0.8**.

### Schema inventory (summary)

| format | tip support | fixture | 3b lean |
| --- | --- | --- | --- |
| **0.8** | native target (**read**) | low | L1 keep |
| **0.6** (+ hybrid `xBRIEFInfo@0.6`, dual envelope) | **migrate** → 0.8 | harden consumer-tree fixtures | L1 harden (P0) |
| **0.7** | **none** (transform rejects) | yes | L1 thin: treat rich≈0.8 bump **or** honest refuse; do not fork migrate |
| **0.5** | **none** (validator cites frozen hop-1) | yes | Prefer **unsupported-honest** / document off-tip hop; avoid bloating tip with hop-1 |
| pre-0.5 / history specs | none | only if live trees | archive |
| Directive pack schemas | N/A (not core envelope) | as needed | out of envelope migrate |

Surfaces: `packages/core/src/xbrief-migrate/`, `packages/runtime/src/migrate-xbrief.ts`, `tasks/migrate.yml`, `packages/types/src/constants.ts`, `content/vbrief/schemas/`.

---

## Part B — Directive install layout eras

### Quality layers

| Layer | Shapes | Bar |
| --- | --- | --- |
| **L0** | `ovpr-runtime-pin`, `npm-hybrid-pin-copied-core` (latest legacy / 2f) | Highest robustness — Wave 3 must not soften |
| **L1** | xbrief migrate 0.6→0.8 (+ optional thin 0.7) | Shared table-driven migrate; repair does not migrate |
| **L2** | All older / sparse shapes below | Isolated detect → **convert-via-removals** (WAVE3-V2) → L0; user-facing uninstall-reinstall refuse **superseded** (3f green). Unsafe submodule gitlink → unsupported-honest |

### Shape table

| shape_id | producing_versions (approx) | fingerprints (short) | version_authority | detect (tip) | decision (3b lean) | fixture |
| --- | --- | --- | --- | --- | --- | --- |
| `ovpr-runtime-pin` | YOLO tip | exact `@deftai/directive-runtime` + GENERATION; no `.deft/core` copy | runtime pin | `readPin` exact, `oldStyle:false` | **L0 stay** | tip smokes |
| `npm-hybrid-pin-copied-core` | `v0.69.0+` (#2264…) | exact `@deftai/directive` + copied-core evidence + GENERATION | **pin wins**; GENERATION | `oldStyle:true` | **L0 convert (2f)** | tip `legacy-conversion` / wave2f |
| `npm-ranged-or-pin-only` | npm era | ranged/`^` or pin without core evidence | ambiguous | not `oldStyle` | first-install/repair; not historical convert | optional |
| `npm-bridge-refuse-legacy` | `v0.56.0+` | producer behavior era | N/A | legacy-detect refuse | historical note only | — |
| `vendored-core-go` | `v0.28.0+` Go deposit | `.deft/core` evidence **without** exact pin | core `VERSION` YAML | copied-core, not `oldStyle` | **convert** (composed removals + L0); fixtures **delivered (3f)** | `legacy-shapes` / `removal-steps` / setup convert |
| `go-tarball-deft-root` | `v0.5.0`–~`v0.27` | `deft/` + markers; Go producer deleted on tip | `.deft-version` / framework VERSION | `legacy-deft-prefixed` | **convert** (composed removals + L0); fixtures **delivered (3f)** | `legacy-shapes` / `removal-steps` / setup convert |
| `submodule-deft` | ~`v0.20`–`v0.30` docs | `deft/` gitlink + `.gitmodules` | submodule SHA | `git-clone-or-submodule` | **convert** (file gitlink safe); **unsupported-honest** if index mode 160000; fixtures **delivered (3f)** | `legacy-shapes` / `removal-steps` |
| `pre-v0.27-agents-md` | pre-managed-section | AGENTS without v2/v3 markers | coupled to layout | `pre-v0.27-sentinel-agents-md` | co-travel with go-tarball convert | share with go-tarball |
| `dual-layout-deft-and-core` | post-relocate leftovers | both `deft/` and `.deft/core` | dual | `dual-layout` | **convert** (removeDeftFrameworkTree then removeCopiedCore → L0); fixtures **delivered (3f)** | `legacy-shapes` / setup convert |
| `orphan-deft-version` | partial installs | `.deft/VERSION` without core | orphan | `orphan-deft-version` | **convert** (removeOrphanDeftVersion → greenfield under upgrade/install); fixtures **delivered (3f)** | `legacy-shapes` / `removal-steps` |
| `docs-only-pre-installer` | `v0.1`–`v0.4` | no installer markers | N/A | none | unsupported-honest / non-install | only if live |

### Detect / map pointers (existing tip)

- L0 old-style: `packages/cli/src/pin.ts` (`hasCopiedCoreEvidence`, `oldStyle`)
- Pre-latest-legacy kinds: `packages/core/src/init-deposit/legacy-detect.ts`
- Uninstall known artifacts: `packages/cli/src/uninstall-map.ts`
- Bookends: `packages/cli/src/bookends.ts`

**3b seam (planned):** one shape registry + thin detect returning `shape_id` → single dispatch from bookends. Bulk historical logic stays in L2 modules. Do not grow bookend `if` forests.

---

## 3b priority queue (from this survey) — historical

0. Protect L0 regressions (2f + OVPR happy path) — block-forward if red.
1. L2 scaffolding: registry + detect → `shape_id` + dispatch seam.
2. L1: harden 0.6→0.8 / hybrid / dual fixtures; decide thin 0.7 path vs honest refuse (no hop-1 bloat for 0.5).
3. L2: wire `go-tarball-deft-root` / `submodule-deft` / `vendored-core-go` (3b: uninstall→reinstall messaging; **WAVE3-V2 flips to convert**).
4. Defer remaining sparse shapes as `unsupported-honest` in 3c if time-boxed.

---

## 3b decisions applied (tight) — superseded for convert shapes by WAVE3-V2

| shape_id / schema | 3b applied | WAVE3-V2 (3d+) |
| --- | --- | --- |
| L0 OVPR / latest-legacy | unchanged sacred paths | **L0 stay** (unchanged) |
| `go-tarball-deft-root`, `submodule-deft`, `vendored-core-go` | uninstall-reinstall messaging | **convert** via composed removals + L0; **fixtures delivered (3f)** |
| `dual-layout-deft-and-core` | deferred / uninstall lean | **convert**; **fixtures delivered (3f)** |
| `orphan-deft-version` | unsupported-honest | **convert**; **fixtures delivered (3f)** |
| xbrief 0.7 | migrate-through → 0.8 | unchanged |
| xbrief 0.5 | off-tip / unsupported-honest | unchanged |

**WAVE3-V2 supersession:** user-facing uninstall-reinstall refuse for the convert shapes above is **superseded** once 3f fixtures green. Until then, bookends may still refuse (interim). Registry decision enum is `convert-via-removals`. See `specs/5490-wave3-v2-unified-clarifications.md` C1–C3.

## Explicit non-claims (AC10.7)

WAVE3-V2 **leans convert** for the shapes above but does **not** advertise green upgrade support until era fixtures pass in **3f**. Latest-legacy and OVPR remain owned by initial-release / wave2zb (L0). Unsupported-honest remains for shapes that fail fixtures or operator deferral.

---

*End of survey table (living under AC10.8 / WAVE3-V2).*
