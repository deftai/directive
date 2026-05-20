#!/usr/bin/env python3
"""_cache_fetch.py -- cache:fetch-all orchestrator (#883 Story 2 + #1239 REST migration).

Drives the per-repo bootstrap mirror that writes one
``.deft-cache/github-issue/<owner>/<repo>/<N>/`` entry per upstream
issue. Lives in a separate module from :mod:`cache` to keep the parent
under the 1000-line MUST limit from ``coding/coding.md``.

#1239 / Writer-side REST migration
----------------------------------
Pre-#1239 the orchestrator drained the GraphQL bucket via ``task
scm:issue:list`` + ``task scm:issue:view`` (one round trip per issue,
~1.27s/issue on the 2026-05-19 dogfood). The 396-issue cohort burned
~8.5 minutes and ~400 GraphQL points while the REST ``core`` bucket
sat idle. This module now drives the enumeration through the paginated
REST endpoint :func:`gh_rest.rest_issue_list_paginated` (a 396-issue
cohort fans out to 4 round trips at ``per_page=100``) and consumes the
full REST issue payload directly -- no per-issue follow-up fetch is
needed because ``GET /repos/.../issues`` returns ``title`` / ``body`` /
``state`` / ``labels`` / ``updated_at`` inline.

Cached payloads now carry the canonical lowercase ``"state": "open"``
(REST shape) -- this is the writer-side fix that #1236's reader-side
defensive lowercase compare also addresses for any pre-migration cache
still on disk.

Test seams
----------
- :data:`_paginated_lister` -- callable matching ``rest_issue_list_paginated``.
  Tests rebind it to deterministic fakes via ``monkeypatch.setattr``.
- :data:`_sleep` -- ``time.sleep``. Tests rebind for hermetic per-issue
  delay coverage.
- :data:`_run_subprocess` -- legacy alias preserved for tests still
  pinning the GraphQL flow. New paths route through the REST seam.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when this script is
# executed via ``python scripts/_cache_fetch.py`` from a Taskfile
# dispatch.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gh_rest import (  # noqa: E402  -- intentional sys.path tweak
    GhRestError,
    InvalidRepoError,
    rest_issue_list_paginated,
)

# ---------------------------------------------------------------------------
# Test seams (module-level callables; monkeypatched by tests)
# ---------------------------------------------------------------------------

#: Paginated REST issue lister. Tests rebind to a deterministic fake via
#: ``monkeypatch.setattr(_cache_fetch, "_paginated_lister", fake)``.
_paginated_lister: Callable[..., list[dict[str, Any]]] = rest_issue_list_paginated

#: Sleep callable; tests rebind to a no-op so the per-issue delay loop
#: doesn't burn wall-clock.
_sleep: Callable[[float], None] = time.sleep

#: Legacy subprocess seam preserved for back-compat with tests that
#: pinned the pre-#1239 GraphQL flow. Unused on the REST path.
_run_subprocess: Callable[..., Any] = subprocess.run

#: Compiled rate-limit detector. Matches the canonical 429 surfaces
#: emitted by gh / ghx in stderr; retained for the REST flow because
#: the REST core bucket can also throttle (5,000/hr/user).
_RATE_LIMIT_RE: re.Pattern[str] = re.compile(
    r"(?:HTTP\s*429|API rate limit exceeded|rate limit exceeded)", re.IGNORECASE
)
_RETRY_AFTER_RE: re.Pattern[str] = re.compile(r"Retry-After:\s*(\d+)", re.IGNORECASE)

#: Fallback Retry-After interval when the 429 stderr text omits the
#: header. 60s mirrors GitHub's documented per-token recovery cadence.
DEFAULT_RETRY_AFTER_FALLBACK_S: int = 60


class CacheFetchError(RuntimeError):
    """Subprocess / parse failure during fetch-all orchestration."""


# ---------------------------------------------------------------------------
# Rate-limit detection (REST core bucket recovery)
# ---------------------------------------------------------------------------


def detect_rate_limit(stderr: str) -> tuple[bool, int]:
    """Detect a 429 / rate-limit response in subprocess stderr.

    Returns ``(is_rate_limited, retry_after_seconds)``. When the
    Retry-After header is absent, the fallback constant is returned.
    """
    if not stderr or not _RATE_LIMIT_RE.search(stderr):
        return False, DEFAULT_RETRY_AFTER_FALLBACK_S
    m = _RETRY_AFTER_RE.search(stderr)
    if m:
        try:
            return True, int(m.group(1))
        except ValueError:
            return True, DEFAULT_RETRY_AFTER_FALLBACK_S
    return True, DEFAULT_RETRY_AFTER_FALLBACK_S


# ---------------------------------------------------------------------------
# REST normalisation
# ---------------------------------------------------------------------------


def _normalise_rest_issue(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a defensive copy of the REST issue payload with canonical fields.

    REST already emits the field shapes downstream consumers want
    (``state`` lowercase, ``updated_at`` snake_case, ``labels`` as list
    of objects). We only:

    * Ensure ``state`` is lowercase (defensive -- the REST API is
      lowercase by contract, but a future gh / ghx version that
      capitalised the value would otherwise re-introduce the #1236
      reader-side regression).

    The dict is shallow-copied so callers can mutate further without
    aliasing the underlying ``gh api`` response.
    """
    out = dict(raw)
    state = out.get("state")
    if isinstance(state, str):
        out["state"] = state.lower()
    return out


