# Install harness (post-sterile)

In-repo runners for installer regression after OVPR lands on `master`. Ported from the YOLO tip workspace (`~/yolo-5490/ht-auto` + `repo-upgrade`) so future installer changes can be tested **without** the sterile field.

## Layout

| Path | Role |
| --- | --- |
| `ht-auto/` | HUMAN-TEST-PLAN automation (HT-00–HT-17) |
| `repo-upgrade/` | Real-repo convert / upgrade samples |
| `bin/ht-prep` | Shared consumer bootstrap (`eval "$(ht-prep …)"`) |
| `lib/env.sh` | Shared paths + registry helpers |

## Writable results (gitignored)

Defaults (override with `IH_SCRATCH`):

- `<repo>/.deft-scratch/install-harness/fixtures/`
- `<repo>/.deft-scratch/install-harness/results/`

If the repo tree is not writable, harnesses fall back to `$HOME/directive-install-harness-results/`.

`.deft-scratch/` is already gitignored in this repository.

## Modes

### Verdaccio tip (development)

```bash
# tip already published to local Verdaccio
export YOLO_5490="${YOLO_5490:-$HOME/yolo-5490}"
./tools/install-harness/ht-auto/run-all.sh --tag yolo-cp-wave4i
./tools/install-harness/repo-upgrade/run-all.sh --tag yolo-cp-wave4i
```

### Public npm / master (no sterile field)

```bash
# global launcher already on PATH (npm i -g @deftai/directive@latest)
./tools/install-harness/ht-auto/run-all.sh --registry npm --tag latest
# or:
IH_REGISTRY=npm ./tools/install-harness/ht-auto/run-all.sh --tag latest
```

Exact GA pin after cutover:

```bash
./tools/install-harness/ht-auto/run-all.sh --registry npm --tag 0.127.0
```

## Quick prep

```bash
eval "$(./tools/install-harness/bin/ht-prep --registry npm --tag latest)"
eval "$(./tools/install-harness/bin/ht-prep my-case --git --registry npm --tag latest)"
```

## External sanity sidecar

Optional outside checker: `~/Projects/directive-install-sanity` (`HT_SANITY`). Not vendored here.

## Docs

- HT cases: [`docs/installer-refactor-ovpr/install-ovpr-human-test-plan.md`](../../docs/installer-refactor-ovpr/install-ovpr-human-test-plan.md)
- OVPR requirements: [`docs/installer-refactor-ovpr/README.md`](../../docs/installer-refactor-ovpr/README.md)

## Safety

Never point these harnesses at the `deftai/directive` product checkout as the consumer under test (`RU_FORBIDDEN_CONSUMERS` / #5514). Use throwaway fixtures under `IH_SCRATCH`.
