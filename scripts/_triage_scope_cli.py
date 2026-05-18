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
            "Inspect, mutate, and diff the typed plan.policy.triageScope[] "
            "subscription + plan.policy.triageScopeIgnores[] (#1131 / D12, "
            "#1133 / D14, #1182 / D14c). Read paths never trigger a "
            "recompute; use --refresh-denominator to update the coverage "
            "cache. Mutation flags --add-label / --add-milestone / "
            "--ignore-label are idempotent and atomic; every mutation "
            "appends a subscription-change audit entry to "
            "vbrief/.eval/subscription-history.jsonl."
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
            "from explicit-watch + the triageScopeIgnores[] block. "
            "Read-only; never triggers a denominator recompute."
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
            "Upstream repo slug 'owner/name' for --refresh-denominator "
            "and --diff-from-upstream. Falls back to $DEFT_TRIAGE_REPO."
        ),
    )
    # D14c (#1182): wrapper-verb flag set.
    parser.add_argument(
        "--add-label",
        default=None,
        help=(
            "Append <L> to plan.policy.triageScope[] (merges into an "
            "existing labels.any-of rule when present, otherwise "
            "creates a new one). Idempotent; atomic; audit-logged."
        ),
    )
    parser.add_argument(
        "--add-milestone",
        default=None,
        help=(
            "Append a {rule: 'milestone', name: <M>} entry to "
            "plan.policy.triageScope[]. Idempotent; atomic; audit-logged."
        ),
    )
    parser.add_argument(
        "--ignore-label",
        default=None,
        help=(
            "Append a {label: <L>} entry to "
            "plan.policy.triageScopeIgnores[]. Canonical surface; the "
            "older `task triage:scope-drift -- --ignore-label` form "
            "continues to work as an alias against the same field. "
            "Idempotent; atomic; audit-logged."
        ),
    )
    parser.add_argument(
        "--diff-from-upstream",
        action="store_true",
        dest="diff_from_upstream",
        help=(
            "Fetch upstream labels + milestones via gh REST and partition "
            "them into subscribed / ignored / neither sets. Requires "
            "--repo OWNER/NAME (or $DEFT_TRIAGE_REPO)."
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

    mutation_flags = [
        flag
        for flag, val in (
            ("--add-label", args.add_label),
            ("--add-milestone", args.add_milestone),
            ("--ignore-label", args.ignore_label),
        )
        if val is not None
    ]
    if len(mutation_flags) > 1:
        print(
            "triage:scope: --add-label / --add-milestone / --ignore-label "
            f"are mutually exclusive (got {mutation_flags}).",
            file=sys.stderr,
        )
        return 2

    no_action = (
        not args.do_list
        and not args.refresh_denominator
        and not mutation_flags
        and not args.diff_from_upstream
    )
    if no_action:
        parser.print_help()
        return 0

    # Mutation paths run before read paths so the post-mutation
    # --list / --diff-from-upstream view reflects the new state on a
    # combined invocation (e.g. `task triage:scope -- --add-label=X --list`).
    if mutation_flags:
        rc = _handle_mutation(project_root, args)
        if rc != 0:
            return rc

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
        # D14c (#1182): --list also renders the ignore-list block so the
        # operator sees both halves of the cache-scope contract in one
        # pass.
        from _triage_scope_renderers import render_ignores  # local import: cap

        raw_ignores = _get_raw_ignores(data)
        print(render_ignores(raw_ignores))

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

    if args.diff_from_upstream:
        rc = _handle_diff_from_upstream(project_root, args)
        if rc != 0:
            return rc

    return 0


def _handle_mutation(project_root: Path, args: argparse.Namespace) -> int:
    """Dispatch the D14c --add-label / --add-milestone / --ignore-label flag."""
    from _triage_scope_mutations import (
        add_label_to_ignores,
        add_label_to_scope,
        add_milestone_to_scope,
    )

    try:
        if args.add_label is not None:
            changed, message = add_label_to_scope(project_root, args.add_label)
            verb = "add-label"
        elif args.add_milestone is not None:
            changed, message = add_milestone_to_scope(
                project_root, args.add_milestone
            )
            verb = "add-milestone"
        else:
            changed, message = add_label_to_ignores(project_root, args.ignore_label)
            verb = "ignore-label"
    except Exception as exc:  # pylint: disable=broad-except
        print(f"triage:scope: {exc}", file=sys.stderr)
        return 1

    stream = sys.stderr if not changed else sys.stdout
    suffix = " (no-op)." if not changed else "."
    print(f"triage:scope {verb}: {message}{suffix}", file=stream)
    return 0


def _handle_diff_from_upstream(
    project_root: Path, args: argparse.Namespace
) -> int:
    """Dispatch the D14c --diff-from-upstream flag."""
    if not args.repo or "/" not in args.repo:
        print(
            "triage:scope --diff-from-upstream requires --repo OWNER/NAME "
            "(or $DEFT_TRIAGE_REPO).",
            file=sys.stderr,
        )
        return 2

    from _triage_scope_mutations import (
        compute_diff_from_upstream,
        fetch_upstream_labels_and_milestones,
        render_diff_report,
    )

    try:
        labels, milestones = fetch_upstream_labels_and_milestones(args.repo)
    except RuntimeError as exc:
        print(f"triage:scope --diff-from-upstream: {exc}", file=sys.stderr)
        return 1

    report = compute_diff_from_upstream(
        project_root,
        upstream_labels=labels,
        upstream_milestones=milestones,
        repo=args.repo,
    )
    print(render_diff_report(report))
    return 0


def _get_raw_ignores(data: dict | None) -> list:
    """Return the raw ``plan.policy.triageScopeIgnores`` list (empty when absent)."""
    if not isinstance(data, dict):
        return []
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return []
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return []
    raw = policy.get("triageScopeIgnores")
    return raw if isinstance(raw, list) else []
