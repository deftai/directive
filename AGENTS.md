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
- ! Process hooks are disabled via **local** `core.hooksPath` → `~/yolo-5490/noop-githooks` (outside tree). Committed `.githooks/` stay the real product scripts so packaging/tests do not ship YOLO no-ops.

## Recovery after YOLO

After YOLO, before re-deposit / rejoin `IMPLEMENTATION-STRATEGY-V1.md` / #5514:

1. Remove `.no-deft-directive` (opt-out flag blocks `directive update` / re-deposit while present).
2. Unset local `core.hooksPath` if it still points at `~/yolo-5490/noop-githooks` (`git config --local --unset core.hooksPath`).
3. Restore normal maintainer `AGENTS.md` (or let the new installer re-deposit).

This stub is disposable process isolation, not a product AC.
