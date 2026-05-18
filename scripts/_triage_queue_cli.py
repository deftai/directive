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
        # 'text' is an alias for 'plain' so the documented surface
        # ('--format=text|json' in the #1180 issue body and the D6 skill)
        # matches the implementation surface (D11 shipped 'plain'|'json').
        choices=("plain", "text", "json"),
        default="plain",
        help=(
            "Output format. 'json' emits the stable schema consumed by D2"
            " (#1122) for triage:summary integration. 'text' is an alias"
            " for 'plain'."
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
    p_audit.add_argument(
        "--evaluate-resume",
        action="store_true",
        dest="evaluate_resume",
        help=(
            "Before rendering, walk every open 'defer' audit entry whose"
            " resume_on field is non-null and append a 'resume-eligible'"
            " entry for each condition that fires (#1123 / D3)."
            " Idempotent."
        ),
    )
    # Date filters (#1180) -- distinct argparse group so the parallel D13
    # 'Slice operations' group on the same subparser does not textually
    # overlap during rebase. Both flags are optional + composable; an
    # unset flag keeps D11's original behaviour (full audit-log dump).
    date_filters = p_audit.add_argument_group(
        "Date filters (#1180)",
        "Read-only filters over the audit log; transform with jq.",
    )
    date_filters.add_argument(
        "--action",
        default=None,
        help=(
            "Filter to audit entries whose `decision` equals <verb> (e.g."
            " --action=demote-meta, --action=accept). v1 accepts a single"
            " verb; pipe through jq for multi-verb queries. Invalid verb"
            " -> exit 2 with explanatory stderr."
        ),
    )
    date_filters.add_argument(
        "--since",
        default=None,
        help=(
            "Filter to entries whose timestamp is at-or-after now - <window>."
            " Accepts the framework duration grammar: Nd / Nh / Nm / Nw / Ns"
            " (e.g. '7d', '24h', '30m') or ISO-8601 PnDTnHnMnS (e.g. 'P7D',"
            " 'PT24H'). Invalid -> exit 2 with explanatory stderr."
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
    # #1180: validate --action / --since up front so a typo fails fast
    # (exit 2) instead of silently returning an empty result set.
    if args.action is not None:
        valid_actions = tq.valid_audit_actions()
        if args.action not in valid_actions:
            print(
                f"triage:audit --action: unknown verb {args.action!r};"
                f" expected one of {sorted(valid_actions)}",
                file=sys.stderr,
            )
            return 2
    since_window = None
    if args.since is not None:
        try:
            since_window = tq.parse_audit_window(args.since)
        except ValueError as exc:
            print(f"triage:audit --since: {exc}", file=sys.stderr)
            return 2
    # #1123 / D3: optional resume-eligibility evaluation pass. Runs
    # BEFORE the audit dump so newly-appended ``resume-eligible`` rows
    # surface in the same call. No-op when the resume_conditions module
    # is not importable (slim test checkout).
    if getattr(args, "evaluate_resume", False) and tq.resume_conditions is not None:
        cache_root = Path(args.cache_root).resolve() if args.cache_root else None
        try:
            tq.resume_conditions.evaluate_resume_eligibility(
                project_root,
                cache_root=cache_root,
                audit_log_path=args.audit_log,
                repo=repo,
            )
        except Exception as exc:  # noqa: BLE001 -- best-effort surface
            print(
                f"triage:audit --evaluate-resume: evaluation failed: {exc}",
                file=sys.stderr,
            )
    entries = tq.read_audit_entries(repo, audit_path=args.audit_log)
    # #1180 date / action filters. Apply BEFORE --vbrief-staleness so the
    # staleness reduction sees the filtered set; the operator who asked
    # for `--since=30d --vbrief-staleness` wants "stale acceptances within
    # the last 30 days", not "stale acceptances ever, then filtered to
    # the last 30 days". Order: action -> since -> staleness.
    if args.action is not None:
        entries = tq.filter_by_action(entries, args.action)
    if since_window is not None:
        entries = tq.filter_by_since(entries, since_window)
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
        # 'plain' and 'text' alias to the same renderer.
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
