"""CLI helpers for ``scripts/triage_scope.py`` (#1131).

Extracted from ``scripts/triage_scope.py`` so the parent module stays
under the 1000-line MUST cap documented in ``coding/coding.md``. The
public surface lives in ``triage_scope``; this module is the argparse
shim and command dispatcher only.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any


def build_parser() -> argparse.ArgumentParser:
    """Return the ``triage_scope.py`` argument parser."""
    parser = argparse.ArgumentParser(
        prog="triage_scope.py",
        description=(
            "Inspect and refresh the typed plan.policy.triageScope[] "
            "subscription (#1131). Read paths never trigger a recompute; "
            "use --refresh-denominator to update the coverage cache."
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
        "--list",
        action="store_true",
        dest="do_list",
        help=(
            "Print the effective subscription rules + per-issue notes "
            "from explicit-watch. Read-only; never triggers a "
            "denominator recompute."
        ),
    )
    parser.add_argument(
        "--refresh-denominator",
        action="store_true",
        dest="refresh_denominator",
        help=(
            "Recompute and write the coverage denominator at "
            ".deft-cache/<source>/<owner>/<repo>/coverage.json. "
            "Requires --repo OWNER/NAME and --count <int>."
        ),
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("DEFT_TRIAGE_REPO"),
        help=(
            "Upstream repo slug 'owner/name' for "
            "--refresh-denominator. Falls back to $DEFT_TRIAGE_REPO."
        ),
    )
    parser.add_argument(
        "--source",
        default="github-issue",
        help=(
            "Cache source (default: github-issue; v1 supports only "
            "github-issue)."
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
        "--count",
        type=int,
        default=None,
        help=(
            "When --refresh-denominator is set, write this count instead "
            "of computing one. Production callers (triage:bootstrap) "
            "pass the live upstream open-issue count; CI / tests can "
            "pass a synthetic value. Required by --refresh-denominator "
            "until the live-probe wiring lands in D5."
        ),
    )
    return parser


def run_cli(argv: list[str] | None, ts_module: Any) -> int:
    """Dispatch ``triage_scope`` CLI args using ``ts_module`` as backend.

    ``ts_module`` is the parent ``triage_scope`` module; passed in to
    avoid a circular import at module-load time.
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(
            f"triage:scope: --project-root {project_root} does not exist "
            "or is not a directory.",
            file=sys.stderr,
        )
        return 2

    if not args.do_list and not args.refresh_denominator:
        parser.print_help()
        return 0

    data = ts_module._load_project_definition(project_root)
    rules = ts_module.resolve_scope_rules(project_root, project_definition=data)
    is_default = ts_module._is_default_applied(data)

    schema_errors, _schema_warnings = ts_module.validate_scope_rules(
        ts_module._get_raw_scope(data)
    )
    if schema_errors:
        print(
            "triage:scope: PROJECT-DEFINITION plan.policy.triageScope "
            f"has {len(schema_errors)} validation error(s):",
            file=sys.stderr,
        )
        for err in schema_errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    if args.do_list:
        print(
            ts_module.render_list(
                rules, project_root=project_root, is_default=is_default
            )
        )

    if args.refresh_denominator:
        if not args.repo or "/" not in args.repo:
            print(
                "triage:scope --refresh-denominator requires --repo "
                "OWNER/NAME (or $DEFT_TRIAGE_REPO).",
                file=sys.stderr,
            )
            return 2
        if args.count is None:
            print(
                "triage:scope --refresh-denominator requires --count "
                "<int> (D5 will provide the live-probe wiring; until "
                "then a synthetic / cached count is the caller's "
                "contract).",
                file=sys.stderr,
            )
            return 2
        cache_root = Path(args.cache_root).resolve() if args.cache_root else None
        path = ts_module.coverage_path(
            args.source,
            args.repo,
            project_root=project_root,
            cache_root=cache_root,
        )
        sub_hash = ts_module.subscription_hash(rules)
        record = ts_module.write_coverage_denominator(
            path,
            count=args.count,
            subscription_hash_value=sub_hash,
        )
        print(
            f"triage:scope: wrote coverage denominator "
            f"count={record.count} "
            f"subscription-hash={record.subscription_hash} "
            f"path={path}"
        )

    return 0
