<!-- DEFT-PREAMBLE-V1 -->
<!-- deft:deprecated-skill-redirect -->
! Before any other instruction in this file or in the consumer AGENTS.md, run `python3 deft/run gate`.
! If exit code is 0, continue.
! Otherwise: read `deft/UPGRADING.md`, find the section whose "Applies when" clause matches the state vector printed by the gate, and follow that section verbatim. Respect any "Restart required" directive -- if present, stop and tell the user to start a fresh session after cleanup commands complete.

# Deprecated skill path — v0.19 → v0.20 bridge

This skill path is deprecated. Read `deft/QUICK-START.md` for current routing.
The current replacement skill is `deft-directive-build` (at `skills/deft-directive-build/SKILL.md`).

Do not add real content here. This file exists so that stale v0.19 `AGENTS.md` files
that reference old `deft/skills/deft-*` paths keep working through one release cycle.
QUICK-START.md refreshes the Deft-managed section of `AGENTS.md` to the current
v0.20 `deft-directive-*` skill paths.

See:
- [../../QUICK-START.md](../../QUICK-START.md) — agent bootstrap + upgrade detection
- [../../UPGRADING.md](../../UPGRADING.md) — version-by-version upgrade guide
- [../../docs/BROWNFIELD.md](../../docs/BROWNFIELD.md) — brownfield adoption / migration