# ---------------------------------------------------------------------------
# Result aggregator
# ---------------------------------------------------------------------------


@dataclass
class FetchAllReport:
    """Aggregate counts returned by :func:`run_fetch_all`.

    Counter terminology (#1247)
    ---------------------------
    Pre-#1247 the report exposed three counters named ``succeeded`` /
    ``failed`` / ``skipped``. Operators read the recap line
    ``cache:fetch-all ... succeeded=1 failed=0 skipped=396`` as "1 of
    397 items processed, 396 dropped" and assumed something was wrong
    -- when in fact ``succeeded`` counted per-issue cache writes that
    actually landed on disk (a fresh fetch + put), ``skipped`` counted
    per-issue entries that were already-fresh in the cache (TTL window
    still valid, so no re-fetch was needed), and ``failed`` counted
    per-issue write errors. The terminology was at three different
    levels of abstraction.

    The canonical attribute names are now ``issues_written`` /
    ``already_fresh`` / ``issues_failed``. The legacy ``succeeded`` /
    ``failed`` / ``skipped`` attributes remain as backward-compatible
    aliases (read-write) so external callers and tests that still
    reference the old names keep working until they migrate.

    :meth:`to_json` emits the new keys as the primary surface and
    duplicates them under the legacy keys for one release. The
    :meth:`summary_line` renderer produces the unambiguous human-
    readable string the triage:bootstrap recap and ``task
    cache:fetch-all`` direct invocations consume.
    """

    #: Per-issue cache writes that landed (fresh fetch + put). Was named
    #: ``succeeded`` pre-#1247.
    issues_written: int = 0
    #: Per-issue cache writes that errored out. Was named ``failed``
    #: pre-#1247.
    issues_failed: int = 0
    #: Per-issue entries skipped because the on-disk cache was still
    #: within its TTL window (no re-fetch needed). Was named ``skipped``
    #: pre-#1247 -- the source of the misleading "why are 396 things
    #: skipped?" first-read.
    already_fresh: int = 0
    failures: list[dict[str, str]] = field(default_factory=list)

    # ----- Backward-compat property aliases (#1247) -----
    #
    # External callers (scripts/triage_bootstrap.py recap line,
    # tests/test_cache.py, tests/integration/test_cache_*.py) still
    # read ``report.succeeded`` / ``report.failed`` / ``report.skipped``.
    # The aliases below preserve that surface so the rename is non-
    # breaking; new code SHOULD use the canonical names above.

    @property
    def succeeded(self) -> int:
        """Legacy alias for :attr:`issues_written` (#1247)."""
        return self.issues_written

    @succeeded.setter
    def succeeded(self, value: int) -> None:
        self.issues_written = value

    @property
    def failed(self) -> int:
        """Legacy alias for :attr:`issues_failed` (#1247)."""
        return self.issues_failed

    @failed.setter
    def failed(self, value: int) -> None:
        self.issues_failed = value

    @property
    def skipped(self) -> int:
        """Legacy alias for :attr:`already_fresh` (#1247)."""
        return self.already_fresh

    @skipped.setter
    def skipped(self, value: int) -> None:
        self.already_fresh = value

    def to_json(self) -> str:
        """Serialise the report.

        v1 emits both the canonical (#1247) and legacy keys so existing
        consumers (``tests/test_cache.py::test_partial_failure_exit_shape``
        asserts ``payload["succeeded"]`` / ``payload["failed"]``) keep
        passing while the framework completes the rename rollout. The
        legacy duplicates are removed in a future release once the rest
        of the consumer tree has migrated.
        """
        return json.dumps(
            {
                # Canonical (#1247) -- the unambiguous noun-level surface.
                "issues_written": self.issues_written,
                "already_fresh": self.already_fresh,
                "issues_failed": self.issues_failed,
                # Legacy aliases preserved one release for back-compat.
                "succeeded": self.issues_written,
                "failed": self.issues_failed,
                "skipped": self.already_fresh,
                "failures": self.failures,
            },
            ensure_ascii=False,
            sort_keys=True,
        )

    def summary_line(self, *, source: str, repo: str) -> str:
        """Render the unambiguous human-readable recap line (#1247).

        Replaces the misleading ``succeeded=1 failed=0 skipped=396``
        formatting with explicit per-issue counter names so an operator
        reading the first signal of a bootstrap run does not have to
        ask "why are 396 things skipped?". The naming follows the GH
        issue body's 'Expected' suggestion:

            cache:fetch-all source=github-issue repo=owner/name
            issues_written=1 already_fresh=396 issues_failed=0

        Operators / orchestrators / recap formatters that need a
        single-line, machine-greppable status string SHOULD prefer this
        method over hand-formatting against the individual attributes.
        """
        return (
            f"cache:fetch-all source={source} repo={repo} "
            f"issues_written={self.issues_written} "
            f"already_fresh={self.already_fresh} "
            f"issues_failed={self.issues_failed}"
        )


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_fetch_all(
    *,
    repo: str,
    is_fresh: Callable[[Path], bool],
    entry_dir_for: Callable[[str], Path],
    do_put: Callable[[str, dict[str, Any]], None],
    batch_size: int,
    delay_ms: int,
    state: str,
    limit: int,
) -> FetchAllReport:
    """Drive the cache:fetch-all loop via paginated REST.

    Args:
        repo: Validated ``owner/repo`` slug.
        is_fresh: Callable ``meta_path -> bool`` that returns True when
            the on-disk meta.json is fresh per its TTL. Caller-supplied
            so this module does not import the cache layer's validator
            directly.
        entry_dir_for: Callable ``key -> Path`` that maps a cache key to
            the entry directory path.
        do_put: Callable ``(key, raw) -> None`` that persists the issue
            via cache:put. Raises on failure.
        batch_size: Per-issue checkpoint cadence for the inter-issue
            delay. Validated > 0 by the caller. Pre-#1239 this also
            controlled the GraphQL fan-out; on the REST path the
            enumeration cost is amortised across pages so the parameter
            only paces the local cache:put loop.
        delay_ms: Per-issue inter-call delay (ms). Validated >= 0 by the
            caller.
        state: Forwarded to ``rest_issue_list_paginated --state``
            (``open``/``closed``/``all``).
        limit: Forwarded to ``rest_issue_list_paginated --limit``.

    Returns:
        :class:`FetchAllReport` with per-issue success / failure /
        skipped counts and a structured failures list.

    Raises:
        CacheFetchError: When the REST enumeration itself fails (the
            cohort cannot be listed). Per-issue ``cache:put`` failures
            are captured on the report, not raised.
    """
    issues = _list_issues_rest(repo, state=state, limit=limit)
    report = FetchAllReport()

    for i, issue in enumerate(issues):
        raw = _normalise_rest_issue(issue)
        number = raw.get("number")
        if not isinstance(number, int) or number <= 0:
            report.issues_failed += 1
            report.failures.append(
                {"key": f"{repo}/?", "reason": f"invalid 'number' field: {number!r}"}
            )
            continue

        key = f"{repo}/{number}"
        edir = entry_dir_for(key)
        if is_fresh(edir / "meta.json"):
            report.already_fresh += 1
            continue

        try:
            do_put(key, raw)
            report.issues_written += 1
        except Exception as exc:  # noqa: BLE001 -- caller's CacheError variants
            report.issues_failed += 1
            report.failures.append({"key": key, "reason": str(exc)})

        # Per-issue delay; batch-size checkpoint adds an extra pause so a
        # quota-pressured run still has a chance to recover between
        # cache:put writes (the REST core bucket can throttle just like
        # GraphQL, even though it has a 10x larger headroom).
        _maybe_sleep(delay_ms)
        if (i + 1) % batch_size == 0:
            _maybe_sleep(delay_ms)

    return report


