"""CLI helpers for ``scripts/triage_scope_drift.py`` (D14 / #1133).

Extracted from ``scripts/triage_scope_drift.py`` so the parent module
stays under the 1000-line MUST cap.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_scope_drift.py",
        description=(
            "Detect subscription drift: labels / milestones on cached open "
            "issues that fall outside plan.policy.triageScope[]. The "
            "framework threshold is >= 3 issues per signal (D14 / #1133). "
            "Honors plan.policy.triageScopeIgnores[] to suppress signals "
            "the operator has explicitly opted out of."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help=(
            "Path to the consumer project root (default: "
            "$DEFT_PROJECT_ROOT or current working directory)."
        ),
    )
    parser.add_argument(
        "--cache-root",
        default=None,
        help=(
            "Override the cache root (default: "
            "<project-root>/.deft-cache). Useful for tests."
        ),
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=None,
        help=(
            "Override the framework threshold (default 3). Test-only; "
            "consumer tunability is v2 scope per umbrella section 12."
        ),
    )
    parser.add_argument(
        "--ignore-label",
        default=None,
        help=(
            "Add a {label: <name>} entry to "
            "plan.policy.triageScopeIgnores[] and exit. Idempotent; "
            "re-adding an existing entry prints an informational "
            "message and exits 0."
        ),
    )
    parser.add_argument(
        "--ignore-milestone",
        default=None,
        help=(
            "Add a {milestone: <name>} entry to "
            "plan.policy.triageScopeIgnores[] and exit. Idempotent."
        ),
    )
    return parser


def run_cli(argv: list[str] | None, module: Any) -> int:
    """Dispatch ``triage_scope_drift`` CLI args using ``module`` as backend."""
    parser = build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"triage:scope-drift: --project-root {project_root} does not "
            "exist or is not a directory.",
            file=sys.stderr,
        )
        return 2

    if args.ignore_label is not None and args.ignore_milestone is not None:
        print(
            "triage:scope-drift: --ignore-label and --ignore-milestone are "
            "mutually exclusive (pick one per invocation).",
            file=sys.stderr,
        )
        return 2

    if args.ignore_label is not None or args.ignore_milestone is not None:
        try:
            changed, message = module.add_ignore(
                project_root,
                label=args.ignore_label,
                milestone=args.ignore_milestone,
            )
        except Exception as exc:  # pylint: disable=broad-except
            print(f"triage:scope-drift: {exc}", file=sys.stderr)
            return 1
        if not changed:
            print(f"triage:scope-drift: {message} (no-op).", file=sys.stderr)
        else:
            print(f"triage:scope-drift: {message}.")
            print(
                "  Next run of `task triage:scope-drift` will exclude "
                "this signal.",
                file=sys.stderr,
            )
        return 0

    cache_root = Path(args.cache_root).resolve() if args.cache_root else None
    report = module.compute_drift(
        project_root, cache_root=cache_root, threshold=args.threshold
    )
    print(module.render_drift_report(report))
    return 0
