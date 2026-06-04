#!/usr/bin/env python3
"""verify_capacity.py -- three-state ADVISORY capacity gate (#1419 Slice 4).

Surfaced via ``task verify:capacity``. Reuses the offline accounting engine in
:mod:`scripts.capacity_show` to evaluate whether the trailing-window backward
mix has drifted away from the configured ``capacityAllocation`` targets.

Advisory by construction
------------------------
``plan.policy.capacityAllocation.enforcement`` defaults to ``"advise"``, and in
that posture this gate ALWAYS exits 0 -- it reports the mix and defers to the
selection ordering. It is therefore safe to run anywhere and is deliberately
NOT wired into the ``task check`` aggregate: a capacity deficit on the
framework's own tree MUST NOT fail-closed and wedge master.

A non-zero "deficit" exit (1) only fires when ALL of the following hold:

* ``enforcement == "enforce"`` (explicit per-project opt-in), AND
* the classified-completion sample is at or above ``minSampleSize`` (so the
  signal is load-bearing, not noise), AND
* at least one protected bucket is starved past
  :data:`DEFICIT_TOLERANCE` of the trailing window's completed weight.

Exit codes (three-state, mirrors the other deft verify gates):

* ``0`` -- within targets, OR advisory posture, OR insufficient sample, OR no
  capacity policy configured. (This is the only state reachable on the
  framework's own ``advise``-default tree.)
* ``1`` -- ``enforce`` posture with a real, sampled deficit.
* ``2`` -- config error (``--project-root`` is not a directory).
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

# Make sibling helpers importable both as __main__ and when imported by tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from capacity_show import CapacityReport, compute_report, render_report  # noqa: E402
from policy import resolve_capacity_allocation  # noqa: E402

reconfigure_stdio()

#: Minimum absolute backward-weight deficit (in the report's unit) that an
#: ``enforce``-posture bucket may carry before the gate flags it. A small
#: tolerance absorbs rounding and single-item lumpiness so the gate fires only
#: on a genuine, sustained shortfall.
DEFICIT_TOLERANCE: float = 1.0


def _worst_deficit(report: CapacityReport) -> tuple[str, float]:
    """Return the ``(bucket_id, deficit)`` with the largest positive deficit."""
    worst_id = ""
    worst = 0.0
    for tally in report.buckets:
        deficit = report.bucket_deficit(tally)
        if deficit > worst:
            worst = deficit
            worst_id = tally.bucket_id
    return worst_id, worst


def evaluate(
    project_root: Path, *, now: datetime | None = None
) -> tuple[int, str]:
    """Pure entry point: returns ``(exit_code, message)``.

    See the module docstring for the three-state contract. The ``advise``
    default guarantees exit 0 on the framework's own tree.
    """
    if not project_root.is_dir():
        return 2, (
            f"verify_capacity: --project-root is not a directory: {project_root}\n"
            "  Recovery: pass an existing project root."
        )

    allocation = resolve_capacity_allocation(project_root)
    report = compute_report(project_root, now=now, allocation=allocation)
    rendered = render_report(report)

    if allocation.enforcement != "enforce":
        return 0, (
            f"{rendered}\n"
            "verify_capacity: OK -- advisory posture "
            f"(enforcement={allocation.enforcement!r}); deferring to ordering."
        )

    if not report.configured:
        return 0, (
            f"{rendered}\n"
            "verify_capacity: OK -- no capacityAllocation buckets configured."
        )

    if report.advisory_mode:
        return 0, (
            f"{rendered}\n"
            "verify_capacity: OK -- sample below minSampleSize "
            f"({report.classified_completions}/{report.min_sample_size}); "
            "capacity stays advisory until enough classified completions accrue."
        )

    worst_id, worst = _worst_deficit(report)
    if worst > DEFICIT_TOLERANCE:
        return 1, (
            f"{rendered}\n"
            f"verify_capacity: DEFICIT -- bucket {worst_id!r} is starved by "
            f"{worst:.2f} (enforce posture; tolerance {DEFICIT_TOLERANCE}). "
            "Prioritize that bucket or relax its target."
        )

    return 0, (
        f"{rendered}\n"
        "verify_capacity: OK -- all buckets within target tolerance."
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_capacity.py",
        description=(
            "Three-state ADVISORY capacity gate (#1419 Slice 4). Exits 0 in the "
            "default advise posture (and on insufficient sample / unconfigured "
            "policy); exits 1 only under an explicit enforce posture with a "
            "sampled deficit; exits 2 on config error. Not wired into "
            "`task check` -- capacity must never fail-closed on the framework tree."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors / deficits still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    code, message = evaluate(project_root)
    if code == 0:
        if not args.quiet:
            print(message)
    else:
        print(message, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
