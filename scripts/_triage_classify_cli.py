#!/usr/bin/env python3
"""_triage_classify_cli.py -- argparse shim for ``scripts/triage_classify.py``.

Kept in its own module so ``triage_classify.py`` stays under the 1000-line
MUST cap from ``coding/coding.md``. The CLI surface is intentionally
narrow: ``--list`` renders the effective rule + hold-marker set;
``--validate`` runs the schema check against the current
PROJECT-DEFINITION and exits non-zero on errors (suitable for CI / hook
use). Dry-run application against a cache is OUT OF SCOPE for D10 --
that lands with the apply-step integration in a follow-up child.

Exit codes (three-state, mirrors ``scripts/preflight_branch.py``):

* ``0`` -- success (or no errors when ``--validate`` is the verb).
* ``1`` -- validation errors found.
* ``2`` -- usage error or PROJECT-DEFINITION not parseable.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_classify.py",
        description=(
            "Auto-classification surface (#1129 / D10). Inspect or validate "
            "the effective triageAutoClassify[] + triageHoldMarkers[] config."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Path to the consumer project root (default: current dir).",
    )
    group = parser.add_mutually_exclusive_group(required=False)
    group.add_argument(
        "--list",
        action="store_true",
        dest="do_list",
        help="Print the effective rule + hold-marker set (default action).",
    )
    group.add_argument(
        "--validate",
        action="store_true",
        dest="do_validate",
        help=(
            "Validate plan.policy.triageAutoClassify[] and triageHoldMarkers[] "
            "on the local PROJECT-DEFINITION; exit non-zero on errors."
        ),
    )
    return parser


def _validate_project(project_root: Path, module: object) -> int:
    """Run schema validation against the local PROJECT-DEFINITION."""
    data = module._load_project_definition(project_root)
    if data is None:
        # No PROJECT-DEFINITION -- the framework defaults apply with no
        # consumer overrides, which is always valid by construction.
        print(
            "OK: no PROJECT-DEFINITION at "
            f"{project_root / 'vbrief' / 'PROJECT-DEFINITION.vbrief.json'} -- "
            "framework defaults apply with no consumer overrides."
        )
        return 0
    plan = data.get("plan") if isinstance(data, dict) else None
    if not isinstance(plan, dict):
        print(
            "FAIL: PROJECT-DEFINITION.plan is not an object",
            file=sys.stderr,
        )
        return 1
    rel = project_root / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    classify_errs = module.validate_triage_auto_classify_on_plan(plan, str(rel))
    holder_errs = module.validate_triage_hold_markers_on_plan(plan, str(rel))
    errors = classify_errs + holder_errs
    if errors:
        for err in errors:
            print(f"FAIL: {err}", file=sys.stderr)
        print(f"\n{len(errors)} error(s) found", file=sys.stderr)
        return 1
    rules = module.resolve_classify_rules(project_root)
    markers = module.resolve_hold_markers(project_root)
    print(
        "OK: triageAutoClassify[] + triageHoldMarkers[] valid "
        f"({len(rules)} rules, {len(markers)} hold markers)."
    )
    return 0


def _list_project(project_root: Path, module: object) -> int:
    rules = module.resolve_classify_rules(project_root)
    markers = module.resolve_hold_markers(project_root)
    print(module.render_list(rules, hold_markers=markers))
    return 0


def run_cli(argv: list[str] | None, module: object) -> int:
    """Entry-point invoked by :func:`triage_classify.main`.

    Receives the parent module so the shim doesn't import it via
    ``triage_classify`` (which would create a stale alias when the
    module is re-imported under a different name during tests).
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"ERR: --project-root {project_root} does not exist or is not a "
            "directory.",
            file=sys.stderr,
        )
        return 2
    if args.do_validate:
        return _validate_project(project_root, module)
    # Default action: --list.
    return _list_project(project_root, module)
