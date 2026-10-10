# YOLO sterile patient — deftai/directive (#5490)

This checkout is a **sterile operating field** for the #5490 YOLO run.

## Authority (outside this repo)

1. `~/Projects/directive-install-simplification-2/IMPLEMENTATION-STRATEGY-YOLO-V1.md`
2. `~/Projects/directive-install-simplification-2/UNIFIED-GITHUB-V2.md`
3. `~/Projects/directive-install-simplification-2/STERILE-FIELD.md`
4. Operator live instruction / GO prompt

`source ~/yolo-5490/env.sh` — patient path is `$YOLO_DIRECTIVE_REPO` on branch `yolo/5490` (and descendants).

## Hard rules

- ! Grok / agent **workspace root** is `~/Projects/directive-install-simplification-2`, not this directory.
- ⊗ Load or follow `main.md`, `.deft/core/main.md`, session-start / session ritual, swarm, xBRIEF gates, `directive check`, host Directive hooks, or `content/skills/deft-directive-*` **as process**.
- ! You **may** edit `packages/`, `content/`, and related paths as **product source under test** when UNIFIED requires it.
- ! Live process tooling: `~/yolo-5490/` helpers (SLizard `--no-llm`, Greptile CP reviews, Verdaccio smokes) only.
- ! `.no-deft-directive` is present on this branch (#2926). Do not remove it during YOLO.
- ! `.githooks` are no-ops on this branch. Do not restore full DD githooks during YOLO.

## Recovery after YOLO

Restore normal maintainer `AGENTS.md` / hooks when rejoining `IMPLEMENTATION-STRATEGY-V1.md` / #5514 (or when the new installer re-deposits). This stub is disposable process isolation, not a product AC.
