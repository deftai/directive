# Install OVPR — Implementation strategy (history)

**This file is historical.** It explains how #5490 was delivered. It does **not** waive or redefine product ACs in [install-ovpr-requirements.md](./install-ovpr-requirements.md). Prefer #5514 for branch/publish/self-host methodology still in force after cutover.

## Document stack used during delivery

| Artifact (orchestrator / issue) | Role during delivery |
| --- | --- |
| `UNIFIED-GITHUB-V2.md` / #5490 | Closed product design (now → `install-ovpr-requirements.md`) |
| #5514 + `IMPLEMENTATION-LIFECYCLE-CHEATSHEET-V1.md` | Integration branch, beta-without-master, soak, GA, self-host |
| `IMPLEMENTATION-STRATEGY-V1.md` | Original D5 slice order (reference) |
| `IMPLEMENTATION-STRATEGY-YOLO-V1.md` + `STERILE-FIELD.md` | Single-engineer Verdaccio train; process bars down, product bars held |
| `IMPLEMENTATION-STRATEGY-VALIDATED-ISSUES-V1/V2` + YOLO-V3 | Finding→wave fix trains after validation passes |
| `IMPLEMENTATION-STRATEGY-YOLO-WAVE3-V1/V2` | Historical layout survey + convert-via-removals + human F-* closes |
| `IMPLEMENTATION-STRATEGY-YOLO-WAVE4-V1` | Master merge-ups, repo-upgrade, public beta cuts |

## Phases (#5514)

1. **Phase 0 — build on integration.** Long-lived trunk `yolo/5490`; lettered `yolo/cp-wave*` freezes; proof via fixtures + Verdaccio only. ⊗ Dogfood install against the `deftai/directive` checkout as proof.
2. **Phase 1 — public `beta`.** Paired launcher+runtime on dist-tag `beta` from tip **without** requiring master merge. `@latest` stayed the old fat CLI. Optional consumer soak; optional this-repo cutover with `--target-version <beta>`.
3. **Phase 2 — master merge + GA.** One merge of the integration tip to `master`, then production cut so `@latest` is the thin launcher + matching runtime. This repo becomes an ordinary consumer of that pin.

## YOLO sterile field (historical)

To avoid loading live Directive process while building the installer:

- Orchestrator workspace: `~/Projects/directive-install-simplification-2`
- Patient: `~/Projects/directive` on `yolo/*` with committed `.no-deft-directive`, stub `AGENTS.md`, local `core.hooksPath` → noop hooks
- Outside playground: `~/yolo-5490` (Verdaccio, smokes, ht-auto, repo-upgrade, logs)
- Retrospective completed xbriefs at each CP freeze (many stubs; replaced by a small canonical set at master land)

Sterile field is **undone** as part of the master-merge train (strip markers → merge → GA → `directive install` of GA onto this repo).

## Wave train (summary)

| Band | What closed |
| --- | --- |
| Wave 0–1 | Harness, sterile, Verdaccio, in-sync/ownership, two-package collapse |
| Wave 2 / 2j–2z | Install/repair/upgrade core; validated-issues security + UX + packaging + docs residuals |
| Wave 2za–2zb | UX polish + human findings acceptance; friends-try tip |
| Wave 3 / 3a–3z | Historical shapes, convert-via-removals, F-009–F-017, migrate-on-upgrade, validated-issues V3 |
| Wave 4a–4i | Master merge-ups, legacy hooks/triad strip, plain plans, content-contracts OVPR, public `0.126.0-beta.1`…`beta.3` |
| Wave 4j | Final master fold, docs home, slice 1e release tooling, harness land, canonical xbriefs, sterile undo, master PR |

## Public beta before master

Paired publishes used interim `/yolo-beta-release` from yolo tips. Example verified: `@deftai/directive@beta` = `0.126.0-beta.3` while `@latest` remained old fat `0.126.2` until GA.

## Slice 1e (release tooling)

#5514 called out that the release skill, `release:e2e`, and `npm-publish.yml` still assumed **four** packages. Full 1e lands on the wave4j train **before** trusting `deft-directive-release` for GA. Preflight (`release:e2e` dry-run / two-package fixture) must be green before the skill runs on `master`.

## Master-merge window (wave4j)

1. Tag `pre-ovpr-installer-master-merge` on pre-merge `master`
2. `master` → `yolo/5490` → cut `yolo/wip-wave4j` from immutable `yolo/cp-wave4i`
3. Docs + 1e + harness + canonical xbriefs + sterile strip on WIP
4. PR → `master`; Greptile blockers + SLizard P0/P1
5. GA via release skill; this-repo `directive install --target-version <ga>`; reopen `master`

## What not to revive

- Source-checkout exemption / HEAD as this repo’s install engine
- Emergency `@latest` flip without soak/GA path
- Teaching `deft-install` / `npx` as ongoing identity
- Four-package publish order for new cuts
- Sterile-field process as a standing requirement after cutover
