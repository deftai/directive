# Wave 3 local completion — historical survey + tight buildout

| | |
| --- | --- |
| Strategy | `IMPLEMENTATION-STRATEGY-YOLO-WAVE3-V1.md` |
| Base | `yolo/cp-wave2zb` @ `0be7813c47929967a6a2e73b6ea91cb19f2d3780` |
| Tip | `yolo/cp-wave3b` @ `631e9ace24eded29f34a687a401bc6e64943c732` (3c may alias) |
| Date | 2026-10-14 |
| Status | **Wave-3 local complete** for overnight scope (survey + L2 seam + L1 0.7). Further era fixtures optional. |

## Checkpoint train

| CP | SHA | Verdaccio | Gate |
| --- | --- | --- | --- |
| `yolo/cp-wave3a` | `c8666c9c9…` | `yolo-cp-wave3a` / `0.0.0-yolo.cp-wave3a.1` | Survey table checked in; §D5 3a completeness PASS |
| `yolo/cp-wave3b` | `631e9ace2…` | `yolo-cp-wave3b` / `0.0.0-yolo.cp-wave3b.1` | L2 registry + L1 0.7 migrate-through; L0 regressions green |

## Architecture held

- **L0 sacred:** bookends +22 lines dispatch only; `legacy-conversion` + OVPR paths unchanged in intent.
- **L1:** shared xbrief migrate; `0.7` migrate-through reuses 0.6→0.8 transform; `ACCEPTED` stays `0.6`+`0.8`; **no hop-1 / 0.5 bloat**.
- **L2:** `packages/cli/src/legacy-shapes/` — data-driven registry; go/submodule/vendored-core-go → **uninstall-reinstall**; orphan → **unsupported-honest**.

## Decision matrix (operator)

| shape_id / schema | Decision | Fixture status | Notes |
| --- | --- | --- | --- |
| `ovpr-runtime-pin` | L0 stay | tip smokes | Sacred |
| `npm-hybrid-pin-copied-core` | L0 convert (2f) | tip legacy-conversion | Sacred |
| `go-tarball-deft-root` | uninstall → install | unit detect+message | No fat convert |
| `submodule-deft` | uninstall → install | unit detect+message | No fat convert |
| `vendored-core-go` | uninstall → install | unit detect+message | No pin → not oldStyle |
| `orphan-deft-version` | unsupported-honest | unit | Sparse |
| `dual-layout` / `pre-v0.27-agents` / `npm-ranged` | deferred | — | Co-travel or first-install; list in survey |
| xbrief **0.8** | native | tip | — |
| xbrief **0.6** (+ hybrid/dual) | migrate → 0.8 | unit + existing | Harden consumer-tree later |
| xbrief **0.7** | migrate-through → 0.8 | unit (new) | Thin accept |
| xbrief **0.5** | unsupported-honest / off-tip hop-1 @ `v0.59.0` | — | **Do not port hop-1 to tip** |
| pre-0.5 history | archive | — | Only if live trees appear |

## Deferred (honest — AC10.7)

1. Consumer-tree fixtures for uninstall→reinstall end-to-end (outside-tree smokes) beyond unit detect.
2. dual-layout / pre-v0.27-agents as first-class registry rows (often co-travel).
3. 0.5 tip migrate (prefer keep off-tip frozen hop).
4. Full OS×PM×Node matrix for historical shapes.
5. Greptile formal ≤2 on 3b (optional polish; isolation smell already reviewed by orchestrator).

## Recommendation for 1.0 messaging

For pre-latest-legacy layouts (**Go `deft/`**, submodule, copied-core **without** exact pin): **demand uninstall then `directive install`** rather than inventing in-place convert. Latest-legacy pin+copied-core and OVPR new→new remain the high-quality paths. That matches UNIFIED’s convert-or-uninstall freedom and keeps the wave2zb core robust.

## Artifacts

- Survey: `specs/5490-wave3-historical-survey.md`
- Logs: `~/yolo-5490/logs/wave3/`
- Smokes: `wave3a-survey.sh`, `wave3b.sh`
- xbriefs: `xbrief/completed/yolo-5490-wave3{a,b}.xbrief.json`

## Non-goals still held

No public npm · no master merge · no dogfood against directive checkout · friends-try tip (`yolo-cp-wave2zb`) not blocked by Wave 3.
