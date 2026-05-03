#!/usr/bin/env python3
"""triage_bulk.py -- Story 4 bulk triage ops over filtered candidates (#845).

Public surface:

- :func:`bulk_action(action_key, repo, ...)` -- programmatic entrypoint.
- :func:`main(argv)` -- CLI dispatcher invoked by ``tasks/triage-bulk.yml``.

The four CLI sub-actions exposed via ``argparse``:

- ``bulk-accept``     -> ``triage_actions.accept(N, repo)``
- ``bulk-reject``     -> ``triage_actions.reject(N, repo, reason=...)``
- ``bulk-defer``      -> ``triage_actions.defer(N, repo)``
- ``bulk-needs-ac``   -> ``triage_actions.needs_ac(N, repo)``

Filter flags (combinable, AND semantics):

- ``--label <name>``  match a label by name on the issue.
- ``--author <login>`` match the GitHub author login.
- ``--age-days <N>``  match issues whose ``createdAt`` is older than ``now - N days``.
- ``--cluster <slug>`` match a ``cluster:<slug>`` (or bare ``<slug>``) label.

Zero-match exits cleanly with status 0 and a single stdout line so this script
is safe to run inside a swarm pipeline.

Looping over Story 3 (``triage_actions``) is intentional; bulk MUST NOT expose
its own parallel surface (#845 Story 4 Constraint).
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import subprocess
import sys
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

# Mapping from CLI sub-action keyword to the ``triage_actions`` module attribute
# resolved at runtime. Story 3's contracted public surface is documented in
# ``vbrief/active/2026-05-03-845-triage-actions.vbrief.json``.
ACTION_FN_NAMES: dict[str, str] = {
    "accept": "accept",
    "reject": "reject",
    "defer": "defer",
    "needs-ac": "needs_ac",
}


def _load_triage_actions() -> Any:
    """Lazy-import the Story 3 actions module.

    Story 4 ships in a separate PR and may land before Story 3. Tests stub
    the module in ``sys.modules`` before importing this script; production
    callers see a clear error if Story 3 has not yet merged.
    """

    for candidate in ("triage_actions", "scripts.triage_actions"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    raise RuntimeError(
        "triage_actions module not available -- Story 3 has not landed in this "
        "checkout. Install the cache+actions cohort or stub triage_actions in "
        "sys.modules before invoking bulk ops."
    )


def _list_open_issues(repo: str) -> list[dict[str, Any]]:
    """List open issues via ``gh issue list``.

    Returns the parsed JSON array. Errors propagate to the caller so the
    Taskfile target surfaces the failure.
    """

    cmd = [
        "gh",
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number,title,labels,author,createdAt,updatedAt",
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True, check=True)  # noqa: S603
    payload = completed.stdout or "[]"
    parsed = json.loads(payload)
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _filter_issues(
    issues: Iterable[dict[str, Any]],
    *,
    label: str | None = None,
    author: str | None = None,
    age_days: int | None = None,
    cluster: str | None = None,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Apply combinable filters with AND semantics."""

    now = now or datetime.now(UTC)
    cutoff: datetime | None = None
    if age_days is not None:
        cutoff = now - timedelta(days=age_days)

    matched: list[dict[str, Any]] = []
    for issue in issues:
        labels = [
            entry.get("name") for entry in issue.get("labels", []) or [] if isinstance(entry, dict)
        ]

        if label is not None and label not in labels:
            continue

        if author is not None:
            actor = issue.get("author") or {}
            login = actor.get("login") if isinstance(actor, dict) else None
            if login != author:
                continue

        if cutoff is not None:
            created_raw = issue.get("createdAt")
            if not created_raw:
                continue
            try:
                created_at = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
            except ValueError:
                continue
            if created_at > cutoff:
                continue

        if cluster is not None:
            cluster_label = f"cluster:{cluster}"
            if not any(name in (cluster_label, cluster) for name in labels):
                continue

        matched.append(issue)
    return matched


def _resolve_action(actions_module: Any, action_key: str) -> Callable[..., Any]:
    fn_name = ACTION_FN_NAMES[action_key]
    fn = getattr(actions_module, fn_name, None)
    if not callable(fn):
        raise RuntimeError(f"triage_actions.{fn_name} not found (Story 3 contract violated)")
    return fn  # type: ignore[no-any-return]


