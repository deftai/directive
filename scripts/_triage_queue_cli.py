"""CLI helpers for ``scripts/triage_queue.py`` (#1128).

Extracted from ``scripts/triage_queue.py`` so the parent module stays
under the 1000-line MUST cap documented in ``coding/coding.md``. The
public surface lives in ``triage_queue``; this module is the argparse
shim and command dispatcher only.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
from pathlib import Path
from typing import Any


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--project-root",
        default=os.environ.get("DEFT_PROJECT_ROOT", "."),
        help=(
            "Path to the consumer project root (default: $DEFT_PROJECT_ROOT or"
            " the current working directory)."
        ),
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("DEFT_TRIAGE_REPO"),
        help=(
            "Upstream repo slug 'owner/name'. Falls back to $DEFT_TRIAGE_REPO."
        ),
    )
    parser.add_argument(
        "--cache-root",
        default=None,
        help="Override the cache root (default: <project-root>/.deft-cache).",
    )
    parser.add_argument(
        "--audit-log",
        default=None,
        help=(
            "Override the audit log path (default: <project-root>/"
            "vbrief/.eval/candidates.jsonl). Test hook."
        ),
    )


def build_parser(default_limit: int) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_queue.py",
        description=(
            "Ranked triage queue + per-item show + audit-log surface (#1128)."
        ),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_queue = sub.add_parser("queue", help="Print the ranked triage queue.")
    _add_common_args(p_queue)
    p_queue.add_argument(
        "--limit",
        type=int,
        default=default_limit,
        help=(
            "Cap the number of rows printed (default: "
            f"{default_limit}). Pass 0 to disable the cap."
        ),
    )

    p_show = sub.add_parser(
        "show",
        help="Print per-issue triage detail (read-only).",
    )
    _add_common_args(p_show)
    p_show.add_argument(
        "number",
        type=int,
        help="Upstream issue number, e.g. 1128.",
    )

    p_audit = sub.add_parser(
        "audit",
        help="Print the audit-log surface (plain text or --format=json).",
    )
    _add_common_args(p_audit)
    p_audit.add_argument(
        "--format",
        choices=("plain", "json"),
        default="plain",
        help=(
            "Output format. 'json' emits the stable schema consumed by D2"
            " (#1122) for triage:summary integration."
        ),
    )
    p_audit.add_argument(
        "--vbrief-staleness",
        action="store_true",
        help=(
            "Filter to audit entries whose latest 'accept' decision lacks an"
            " active-vBRIEF reference. Used by D4 (#1124)."
        ),
    )

    return parser


def _resolve_repo(args: argparse.Namespace) -> str | None:
    return args.repo or os.environ.get("DEFT_TRIAGE_REPO")


def _override_cache_root(project_root: Path, cache_root: Path) -> None:
    """Best-effort symlink so the cache walker finds ``cache_root``.

    Used only by the ``--cache-root`` test hook. The function is a no-op
    on Windows without admin / dev mode (symlink creation rejected); the
    test path falls through and passes ``--project-root`` at the cache
    root instead.
    """
    target = project_root / ".deft-cache"
    if target.exists():
        with contextlib.suppress(OSError):
            if target.resolve() == cache_root.resolve():
                return
        return
    with contextlib.suppress(OSError):
        target.symlink_to(cache_root, target_is_directory=True)


def _cmd_queue(args: argparse.Namespace, tq: Any) -> int:
    repo = _resolve_repo(args)
    if not repo:
        print(
            "triage:queue: --repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is required.",
            file=sys.stderr,
        )
        return 2
    project_root = Path(args.project_root).resolve()
    if args.cache_root:
        _override_cache_root(project_root, Path(args.cache_root).resolve())
    issues = tq.load_cached_issues(repo, project_root=project_root)
    audit_entries = tq.read_audit_entries(repo, audit_path=args.audit_log)
    ranking_labels = tuple(tq.resolve_ranking_labels(project_root))
    active_refs = frozenset(tq._active_referenced_issue_numbers(project_root))
    limit = None if args.limit == 0 else max(0, int(args.limit))
    options = tq.QueueBuildOptions(
        ranking_labels=ranking_labels,
        active_referenced=active_refs,
        limit=limit,
    )
    items = tq.build_queue(issues, audit_entries, repo=repo, options=options)
    print(
        tq.render_queue(
            items,
            repo=repo,
            limit=limit,
            ranking_labels=ranking_labels,
        )
    )
    return 0


def _cmd_show(args: argparse.Namespace, tq: Any) -> int:
    repo = _resolve_repo(args)
    if not repo:
        print(
            "triage:show: --repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is required.",
            file=sys.stderr,
        )
        return 2
    project_root = Path(args.project_root).resolve()
    if args.cache_root:
        _override_cache_root(project_root, Path(args.cache_root).resolve())
    issues = {
        i["number"]: i
        for i in tq.load_cached_issues(
            repo, project_root=project_root, include_closed=True
        )
    }
    issue = issues.get(int(args.number))
    history: list[dict[str, Any]] = []
    if tq.candidates_log is not None:
        history = list(
            tq.candidates_log.find_by_issue(
                int(args.number), repo, path=args.audit_log
            )
        )
    history_sorted = sorted(history, key=lambda r: r.get("timestamp", ""))
    latest = history_sorted[-1] if history_sorted else None
    active_refs = tq._active_referenced_issue_numbers(project_root)
    print(
        tq.render_show(
            issue,
            repo=repo,
            number=int(args.number),
            latest_decision=latest,
            history=history_sorted,
            in_active_vbrief=int(args.number) in active_refs,
        )
    )
    return 0 if issue is not None else 1


def _cmd_audit(args: argparse.Namespace, tq: Any) -> int:
    repo = _resolve_repo(args)
    project_root = Path(args.project_root).resolve()
    entries = tq.read_audit_entries(repo, audit_path=args.audit_log)
    if args.vbrief_staleness:
        active_refs = frozenset(tq._active_referenced_issue_numbers(project_root))
        latest = tq.latest_decisions_by_issue(entries)
        entries = [
            entry
            for entry in latest.values()
            if tq.is_stale_acceptance(entry, active_refs)
        ]
        entries.sort(key=lambda r: r.get("timestamp", ""))
    if args.format == "json":
        print(
            tq.render_audit_json(
                entries,
                repo=repo,
                vbrief_staleness=args.vbrief_staleness,
            )
        )
    else:
        print(
            tq.render_audit_plain(
                entries,
                repo=repo,
                vbrief_staleness=args.vbrief_staleness,
            )
        )
    return 0


def run_cli(argv: list[str] | None, tq_module: Any) -> int:
    """Dispatch ``triage_queue`` CLI args using ``tq_module`` as backend."""
    parser = build_parser(tq_module.DEFAULT_QUEUE_LIMIT)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2
    if args.cmd == "queue":
        return _cmd_queue(args, tq_module)
    if args.cmd == "show":
        return _cmd_show(args, tq_module)
    if args.cmd == "audit":
        return _cmd_audit(args, tq_module)
    parser.print_help()
    return 2
