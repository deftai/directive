#!/usr/bin/env python3
"""triage_bulk.py -- Story 4 bulk triage ops over the unified cache (#883 Story 3).

Public surface:

- :func:`bulk_action(action_key, repo, ...)` -- programmatic entrypoint.
- :func:`main(argv)` -- CLI dispatcher invoked by ``tasks/triage-bulk.yml``.

The four CLI sub-actions exposed via ``argparse``:

- ``bulk-accept``     -> ``triage_actions.accept(N, repo)``
- ``bulk-reject``     -> ``triage_actions.reject(N, repo, reason=...)``
- ``bulk-defer``      -> ``triage_actions.defer(N, repo)``
- ``bulk-needs-ac``   -> ``triage_actions.needs_ac(N, repo)``

Filter flags (combinable, AND semantics):

- ``--label <name>``   match a label by name on the issue.
- ``--author <login>`` match the GitHub author login.
- ``--age-days <N>``   match issues older than ``now - N days``.
- ``--cluster <slug>`` match a ``cluster:<slug>`` (or bare ``<slug>``) label.

Cache contract (#883 Story 3 rebind onto cache:*)
-------------------------------------------------

The candidate universe is read via the unified cache: for each issue
cached under ``.deft-cache/github-issue/<owner>/<repo>/<N>/`` we call
:func:`scripts.cache.cache_get` (which validates ``meta.json`` against
the schema) and reload the matching ``raw.json`` for the per-issue
payload (number / labels / author / createdAt / ...). Live
``gh issue list`` calls are forbidden in this module -- the cache is
the read surface for the triage workflow.

When the per-repo cache is missing or empty, :func:`bulk_action` raises
:class:`CacheEmptyError` and :func:`main` exits with status ``2`` and
the canonical message::

    triage_bulk: cache is empty for {repo}; run `task triage:bootstrap` first.

Audit-log short-circuit (preserves #915 fix invariants)
-------------------------------------------------------

Before applying the chosen action, the cached candidate set is
intersected with Story 2's append-only audit log
(:mod:`candidates_log`). For each candidate, the LATEST recorded
decision (by ``timestamp``) determines whether the candidate is
skipped:

- **Terminal decisions** (``accept``, ``reject``, ``mark-duplicate``)
  are ALWAYS skipped.
- **In-progress decisions** (``defer``, ``needs-ac``) are skipped
  UNLESS the operator passes ``--re-action`` (CLI) /
  ``re_action=True`` (Python).
- ``reset`` is non-skipping by design.

Zero-match exits cleanly with status 0 and a single stdout line.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import re
import sys
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Surface sibling ``scripts`` modules so the cache walk and audit-log
# read resolve when this file is invoked via
# ``python scripts/triage_bulk.py`` from a Taskfile dispatch.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Mapping from CLI sub-action keyword to the ``triage_actions`` module
# attribute resolved at runtime.
ACTION_FN_NAMES: dict[str, str] = {
    "accept": "accept",
    "reject": "reject",
    "defer": "defer",
    "needs-ac": "needs_ac",
}

#: Audit-log decisions that ALWAYS short-circuit a bulk action.
TERMINAL_DECISIONS: frozenset[str] = frozenset({"accept", "reject", "mark-duplicate"})

#: Audit-log decisions that short-circuit unless the operator opts in via
#: ``--re-action``.
IN_PROGRESS_DECISIONS: frozenset[str] = frozenset({"defer", "needs-ac"})

#: ``owner/repo`` parser used to derive cache-layout segments.
_REPO_RE: re.Pattern[str] = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)$"
)

#: Cache source consumed by triage v1 (only github-issue is supported).
_CACHE_SOURCE: str = "github-issue"


class CacheEmptyError(RuntimeError):
    """Raised by :func:`bulk_action` when the per-repo cache is missing/empty."""


def _parse_repo(repo: str) -> tuple[str, str]:
    """Validate ``owner/repo`` and return ``(owner, name)``."""

    if not isinstance(repo, str) or not repo:
        raise ValueError(
            f"repo must be a non-empty 'owner/name' string (got {repo!r})"
        )
    m = _REPO_RE.match(repo.strip())
    if not m:
        raise ValueError(
            f"invalid repo {repo!r}: expected 'owner/name' "
            "(alphanumerics, '.', '_', '-' only)"
        )
    return m.group(1), m.group(2)


def _load_triage_actions() -> Any:
    """Lazy-import the Story 3 actions module."""

    for candidate in ("triage_actions", "scripts.triage_actions"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    raise RuntimeError(
        "triage_actions module not available -- Story 3 has not landed in "
        "this checkout. Install the cache+actions cohort or stub triage_actions "
        "in sys.modules before invoking bulk ops."
    )


def _load_candidates_log() -> Any:
    """Lazy-import Story 2's :mod:`candidates_log` (for ``read_all``)."""

    for candidate in ("candidates_log", "scripts.candidates_log"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    raise RuntimeError(
        "candidates_log module not available -- cannot intersect the cached "
        "candidate set with the audit log."
    )


def _load_cache_module() -> Any:
    """Lazy-import the unified cache module (#883 Story 2)."""

    for candidate in ("cache", "scripts.cache"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    raise RuntimeError(
        "cache module not available -- #883 Story 2 has not landed in this "
        "checkout. Cannot read the unified content cache without it."
    )


def _cache_root(cache_root: Path | None) -> Path:
    return Path(cache_root) if cache_root is not None else Path(".deft-cache")


def _iter_cache_keys(repo: str, *, cache_root: Path | None = None) -> list[str]:
    """Walk the cache layout and return canonical ``owner/repo/N`` keys.

    The unified layout is ``.deft-cache/github-issue/<owner>/<repo>/<N>/``;
    only directories whose name parses as a positive integer are surfaced
    so ad-hoc artefacts do not poison the candidate walk.
    """

    owner, name = _parse_repo(repo)
    base = _cache_root(cache_root) / _CACHE_SOURCE / owner / name
    if not base.is_dir():
        return []
    keys: list[str] = []
    for entry in sorted(base.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        if not entry.name.isdigit():
            continue
        keys.append(f"{owner}/{name}/{entry.name}")
    return keys


def list_cached_candidates(
    repo: str,
    *,
    cache_root: Path | None = None,
    cache_module: Any | None = None,
    out: Any | None = None,
) -> list[dict[str, Any]]:
    """Return parsed issue payloads sourced through ``cache:get``.

    For every key under the unified ``github-issue`` cache layout, we call
    :func:`scripts.cache.cache_get` (which validates ``meta.json`` against
    the schema) and re-load the per-entry ``raw.json`` to recover the
    original issue payload. Malformed / unreadable files are logged on
    ``out`` and skipped -- the bulk operation never aborts mid-walk on a
    single bad cache entry. Missing cache directory yields ``[]``.
    """

    sink = out if out is not None else sys.stderr
    cache_mod = cache_module if cache_module is not None else _load_cache_module()
    root = _cache_root(cache_root)
    keys = _iter_cache_keys(repo, cache_root=root)

    candidates: list[dict[str, Any]] = []
    not_found_exc = getattr(cache_mod, "CacheNotFoundError", LookupError)
    cache_error_exc = getattr(cache_mod, "CacheError", RuntimeError)
    validation_exc = getattr(cache_mod, "CacheValidationError", ValueError)

    for key in keys:
        try:
            result = cache_mod.cache_get(
                _CACHE_SOURCE, key, cache_root=root, allow_stale=True
            )
        except not_found_exc as exc:  # type: ignore[misc]
            print(f"[triage:bulk] WARN: cache miss for {key}: {exc}", file=sink)
            continue
        except validation_exc as exc:  # type: ignore[misc]
            print(
                f"[triage:bulk] WARN: invalid meta.json for {key}: {exc}",
                file=sink,
            )
            continue
        except cache_error_exc as exc:  # type: ignore[misc]
            print(f"[triage:bulk] WARN: cache error for {key}: {exc}", file=sink)
            continue

        raw_path = Path(result.entry_dir) / "raw.json"
        try:
            raw_text = raw_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            print(
                f"[triage:bulk] WARN: skipping unreadable raw.json for {key}: "
                f"{type(exc).__name__}: {exc}",
                file=sink,
            )
            continue
        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            print(
                f"[triage:bulk] WARN: skipping malformed raw.json for {key}: {exc}",
                file=sink,
            )
            continue
        if not isinstance(payload, dict):
            print(
                f"[triage:bulk] WARN: skipping non-object raw.json for {key} "
                f"(got {type(payload).__name__})",
                file=sink,
            )
            continue
        candidates.append(payload)
    return candidates


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
            entry.get("name")
            for entry in issue.get("labels", []) or []
            if isinstance(entry, dict)
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
                created_at = datetime.fromisoformat(
                    str(created_raw).replace("Z", "+00:00")
                )
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


def _build_skip_set(re_action: bool) -> frozenset[str]:
    """Return the set of latest-decision values that disqualify a candidate."""

    if re_action:
        return TERMINAL_DECISIONS
    return TERMINAL_DECISIONS | IN_PROGRESS_DECISIONS


def _latest_decision_by_issue(
    repo: str, *, candidates_log_module: Any | None = None
) -> dict[int, dict[str, Any]]:
    """Return ``{issue_number: latest-entry-dict}`` for ``repo``."""

    module = (
        candidates_log_module
        if candidates_log_module is not None
        else _load_candidates_log()
    )
    read_all = getattr(module, "read_all", None)
    if not callable(read_all):
        raise RuntimeError(
            "candidates_log.read_all not callable (Story 2 contract violated)"
        )

    latest: dict[int, dict[str, Any]] = {}
    for entry in read_all(repo=repo):
        if not isinstance(entry, dict):
            continue
        n = entry.get("issue_number")
        if not isinstance(n, int) or isinstance(n, bool):
            continue
        ts = str(entry.get("timestamp", ""))
        prior = latest.get(n)
        if prior is None or ts > str(prior.get("timestamp", "")):
            latest[n] = entry
    return latest


def _exclude_logged(
    candidates: Iterable[dict[str, Any]],
    *,
    repo: str,
    re_action: bool,
    candidates_log_module: Any | None = None,
    out: Any | None = None,
) -> list[dict[str, Any]]:
    """Drop candidates whose latest audit decision is in the skip set."""

    skip_set = _build_skip_set(re_action)
    latest = _latest_decision_by_issue(
        repo, candidates_log_module=candidates_log_module
    )

    kept: list[dict[str, Any]] = []
    skipped = 0
    for issue in candidates:
        try:
            n = int(issue["number"])
        except (KeyError, TypeError, ValueError):
            kept.append(issue)
            continue
        prior = latest.get(n)
        if prior is None:
            kept.append(issue)
            continue
        if str(prior.get("decision", "")) in skip_set:
            skipped += 1
            continue
        kept.append(issue)

    if skipped:
        msg = (
            f"[triage:bulk] skipped {skipped} candidate(s) with prior "
            "audit-log records"
        )
        if not re_action:
            msg += " (pass --re-action to override defer/needs-ac records)"
        sink = out if out is not None else sys.stderr
        print(msg, file=sink)
    return kept


def _resolve_action(actions_module: Any, action_key: str) -> Callable[..., Any]:
    fn_name = ACTION_FN_NAMES[action_key]
    fn = getattr(actions_module, fn_name, None)
    if not callable(fn):
        raise RuntimeError(
            f"triage_actions.{fn_name} not found (Story 3 contract violated)"
        )
    return fn  # type: ignore[no-any-return]


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
    """Call a Story 3 single-issue action with kwargs, falling back to positional."""

    kwargs: dict[str, Any] = {}
    if action_key == "reject" and reason is not None:
        kwargs["reason"] = reason
    try:
        fn(issue_number, repo, **kwargs)
    except TypeError as exc:
        if not _is_signature_mismatch(exc):
            raise
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
    re_action: bool = False,
    cache_root: Path | None = None,
    actions_module: Any | None = None,
    cache_module: Any | None = None,
    candidates_log_module: Any | None = None,
    issues_provider: Callable[[str], list[dict[str, Any]]] | None = None,
    now: datetime | None = None,
    out: Any | None = None,
) -> int:
    """Execute ``action_key`` over the filtered candidate set."""

    if action_key not in ACTION_FN_NAMES:
        raise ValueError(f"Unknown bulk action: {action_key!r}")

    sink = out or sys.stdout
    if issues_provider is not None:
        candidates = issues_provider(repo)
    else:
        candidates = list_cached_candidates(
            repo,
            cache_root=cache_root,
            cache_module=cache_module,
            out=sink,
        )

    if not candidates:
        raise CacheEmptyError(
            f"triage_bulk: cache is empty for {repo}; "
            "run `task triage:bootstrap` first."
        )

    matched = _filter_issues(
        candidates,
        label=label,
        author=author,
        age_days=age_days,
        cluster=cluster,
        now=now,
    )

    matched = _exclude_logged(
        matched,
        repo=repo,
        re_action=re_action,
        candidates_log_module=candidates_log_module,
        out=sink,
    )

    if not matched:
        print(
            f"[triage:bulk-{action_key}] zero matches for given filters",
            file=sink,
        )
        return 0

    module = actions_module if actions_module is not None else _load_triage_actions()
    fn = _resolve_action(module, action_key)

    actioned = 0
    for issue in matched:
        try:
            issue_number = int(issue["number"])
        except (KeyError, TypeError, ValueError):
            print(
                f"[triage:bulk-{action_key}] skipping malformed issue entry: "
                f"{issue!r}",
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
        description=(
            "Bulk triage operations over the unified cache (#845 Story 4 "
            "/ #883 Story 3 rebind)"
        ),
    )
    parser.add_argument(
        "action",
        choices=list(ACTION_FN_NAMES.keys()),
        help="bulk action to apply (accept|reject|defer|needs-ac)",
    )
    parser.add_argument("--repo", required=True, help="GitHub repo, owner/name")
    parser.add_argument(
        "--label", default=None, help="filter: only issues carrying this label"
    )
    parser.add_argument(
        "--author",
        default=None,
        help="filter: only issues authored by this GitHub login",
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
        "--re-action",
        action="store_true",
        dest="re_action",
        help=(
            "Re-action candidates whose LATEST audit-log record is `defer` or "
            "`needs-ac` (#915). Without this flag, in-progress records "
            "short-circuit the bulk run; terminal records "
            "(accept|reject|mark-duplicate) ALWAYS short-circuit regardless."
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
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_bulk", argv)
    if rc is not None:
        return rc
    args = _build_parser().parse_args(argv)
    try:
        bulk_action(
            args.action,
            args.repo,
            label=args.label,
            author=args.author,
            age_days=args.age_days,
            cluster=args.cluster,
            reason=args.reason,
            re_action=args.re_action,
        )
    except CacheEmptyError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
