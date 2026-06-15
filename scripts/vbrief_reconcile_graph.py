#!/usr/bin/env python3
"""vbrief_reconcile_graph.py -- cascade-unblock walker (#1287).

A pure-vBRIEF, forge-agnostic verb (``task vbrief:reconcile:graph``) that
walks ``vbrief/proposed/``, resolves each candidate's
``plan.metadata.swarm.depends_on[]`` against current lifecycle state, and
promotes (``proposed/ -> pending/`` via the existing
``scope_lifecycle.run_transition`` path) every candidate whose
dependencies ALL resolve to a brief living in ``vbrief/completed/`` or
``vbrief/cancelled/``.

Design contract:

* **Cascade-unblock only.** A candidate with an empty ``depends_on`` is
  left in ``proposed/`` -- the backlog is the operator's, not the
  walker's. Only candidates that WERE blocked on dependencies and are now
  unblocked get promoted.
* **WIP-cap aware.** Promotions stop once ``pending/ + active/`` reaches
  the configured cap (``plan.policy.wipCap``, default 10). ``--force``
  overrides the cap (each forced promote is logged by the underlying
  scope-lifecycle audit path).
* **Cycle-safe.** Dependency cycles among proposed candidates are detected
  via the ``swarm_readiness`` dep-graph machinery and never promoted; a
  cycle is reported and yields exit 1.
* **Idempotent.** A second run is a no-op: promoted candidates have left
  ``proposed/``, so nothing further resolves.

Reuses the dependency-graph resolution machinery in
``scripts/swarm_readiness.py`` (``_candidate``, ``_all_scope_ids``,
``_candidate_dep_graph``, ``_mark_cycles``) and the promote surface in
``scripts/scope_lifecycle.py`` (``run_transition``) rather than
reinventing either.

Exit codes (three-state):
    0 -- ran successfully (promoted >= 0 candidates; WIP-cap deferral and
         not-yet-resolved candidates are normal, idempotent outcomes).
    1 -- a dependency cycle was detected among proposed candidates.
    2 -- usage / config error (no ``vbrief/proposed/`` directory, etc.).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from scope_lifecycle import run_transition  # noqa: E402
from swarm_readiness import (  # noqa: E402
    Candidate,
    _all_scope_ids,
    _as_str_list,
    _candidate,
    _candidate_dep_graph,
    _mark_cycles,
)

reconfigure_stdio()

# A dependency "resolves" (no longer blocks its dependent) when the brief
# it names lives in one of these terminal lifecycle folders.
RESOLVED_FOLDERS = ("completed", "cancelled")
_CYCLE_MARKER = "dependency cycle:"


@dataclass
class ReconcileOutcome:
    """Result of a single reconcile walk."""

    promoted: list[str] = field(default_factory=list)
    deferred_wip: list[str] = field(default_factory=list)
    waiting: list[tuple[str, list[str]]] = field(default_factory=list)
    cycles: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)
    cap: int = 0
    count: int = 0
    dry_run: bool = False
    forced: bool = False

    def to_json(self) -> dict[str, object]:
        return {
            "promoted": list(self.promoted),
            "deferred_wip": list(self.deferred_wip),
            "waiting": [{"story_id": sid, "unresolved": deps} for sid, deps in self.waiting],
            "cycles": list(self.cycles),
            "errors": [{"story_id": sid, "message": msg} for sid, msg in self.errors],
            "cap": self.cap,
            "count": self.count,
            "dry_run": self.dry_run,
            "forced": self.forced,
        }


def _resolve_wip_state(project_root: Path) -> tuple[int, int]:
    """Return ``(cap, current_count)`` for the WIP cap.

    Deferred-import of ``scripts.policy`` so a tree that pre-dates the D4
    WIP-cap schema (#1124) degrades to "no cap" (a very large cap) rather
    than raising.
    """
    try:
        from policy import count_vbrief_wip, resolve_wip_cap
    except ImportError:  # pragma: no cover -- D4 not present
        return sys.maxsize, 0
    cap = resolve_wip_cap(project_root).cap
    count = count_vbrief_wip(project_root)
    return cap, count


def _dep_resolved(dep: str, known_ids: dict[str, tuple[Path, str]]) -> bool:
    """True when *dep* names a brief in a terminal (completed/cancelled) folder."""
    known = known_ids.get(dep)
    if known is None:
        return False
    path, _status = known
    return path.parent.name in RESOLVED_FOLDERS


def _unresolved_deps(
    candidate: Candidate,
    known_ids: dict[str, tuple[Path, str]],
) -> list[str]:
    """Return the dependency ids that have NOT resolved to a terminal folder."""
    return [
        dep
        for dep in _as_str_list(candidate.swarm.get("depends_on"))
        if not _dep_resolved(dep, known_ids)
    ]


def _candidate_in_cycle(candidate: Candidate) -> bool:
    return any(reason.startswith(_CYCLE_MARKER) for reason in candidate.blocked)


def reconcile_graph(
    project_root: Path,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> tuple[int, ReconcileOutcome]:
    """Walk proposed/, promote cascade-unblocked candidates, return (exit, outcome).

    The promote order is deterministic (sorted by story id) so the WIP-cap
    cut-off is stable across runs.
    """
    proposed_dir = project_root / "vbrief" / "proposed"
    if not proposed_dir.is_dir():
        return 2, ReconcileOutcome()

    candidate_paths = sorted(proposed_dir.glob("*.vbrief.json"))
    candidates = [c for path in candidate_paths if (c := _candidate(path, project_root))]

    known_ids = _all_scope_ids(project_root)
    for candidate in candidates:
        known_ids.setdefault(candidate.story_id, (candidate.path, candidate.status))

    # Reuse the swarm_readiness dep-graph + cycle machinery. ``_candidate_dep_graph``
    # builds edges only between proposed candidates; ``_mark_cycles`` then appends a
    # ``dependency cycle: ...`` marker to every candidate that participates in one.
    graph = _candidate_dep_graph(candidates, known_ids)
    _mark_cycles(candidates, graph)

    cap, count = _resolve_wip_state(project_root)
    outcome = ReconcileOutcome(cap=cap, count=count, dry_run=dry_run, forced=force)

    eligible: list[Candidate] = []
    for candidate in sorted(candidates, key=lambda c: c.story_id):
        if _candidate_in_cycle(candidate):
            cycle_reason = next(
                reason for reason in candidate.blocked if reason.startswith(_CYCLE_MARKER)
            )
            outcome.cycles.append(f"{candidate.story_id}: {cycle_reason}")
            continue
        deps = _as_str_list(candidate.swarm.get("depends_on"))
        if not deps:
            # Cascade-unblock only: a dependency-free brief is operator backlog,
            # not the walker's to promote.
            continue
        unresolved = _unresolved_deps(candidate, known_ids)
        if unresolved:
            outcome.waiting.append((candidate.story_id, unresolved))
            continue
        eligible.append(candidate)

    running_count = count
    for candidate in eligible:
        if running_count >= cap and not force:
            outcome.deferred_wip.append(candidate.story_id)
            continue
        if dry_run:
            outcome.promoted.append(candidate.story_id)
            running_count += 1
            continue
        ok, message = run_transition("promote", candidate.path)
        if not ok:
            outcome.errors.append((candidate.story_id, message))
            continue
        outcome.promoted.append(candidate.story_id)
        running_count += 1

    outcome.count = running_count
    exit_code = 1 if outcome.cycles else 0
    return exit_code, outcome


def _render_report(outcome: ReconcileOutcome) -> str:
    lines: list[str] = ["vBRIEF reconcile graph", ""]
    suffix = " (dry-run)" if outcome.dry_run else ""

    lines.append(f"Promoted{suffix}:")
    if outcome.promoted:
        lines.extend(f"- {story_id}" for story_id in outcome.promoted)
    else:
        lines.append("- none")
    lines.append("")

    lines.append(f"Deferred (WIP cap {outcome.count}/{outcome.cap}):")
    if outcome.deferred_wip:
        lines.extend(f"- {story_id}" for story_id in outcome.deferred_wip)
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Waiting (deps unresolved):")
    if outcome.waiting:
        lines.extend(
            f"- {story_id}: needs {', '.join(deps)}" for story_id, deps in outcome.waiting
        )
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Cycles:")
    if outcome.cycles:
        lines.extend(f"- {entry}" for entry in outcome.cycles)
    else:
        lines.append("- none")

    if outcome.errors:
        lines.append("")
        lines.append("Errors:")
        lines.extend(f"- {story_id}: {message}" for story_id, message in outcome.errors)

    return "\n".join(lines)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Cascade-unblock walker: promote proposed/ vBRIEFs whose "
            "swarm.depends_on[] all resolve to completed/ or cancelled/."
        )
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing vbrief/ (default: current directory).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Override the WIP cap when promoting (each forced promote is audited).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report which candidates WOULD be promoted without moving any files.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON summary instead of the text report.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    project_root = Path(args.project_root).resolve()
    exit_code, outcome = reconcile_graph(
        project_root,
        force=args.force,
        dry_run=args.dry_run,
    )
    if exit_code == 2:
        if args.json:
            print(json.dumps({"error": "no vbrief/proposed/ directory found"}))
        else:
            print(
                f"Error: no vbrief/proposed/ directory found under {project_root}",
                file=sys.stderr,
            )
        return 2
    if args.json:
        print(json.dumps(outcome.to_json(), indent=2))
    else:
        print(_render_report(outcome))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
