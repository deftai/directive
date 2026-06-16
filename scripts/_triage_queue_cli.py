"""CLI helpers for ``scripts/triage_queue.py`` (#1128).

Extracted from ``scripts/triage_queue.py`` so the parent module stays
under the 1000-line MUST cap documented in ``coding/coding.md``. The
public surface lives in ``triage_queue``; this module is the argparse
shim and command dispatcher only.

Repo resolution (#1246)
-----------------------
The ``triage:queue`` / ``triage:show`` / ``triage:audit`` CLI surfaces
resolve ``--repo`` with the precedence: explicit ``--repo`` flag >
``$DEFT_TRIAGE_REPO`` env var > auto-detection from
``git remote get-url origin`` (run inside ``--project-root``) > error.
The auto-detection step removes the most-common-path papercut where an
operator inside an unambiguous clone had to repeat the repo slug on
every invocation. Cross-repo invocations remain supported via the
explicit flag (highest precedence).
"""

from __future__ import annotations

import argparse
import contextlib
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked via Taskfile + uv.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Optional: slice_audit ships in the same wave as this CLI (#1132 / D13).
# Guarded so an out-of-band import on a slim test checkout does not break.
try:  # pragma: no cover -- exercised once #1132 lands.
    import slice_audit  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    slice_audit = None  # type: ignore[assignment]


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
        help=("Upstream repo slug 'owner/name'. Falls back to $DEFT_TRIAGE_REPO."),
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
    parser.add_argument(
        "--slices-log",
        default=None,
        help=(
            "Override the slices.jsonl path (default: <project-root>/"
            "vbrief/.eval/slices.jsonl). Test hook for #1132 / D13."
        ),
    )


def build_parser(default_limit: int) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_queue.py",
        description=("Ranked triage queue + per-item show + audit-log surface (#1128)."),
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_queue = sub.add_parser("queue", help="Print the ranked triage queue.")
    _add_common_args(p_queue)
    p_queue.add_argument(
        "--limit",
        type=int,
        default=default_limit,
        help=(
            f"Cap the number of rows printed (default: {default_limit}). Pass 0 to disable the cap."
        ),
    )
    p_queue.add_argument(
        "--include-blocked",
        action="store_true",
        dest="include_blocked",
        help=(
            "Re-surface items whose linked vBRIEF is blocked (plan.status:blocked"
            " or an unresolved swarm.depends_on) into their natural group. By"
            " default such items are demoted into the [BLOCKED] group (#1286)."
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

    # ----- Slice operations (#1132 / D13) -----
    #
    # Each of the three flags below selects a distinct slice-related
    # surface; they are mutually exclusive (the CLI picks the first one
    # set and emits its renderer instead of the default audit dump).
    # Kept as a distinct argparse group so #1180's date-filter flags can
    # land as a separate `Date filters` group without textual overlap.
    slice_group = p_audit.add_argument_group(
        "Slice operations (#1132 / D13)",
        "Read-only surfaces that join slices.jsonl against the cache.",
    )
    slice_group.add_argument(
        "--orphans",
        action="store_true",
        help=(
            "List children whose umbrella issue is closed while they remain"
            " open. Output: one line per orphan with umbrella back-pointer."
        ),
    )
    slice_group.add_argument(
        "--slice-stalled",
        action="store_true",
        dest="slice_stalled",
        help=(
            "List cohorts where >=1 child has merged but >=1 sibling has"
            " not moved in --days days (default 30)."
        ),
    )
    slice_group.add_argument(
        "--slice-coverage",
        action="store_true",
        dest="slice_coverage",
        help=(
            "For each open umbrella in slices.jsonl, print"
            " <umbrella>: <closed>/<total> children merged."
        ),
    )
    slice_group.add_argument(
        "--days",
        type=int,
        default=None,
        help=(
            "Stall window in days for --slice-stalled (default 30)."
            " No effect without --slice-stalled."
        ),
    )

    return parser


#: subprocess.run timeout for ``git remote get-url origin`` auto-detection
#: (#1246). Defensive: a stuck ``git`` proxy (corporate VPN re-auth) would
#: otherwise hang every ``task triage:queue`` invocation indefinitely.
_GIT_INFER_TIMEOUT_S: int = 10


def _detect_origin_repo(project_root: Path | None) -> str | None:
    """Return ``owner/name`` parsed from ``git remote get-url origin``, or ``None``.

    Run inside ``project_root`` (or the current working directory when
    ``project_root`` is ``None``). Returns ``None`` on any of:

    * ``git`` not on PATH.
    * ``git remote get-url origin`` exits non-zero (outside a git working
      tree, or no ``origin`` remote configured).
    * The subprocess hangs past :data:`_GIT_INFER_TIMEOUT_S` seconds --
      defensive against a wedged credential helper / VPN re-auth.
    * The origin URL is not a recognised ``github.com`` form (https /
      ssh / git@ shapes).

    Delegated to ``scripts/_project_context.py::_detect_repo_from_git``
    where importable so the framework keeps a single origin-detection
    grammar; falls back to an inline implementation only on slim test
    checkouts that have not yet rebased onto that module.
    """
    try:
        from _project_context import _detect_repo_from_git
    except ImportError:  # pragma: no cover -- slim-checkout fallback
        return _detect_origin_repo_inline(project_root)
    return _detect_repo_from_git(project_root)


def _detect_origin_repo_inline(project_root: Path | None) -> str | None:
    """Fallback origin-detector used when ``_project_context`` is unimportable.

    Mirrors the precedence + parsing rules of the canonical helper so
    consumers on a slim test checkout still get the #1246 papercut
    eliminated. Returns ``None`` when detection fails so the caller can
    surface the canonical "--repo required" error.
    """
    cwd = str(project_root) if project_root is not None else None
    try:
        result = subprocess.run(  # noqa: S603 -- argv is a literal
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=False,
            cwd=cwd,
            timeout=_GIT_INFER_TIMEOUT_S,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    url = (result.stdout or "").strip()
    if not url:
        return None
    match = re.search(
        r"github\.com[:/]([A-Za-z0-9][A-Za-z0-9._-]*)/"
        r"([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?/?\s*$",
        url,
    )
    if not match:
        return None
    return f"{match.group(1)}/{match.group(2)}"


def _resolve_repo(args: argparse.Namespace) -> str | None:
    """Resolve the effective ``--repo`` slug for triage_queue CLI verbs.

    Delegates to the canonical :func:`triage_queue._resolve_repo` (#1238)
    so the resolution chain lives in the documented module and stays in
    lockstep with ``preflight_cache`` / ``triage_bootstrap``. Precedence,
    highest first:

    1. ``args.repo`` -- the explicit ``--repo`` flag, which also picks up
       ``$DEFT_TRIAGE_REPO`` because the argparse default reads the env
       var. Highest precedence; preserved for cross-repo invocations.
    2. ``$DEFT_TRIAGE_REPO`` -- the canonical helper re-checks the env var
       so the precedence is honoured even when a caller constructs the
       namespace without the argparse env default.
    3. ``git remote get-url origin`` parsed from inside
       ``--project-root`` (or the current working directory). Removes
       the papercut where an operator inside an unambiguous clone had
       to repeat the repo slug on every ``task triage:queue`` call.
    4. ``None`` -- the caller emits the canonical
       ``triage:<verb>: --repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is
       required.`` error so the operator sees an actionable next step
       rather than a silent empty-cache walk.
    """
    import triage_queue

    project_root: Path | None = None
    if getattr(args, "project_root", None):
        with contextlib.suppress(OSError):
            project_root = Path(args.project_root).resolve()
    return triage_queue._resolve_repo(args.repo, project_root=project_root)


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
    # Load both open and closed issues so the orphan detection in #1132
    # can see closed umbrellas; the queue itself still filters to open
    # children via the QueueBuildOptions.orphan_issue_numbers set.
    issues_for_queue = tq.load_cached_issues(repo, project_root=project_root)
    issues_with_closed = tq.load_cached_issues(repo, project_root=project_root, include_closed=True)
    issues_by_number = {i["number"]: i for i in issues_with_closed}
    audit_entries = tq.read_audit_entries(repo, audit_path=args.audit_log)
    ranking_labels = tuple(tq.resolve_ranking_labels(project_root))
    active_refs = frozenset(tq._active_referenced_issue_numbers(project_root))
    orphan_numbers: frozenset[int] = frozenset()
    if slice_audit is not None:
        records = slice_audit.load_slice_records(tq.slice_record, path=args.slices_log)
        orphan_numbers = slice_audit.collect_orphan_issue_numbers(records, issues_by_number)
    limit = None if args.limit == 0 else max(0, int(args.limit))
    options = tq.QueueBuildOptions(
        ranking_labels=ranking_labels,
        active_referenced=active_refs,
        orphan_issue_numbers=orphan_numbers,
        include_blocked=getattr(args, "include_blocked", False),
        limit=limit,
    )
    items = tq.build_queue(issues_for_queue, audit_entries, repo=repo, options=options)
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
        for i in tq.load_cached_issues(repo, project_root=project_root, include_closed=True)
    }
    issue = issues.get(int(args.number))
    history: list[dict[str, Any]] = []
    if tq.candidates_log is not None:
        history = list(tq.candidates_log.find_by_issue(int(args.number), repo, path=args.audit_log))
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
    if args.cache_root:
        _override_cache_root(project_root, Path(args.cache_root).resolve())
    # #1132 / D13: slice operation flags short-circuit the audit dump.
    # Mutually exclusive: first set flag wins; if more than one is
    # passed the chained calls render only the highest-priority one.
    if getattr(args, "orphans", False):
        return _cmd_slice_orphans(args, tq, repo=repo, project_root=project_root)
    if getattr(args, "slice_stalled", False):
        return _cmd_slice_stalled(args, tq, repo=repo, project_root=project_root)
    if getattr(args, "slice_coverage", False):
        return _cmd_slice_coverage(args, tq, repo=repo, project_root=project_root)
    # #1180: validate --action / --since up front so a typo fails fast
    # (exit 2) instead of silently returning an empty result set. Runs
    # AFTER the D13 slice short-circuit so --orphans/--slice-stalled/
    # --slice-coverage don't waste cycles validating filters that the
    # slice handlers never consume.
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
        entries = [entry for entry in latest.values() if tq.is_stale_acceptance(entry, active_refs)]
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


def _slice_inputs(
    args: argparse.Namespace,
    tq: Any,
    *,
    repo: str | None,
    project_root: Path,
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]] | None:
    """Load (slice_records, issues_by_number) or return ``None`` on missing surface.

    Prints the canonical informational message to stderr and returns ``None``
    when ``slice_audit`` is not importable -- the issue body's backward-
    compat requirement ("slices.jsonl missing -> flags exit 0 with
    informational stderr"). Repo is required for the cache walk but a
    missing slices.jsonl is silent (read_all returns []).
    """
    if slice_audit is None:
        print(
            "triage:audit: slice operation flags require scripts/slice_audit.py"
            " (#1132 / D13); skipping.",
            file=sys.stderr,
        )
        return None
    if not repo:
        print(
            "triage:audit: --repo OWNER/NAME (or $DEFT_TRIAGE_REPO) is required"
            " for slice operations.",
            file=sys.stderr,
        )
        return None
    records = slice_audit.load_slice_records(tq.slice_record, path=args.slices_log)
    issues = tq.load_cached_issues(repo, project_root=project_root, include_closed=True)
    issues_by_number = {i["number"]: i for i in issues}
    return records, issues_by_number


def _cmd_slice_orphans(
    args: argparse.Namespace,
    tq: Any,
    *,
    repo: str | None,
    project_root: Path,
) -> int:
    loaded = _slice_inputs(args, tq, repo=repo, project_root=project_root)
    if loaded is None:
        return 0
    records, issues_by_number = loaded
    rows = slice_audit.compute_orphans(records, issues_by_number)
    if args.format == "json":
        print(slice_audit.render_orphans_json(rows, repo=repo))
    else:
        print(slice_audit.render_orphans_plain(rows, repo=repo))
    return 0


def _cmd_slice_stalled(
    args: argparse.Namespace,
    tq: Any,
    *,
    repo: str | None,
    project_root: Path,
) -> int:
    loaded = _slice_inputs(args, tq, repo=repo, project_root=project_root)
    if loaded is None:
        return 0
    records, issues_by_number = loaded
    days = args.days if args.days is not None else tq.DEFAULT_SLICE_STALLED_DAYS
    rows = slice_audit.compute_stalled(records, issues_by_number, days=days)
    if args.format == "json":
        print(slice_audit.render_stalled_json(rows, repo=repo, days=days))
    else:
        print(slice_audit.render_stalled_plain(rows, repo=repo, days=days))
    return 0


def _cmd_slice_coverage(
    args: argparse.Namespace,
    tq: Any,
    *,
    repo: str | None,
    project_root: Path,
) -> int:
    loaded = _slice_inputs(args, tq, repo=repo, project_root=project_root)
    if loaded is None:
        return 0
    records, issues_by_number = loaded
    rows = slice_audit.compute_coverage(records, issues_by_number)
    if args.format == "json":
        print(slice_audit.render_coverage_json(rows, repo=repo))
    else:
        print(slice_audit.render_coverage_plain(rows, repo=repo))
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