def _invoke_action(
    fn: Callable[..., Any],
    issue_number: int,
    repo: str,
    *,
    action_key: str,
    reason: str | None,
) -> None:
    """Call a Story 3 single-issue action with kwargs, falling back to positional."""

    kwargs: dict[str, Any] = {}
    if action_key == "reject" and reason is not None:
        kwargs["reason"] = reason
    try:
        fn(issue_number, repo, **kwargs)
    except TypeError:
        # Tolerate Story 3 signature variation (positional reason).
        if action_key == "reject" and reason is not None:
            fn(issue_number, repo, reason)
        else:
            fn(issue_number, repo)


def bulk_action(
    action_key: str,
    repo: str,
    *,
    label: str | None = None,
    author: str | None = None,
    age_days: int | None = None,
    cluster: str | None = None,
    reason: str | None = None,
    actions_module: Any | None = None,
    issues_provider: Callable[[str], list[dict[str, Any]]] | None = None,
    now: datetime | None = None,
    out: Any | None = None,
) -> int:
    """Execute ``action_key`` over the filtered candidate set.

    Returns the count of issues actioned. Zero matches returns ``0`` and emits
    a single-line summary -- the caller MUST treat this as a clean exit.

    Dependency-injection hooks keep this surface unit-testable without forking
    a real ``gh`` subprocess or importing a not-yet-landed Story 3 module.
    """

    if action_key not in ACTION_FN_NAMES:
        raise ValueError(f"Unknown bulk action: {action_key!r}")

    sink = out or sys.stdout
    fetch = issues_provider or _list_open_issues
    issues = fetch(repo)
    matched = _filter_issues(
        issues,
        label=label,
        author=author,
        age_days=age_days,
        cluster=cluster,
        now=now,
    )

    if not matched:
        print(f"[triage:bulk-{action_key}] zero matches for given filters", file=sink)
        return 0

    module = actions_module if actions_module is not None else _load_triage_actions()
    fn = _resolve_action(module, action_key)

    actioned = 0
    for issue in matched:
        try:
            issue_number = int(issue["number"])
        except (KeyError, TypeError, ValueError):
            print(
                f"[triage:bulk-{action_key}] skipping malformed issue entry: {issue!r}",
                file=sink,
            )
            continue
        _invoke_action(fn, issue_number, repo, action_key=action_key, reason=reason)
        actioned += 1
        print(f"[triage:bulk-{action_key}] #{issue_number} actioned", file=sink)

    print(f"[triage:bulk-{action_key}] total: {actioned}", file=sink)
    return actioned


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triage_bulk",
        description="Bulk triage operations over filtered candidate sets (#845 Story 4)",
    )
    parser.add_argument(
        "action",
        choices=list(ACTION_FN_NAMES.keys()),
        help="bulk action to apply (accept|reject|defer|needs-ac)",
    )
    parser.add_argument("--repo", required=True, help="GitHub repo, owner/name")
    parser.add_argument("--label", default=None, help="filter: only issues carrying this label")
    parser.add_argument(
        "--author", default=None, help="filter: only issues authored by this GitHub login"
    )
    parser.add_argument(
        "--age-days",
        type=int,
        default=None,
        help="filter: only issues older than N days (createdAt threshold)",
    )
    parser.add_argument(
        "--cluster",
        default=None,
        help="filter: only issues tagged with cluster:<slug> or bare <slug> label",
    )
    parser.add_argument(
        "--reason",
        default=None,
        help="reject only: reason recorded in audit log + upstream issue close comment",
    )
    return parser


def _reconfigure_utf8() -> None:
    """Best-effort UTF-8 stdout/stderr on Windows hosts (mirrors #814)."""

    if sys.platform != "win32":
        return
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            with contextlib.suppress(Exception):
                reconfigure(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    _reconfigure_utf8()
    args = _build_parser().parse_args(argv)
    bulk_action(
        args.action,
        args.repo,
        label=args.label,
        author=args.author,
        age_days=args.age_days,
        cluster=args.cluster,
        reason=args.reason,
    )
    # Zero-match is a clean exit per #845 Story 4 Constraint.
    return 0


if __name__ == "__main__":
    sys.exit(main())
