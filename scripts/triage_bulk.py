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
import os
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


#: Default ceiling for ``gh issue list --limit``. Must stay aligned with
#: ``DEFAULT_MAX_OPEN_ISSUES`` in ``scripts/reconcile_issues.py`` (#764).
#: Operators with larger backlogs can override via the ``--limit`` CLI flag
#: or the ``DEFT_TRIAGE_BULK_LIMIT`` env-var; both surfaces are wired below
#: (see ``_build_parser`` and ``_resolve_limit``).
DEFAULT_ISSUE_LIST_LIMIT = 1000

#: Env-var override for ``DEFAULT_ISSUE_LIST_LIMIT`` consumed by
#: :func:`_resolve_limit` when no explicit ``--limit`` flag is passed.
LIMIT_ENV_VAR = "DEFT_TRIAGE_BULK_LIMIT"


def _resolve_limit(cli_value: int | None) -> int:
    """Pick the effective limit -- CLI > env-var > module default.

    Returns ``DEFAULT_ISSUE_LIST_LIMIT`` if the env-var is set to a value
    that does not parse as a positive integer; this matches the
    ``DEFT_NO_NETWORK`` / ``DEFT_REMOTE_PROBE_TIMEOUT`` defensive style in
    ``run`` (#801).
    """

    if cli_value is not None:
        return max(1, int(cli_value))
    raw = os.environ.get(LIMIT_ENV_VAR, "").strip()
    if not raw:
        return DEFAULT_ISSUE_LIST_LIMIT
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_ISSUE_LIST_LIMIT
    return max(1, parsed)


def _list_open_issues(
    repo: str,
    *,
    limit: int = DEFAULT_ISSUE_LIST_LIMIT,
    out: Any | None = None,
) -> list[dict[str, Any]]:
    """List open issues via ``gh issue list``.

    Returns the parsed JSON array. Errors propagate to the caller so the
    Taskfile target surfaces the failure. When the returned count meets the
    requested ``limit`` an explicit warning is emitted on ``out`` so silent
    truncation cannot masquerade as a complete bulk operation (Greptile P2
    on PR #875).
    """

    sink = out or sys.stderr
    cmd = [
        "gh",
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        str(limit),
        "--json",
        "number,title,labels,author,createdAt,updatedAt",
    ]
    completed = subprocess.run(cmd, capture_output=True, text=True, check=True)  # noqa: S603
    payload = completed.stdout or "[]"
    parsed = json.loads(payload)
    if not isinstance(parsed, list):
        return []
    issues = [item for item in parsed if isinstance(item, dict)]
    if len(issues) >= limit:
        print(
            (
                f"[triage:bulk] WARN: gh issue list returned {len(issues)} "
                f"issue(s) -- equal to --limit {limit}. The bulk action will "
                f"only operate on this slice; re-run with --limit <N> "
                f"(N > {limit}) or set {LIMIT_ENV_VAR}=<N> to widen the window."
            ),
            file=sink,
        )
    return issues


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


#: ``TypeError`` substrings that indicate the call site (not the body) is at
#: fault -- i.e. Story 3's ``reject`` does not yet accept the kwarg shape we
#: tried first. We narrow the fallback path so a real ``TypeError`` raised
#: inside Story 3 propagates to the operator (Greptile P2 on PR #875).
_SIGNATURE_TYPEERROR_TOKENS = (
    "unexpected keyword argument",
    "got multiple values for",
    "missing 1 required positional argument",
    "takes 2 positional arguments",
    "takes 3 positional arguments",
)


def _is_signature_mismatch(exc: TypeError) -> bool:
    """True if a ``TypeError`` looks like it came from the *call site*."""

    msg = str(exc)
    return any(token in msg for token in _SIGNATURE_TYPEERROR_TOKENS)


def _invoke_action(
    fn: Callable[..., Any],
    issue_number: int,
    repo: str,
    *,
    action_key: str,
    reason: str | None,
) -> None:
    """Call a Story 3 single-issue action with kwargs, falling back to positional.

    The fallback path is gated by :func:`_is_signature_mismatch` so a
    ``TypeError`` raised *inside* Story 3 propagates to the operator instead
    of being silently swallowed (Greptile P2 on PR #875).
    """

    kwargs: dict[str, Any] = {}
    if action_key == "reject" and reason is not None:
        kwargs["reason"] = reason
    try:
        fn(issue_number, repo, **kwargs)
    except TypeError as exc:
        if not _is_signature_mismatch(exc):
            raise
        # Tolerate Story 3 signature variation (positional reason) only
        # when the failure is clearly at the call surface.
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
    limit: int | None = None,
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
    if issues_provider is not None:
        fetch = issues_provider
    else:
        # Forward ``sink`` so the truncation warning lands on the caller's
        # output stream (Greptile P2 on PR #875). The lambda preserves the
        # sentinel-default semantics of ``_list_open_issues``.
        effective_limit = _resolve_limit(limit)
        fetch = lambda repo_arg: _list_open_issues(  # noqa: E731
            repo_arg, limit=effective_limit, out=sink
        )
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
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help=(
            "override the gh issue list --limit ceiling (default "
            f"{DEFAULT_ISSUE_LIST_LIMIT}; env-var {LIMIT_ENV_VAR} is honored "
            "when --limit is not passed)"
        ),
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
        limit=args.limit,
    )
    # Zero-match is a clean exit per #845 Story 4 Constraint.
    return 0


if __name__ == "__main__":
    sys.exit(main())
