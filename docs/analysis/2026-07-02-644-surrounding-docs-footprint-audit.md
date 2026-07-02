# Surrounding-docs footprint audit (#644)

**Date:** 2026-07-02
**Umbrella:** #1882 (AGENTS.md is a map, not a manual)
**Source signal:** Augment Code's empirical AGENTS.md study (April 2026) — full text in `content/docs/good-agents-md.md`.

## Why this audit

The study found that removing the `AGENTS.md` from a module sitting on ~500K of surrounding specs *barely changed* agent behavior: the agent discovered and read the surrounding doc corpus regardless. The takeaway is that a lean `AGENTS.md` does **not** protect an agent from overexploration when a large, reachable documentation corpus sits underneath it. Two forces dominate:

1. **Reachable-but-unreferenced docs are still found** and still burn context.
2. **Referenced-but-stale docs are followed at high rates** — a wrong pointer is worse than no pointer.

`#644` is the audit + principle-encoding step. Wiring a mechanical doc-sprawl health check is tracked separately as `#647` and is out of scope here.

## Measured documentation-discovery rates (from the study)

| Location | Discovery rate |
|---|---|
| `AGENTS.md` hierarchy | **100%** |
| Directly referenced files | **90%+** |
| Directory-level READMEs (when working in that dir) | **80%+** |
| Nested READMEs in other subdirs | **~40%** |
| Orphan docs with no references | **<10%** |

## Directive's own reachable footprint (measured 2026-07-02)

- **Whole repo:** 359 tracked `.md` files / ~81.5K lines.
- **`content/` alone:** 226 `.md` files / ~38K lines.

Largest agent-visible clusters:

| Cluster | Files | Lines | Reachability posture |
|---|---:|---:|---|
| `content/deployments/` | 52 | ~12,418 | Task-gated in REFERENCES.md ("when working on platform-specific deployment") — keep gated |
| `docs/` (repo root) | 56 | ~9,020 | Analysis/history; not in the always-loaded chain — keep out of the spine |
| `content/skills/` | 27 | ~5,670 | Trigger-gated via the Skills Index (Level 0 scan → Level 1 load) — correct |
| `content/languages/` | 26 | ~4,878 | Task-gated ("load based on language") — keep gated |
| `content/strategies/` | 16 | ~2,632 | Task-gated |
| `content/templates/` | 10 | ~1,687 | Load-on-demand |

## Assessment

- The lazy-loading spine (`REFERENCES.md`, Level 0/1/2 + Skills Index + task-based loading) is **structurally sound**: the biggest clusters (`deployments/`, `languages/`, `skills/`) are already behind explicit task/trigger gates rather than ambient always-loaded reachability. No always-loaded doc pulls those clusters into the default context.
- The real defect is **reference-chain drift**: `REFERENCES.md` still points at `vbrief/` paths and `content/vbrief/` docs throughout, even though the framework moved to `xbrief/` (#2034 / #2110). Because these live in the 90%+-discovery reference chain, an agent follows them to renamed/wrong locations — the precise failure mode the study warns about. Correcting the drift is the highest-value action in this audit.
- `deployments/` at ~12.4K lines is the single largest cluster. It is correctly gated (only loaded when deploying to a named platform), so it is not an always-loaded burden; no de-referencing action is required beyond keeping it behind its task gate.

## Actions taken by #644

1. Recorded this audit (durable).
2. Encoded a named **reference-chain contract** principle in `REFERENCES.md` capturing the discovery-rate table and the must-follow / orphan / stale-reference rules.
3. Corrected the `vbrief/ → xbrief/` reference-chain drift in `REFERENCES.md` so the spine points only at current, resolvable paths.

## Deferred / follow-up

- **#647** — mechanical doc-sprawl health check wired into `deft-pre-pr` / `deft-sync` (enforcement tier for this principle).
- **#2157** — lazy-load platform/tool/runtime-conditional rules out of the always-loaded surface (design), informed by this footprint data.
