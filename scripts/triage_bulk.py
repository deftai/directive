#!/usr/bin/env python3
"""triage_bulk.py -- Story 4 bulk triage ops over cached candidates (#845).

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

Cache contract (#915 fix)
-------------------------

The candidate universe is the local Tier-1 cache: ``.deft-cache/issues/<owner>-<repo>/*.json``
(written by Story 1's :func:`triage_cache.populate`). Live ``gh issue list``
calls are forbidden in this module -- the cache is the read surface for the
triage workflow and bypassing it violates the contract documented in
``skills/deft-directive-refinement/SKILL.md`` and the #845 epic vBRIEF.

When the per-repo cache directory is missing or empty, :func:`bulk_action`
raises :class:`CacheEmptyError` and :func:`main` exits with status ``2`` and
the canonical message::

    triage_bulk: cache is empty for {repo}; run `task triage:bootstrap` first.

Audit-log short-circuit (#915 fix)
----------------------------------

Before applying the chosen action, the cached candidate set is intersected
with Story 2's append-only audit log (:mod:`candidates_log`). For each
candidate, the LATEST recorded decision (by ``timestamp``) determines
whether the candidate is skipped:

- **Terminal decisions** (``accept``, ``reject``, ``mark-duplicate``) are
  ALWAYS skipped -- a re-run never repeats a terminal action.
- **In-progress decisions** (``defer``, ``needs-ac``) are skipped UNLESS
  the operator passes ``--re-action`` (CLI) / ``re_action=True`` (Python).
- ``reset`` is non-skipping by design (the operator explicitly wiped the
  prior verdict; the candidate is back in scope).

The intersection prevents the append-only log from being poisoned by
repeated bulk-defer / bulk-needs-ac runs and makes ``bulk_action``
idempotent on a steady cache.

Zero-match exits cleanly with status 0 and a single stdout line so this
script is safe to run inside a swarm pipeline.

Looping over Story 3 (``triage_actions``) is intentional; bulk MUST NOT
expose its own parallel surface (#845 Story 4 Constraint).
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import sys
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Surface sibling ``scripts`` modules so the cache walk and audit-log read
# resolve when this file is invoked via ``python scripts/triage_bulk.py``
# from a Taskfile dispatch (mirrors the pattern in triage_bootstrap.py).
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Mapping from CLI sub-action keyword to the ``triage_actions`` module attribute
# resolved at runtime. Story 3's contracted public surface is documented in
# ``vbrief/active/2026-05-03-845-triage-actions.vbrief.json``.
ACTION_FN_NAMES: dict[str, str] = {
    "accept": "accept",
    "reject": "reject",
    "defer": "defer",
    "needs-ac": "needs_ac",
}

#: Audit-log decisions that ALWAYS short-circuit a bulk action. A bulk run
#: that re-applies a terminal verdict is the audit-log poisoning class the
#: #915 fix exists to prevent.
TERMINAL_DECISIONS: frozenset[str] = frozenset({"accept", "reject", "mark-duplicate"})

#: Audit-log decisions that short-circuit a bulk action UNLESS the operator
#: opts in via ``--re-action``. ``defer`` / ``needs-ac`` are non-terminal but
#: are still in-progress -- a second pass should not silently re-defer them.
IN_PROGRESS_DECISIONS: frozenset[str] = frozenset({"defer", "needs-ac"})


class CacheEmptyError(RuntimeError):
    """Raised by :func:`bulk_action` when the per-repo cache is missing/empty.

    :func:`main` translates this into an exit-2 with the canonical stderr
    message; programmatic callers that want a different recovery path can
    catch the exception directly.
    """


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


def _load_triage_cache() -> Any:
    """Lazy-import Story 1's :mod:`triage_cache` (for ``cache_dir``)."""

    for candidate in ("triage_cache", "scripts.triage_cache"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    raise RuntimeError(
        "triage_cache module not available -- Story 1 has not landed in this "
        "checkout. Cannot walk the cache without it."
    )


def _load_candidates_log() -> Any:
    """Lazy-import Story 2's :mod:`candidates_log` (for ``read_all``)."""

    for candidate in ("candidates_log", "scripts.candidates_log"):
        try:
            return importlib.import_module(candidate)
        except ModuleNotFoundError:
            continue
    raise RuntimeError(
        "candidates_log module not available -- Story 2 has not landed in "
        "this checkout. Cannot intersect the cached candidate set with the "
        "audit log."
    )


def _resolve_cache_dir(
    repo: str,
    *,
    cache_root: Path | None = None,
    triage_cache_module: Any | None = None,
) -> Path:
    """Return the per-repo cache directory ``<cache_root>/<owner>-<repo>/``.

    Delegates to :func:`triage_cache.cache_dir` so the layout stays in
    lockstep with Story 1 (flattened ``owner-repo`` for Windows path-length
    safety). The ``triage_cache_module`` hook keeps this unit-testable
    without forking a real Python import.
    """

    module = triage_cache_module if triage_cache_module is not None else _load_triage_cache()
    cache_dir_fn = getattr(module, "cache_dir", None)
    if not callable(cache_dir_fn):
        raise RuntimeError("triage_cache.cache_dir not callable (Story 1 contract violated)")
    return Path(cache_dir_fn(repo, cache_root=cache_root))


def _list_cached_candidates(
    repo: str,
    *,
    cache_root: Path | None = None,
    triage_cache_module: Any | None = None,
    out: Any | None = None,
) -> list[dict[str, Any]]:
    """Walk the per-repo cache and return parsed issue payloads.

    Reads every ``<cache_root>/<owner>-<repo>/*.json`` sidecar (the JSON
    file written by :func:`triage_cache.populate`) and returns a list of
    dicts in the same shape ``_filter_issues`` expects -- the cached
    payload already carries ``number``, ``title``, ``labels``, ``author``,
    ``createdAt``, ``updatedAt`` per ``triage_cache._GH_FIELDS``.

    Tolerance contract: a malformed JSON sidecar (truncated write, manual
    edit, encoding glitch) is logged on ``out`` and skipped -- the rest of
    the cache is still surfaced. The bulk operation never aborts mid-walk
    on a single bad file.

    Returns an empty list when the cache directory is missing or empty.
    Callers translate that into the canonical empty-cache hard-fail.
    """

    sink = out or sys.stderr
    cache_path = _resolve_cache_dir(
        repo, cache_root=cache_root, triage_cache_module=triage_cache_module
    )

    if not cache_path.exists() or not cache_path.is_dir():
        return []

    candidates: list[dict[str, Any]] = []
    for json_path in sorted(cache_path.glob("*.json")):
        try:
            raw = json_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            print(
                f"[triage:bulk] WARN: skipping unreadable cache file "
                f"{json_path.name}: {type(exc).__name__}: {exc}",
                file=sink,
            )
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(
                f"[triage:bulk] WARN: skipping malformed cache file "
                f"{json_path.name}: {exc}",
                file=sink,
            )
            continue
        if not isinstance(payload, dict):
            print(
                f"[triage:bulk] WARN: skipping non-object cache file "
                f"{json_path.name} (got {type(payload).__name__})",
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


def _build_skip_set(re_action: bool) -> frozenset[str]:
    """Return the set of latest-decision values that disqualify a candidate.

    Terminal decisions (``accept``, ``reject``, ``mark-duplicate``) ALWAYS
    skip. In-progress decisions (``defer``, ``needs-ac``) skip unless
    ``re_action`` is True -- the explicit opt-in path for re-running a
    bulk-defer / bulk-needs-ac on a backlog the operator already touched.
    """

    if re_action:
        return TERMINAL_DECISIONS
    return TERMINAL_DECISIONS | IN_PROGRESS_DECISIONS


def _latest_decision_by_issue(
    repo: str, *, candidates_log_module: Any | None = None
) -> dict[int, dict[str, Any]]:
    """Return ``{issue_number: latest-entry-dict}`` for ``repo``.

    Sorted by ISO-8601 ``timestamp`` lexicographic order (Story 2's
    candidates_log enforces UTC-Z suffixes so this is chronologically
    correct). Issues with no audit history are absent from the map.
    """

    module = (
        candidates_log_module if candidates_log_module is not None else _load_candidates_log()
    )
    read_all = getattr(module, "read_all", None)
    if not callable(read_all):
        raise RuntimeError("candidates_log.read_all not callable (Story 2 contract violated)")

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
    """Drop candidates whose latest audit decision is in the skip set.

    See :func:`_build_skip_set` for the skip-set rules. Emits a single-line
    summary on ``out`` so the operator sees how many candidates were
    short-circuited by Tier-2 -- silent drops would mask the audit-log
    contract.
    """

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
            # Malformed cache record -- the per-action loop will report it.
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
        msg = f"[triage:bulk] skipped {skipped} candidate(s) with prior audit-log records"
        if not re_action:
            msg += " (pass --re-action to override defer/needs-ac records)"
        # Default to stderr when callers invoke `_exclude_logged` directly with
        # out=None -- the prior `if out is not None` short-circuit was dead
        # code under bulk_action (which always passes a non-None sink) AND
        # silently dropped the diagnostic for direct callers (Greptile #920).
        sink = out if out is not None else sys.stderr
        print(msg, file=sink)
    return kept


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
    re_action: bool = False,
    cache_root: Path | None = None,
    actions_module: Any | None = None,
    triage_cache_module: Any | None = None,
    candidates_log_module: Any | None = None,
    issues_provider: Callable[[str], list[dict[str, Any]]] | None = None,
    now: datetime | None = None,
    out: Any | None = None,
) -> int:
    """Execute ``action_key`` over the filtered candidate set.

    Returns the count of issues actioned. Zero matches returns ``0`` and
    emits a single-line summary -- the caller MUST treat this as a clean
    exit.

    Raises :class:`CacheEmptyError` when the per-repo cache directory is
    missing or empty -- the empty-cache hard-fail required by the #915 fix.
    Callers (CLI ``main``) translate this into an exit-2 with the canonical
    stderr message. Programmatic callers that want a degraded recovery path
    can catch :class:`CacheEmptyError` directly.

    Dependency-injection hooks keep this surface unit-testable without
    forking a real ``gh`` subprocess or importing not-yet-landed sibling
    modules.
    """

    if action_key not in ACTION_FN_NAMES:
        raise ValueError(f"Unknown bulk action: {action_key!r}")

    sink = out or sys.stdout
    if issues_provider is not None:
        candidates = issues_provider(repo)
    else:
        candidates = _list_cached_candidates(
            repo,
            cache_root=cache_root,
            triage_cache_module=triage_cache_module,
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
        description="Bulk triage operations over cached candidate sets (#845 Story 4 / #915)",
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
    # Zero-match is a clean exit per #845 Story 4 Constraint.
    return 0


if __name__ == "__main__":
    sys.exit(main())