def _list_issues_rest(repo: str, *, state: str, limit: int) -> list[dict[str, Any]]:
    """Wrap :func:`rest_issue_list_paginated` with retry on REST 429.

    REST's ``core`` bucket has a 5000/hr/user budget -- much larger than
    GraphQL's, but still throttleable on hot swarm sessions. On a 429
    we honour the gh-reported Retry-After (or the fallback constant)
    and try once more before surfacing the failure.
    """
    try:
        return _paginated_lister(repo, state=state, limit=limit)
    except InvalidRepoError as exc:
        raise CacheFetchError(f"invalid --repo {repo!r} for REST list enumeration: {exc}") from exc
    except GhRestError as exc:
        is_429, retry_after = detect_rate_limit(str(exc) or exc.stderr or "")
        if not is_429:
            raise CacheFetchError(
                f"rest_issue_list_paginated failed for repo={repo}: {exc}"
            ) from exc
        sys.stderr.write(
            f"cache:fetch-all rate-limited on enumeration ({repo}); sleeping "
            f"{retry_after}s before retry\n"
        )
        _sleep(retry_after)
        try:
            return _paginated_lister(repo, state=state, limit=limit)
        except GhRestError as exc2:
            raise CacheFetchError(
                f"rest_issue_list_paginated failed twice for repo={repo}: {exc2}"
            ) from exc2


def _maybe_sleep(delay_ms: int) -> None:
    if delay_ms > 0:
        _sleep(delay_ms / 1000.0)
