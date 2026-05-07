#!/usr/bin/env python3
"""_cache_fetch.py -- cache:fetch-all orchestrator (#883 Story 2).

Extracted from :mod:`cache` to keep the parent module under the 1000-line
MUST limit from deft/main.md. The orchestrator owns:

- ``task scm:issue:list`` enumeration (one call per fetch-all run).
- ``task scm:issue:view`` per-issue fetches with batch + delay knobs.
- 429 / Retry-After detection + one retry (M1).
- TTL-based skip-fresh idempotency (M2).
- Partial-failure recovery with structured ``{succeeded, failed, skipped}``
  exit shape.

The dispatch indirection (``_run_subprocess`` / ``_sleep`` module-level
references) is the test seam: unit tests inject fakes via
``monkeypatch.setattr(_cache_fetch, "_run_subprocess", fake_run)`` rather
than mocking the global ``subprocess.run`` so the patching is visible
and scoped.
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

# Module-level test seams. Tests rebind these to deterministic fakes; the
# defaults route to real subprocess + real sleep.
_run_subprocess: Callable[..., Any] = subprocess.run
_sleep: Callable[[float], None] = time.sleep

#: Compiled rate-limit detector. Matches the canonical 429 surfaces
#: emitted by gh / ghx in stderr.
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
# Rate-limit detection
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
# Subprocess wrappers (task scm:issue:*)
# ---------------------------------------------------------------------------


def scm_view_issue(repo: str, number: int) -> tuple[dict[str, Any], str]:
    """Invoke ``task scm:issue:view`` and return ``(parsed_json, stderr)``.

    Raises :class:`CacheFetchError` on non-zero exit (rate-limit
    detection happens at the caller against ``stderr``) or unparseable
    JSON.
    """
    fields = "number,title,body,state,author,createdAt,updatedAt,labels,comments,url"
    cmd = [
        "task",
        "scm:issue:view",
        "--",
        str(number),
        "--repo",
        repo,
        "--json",
        fields,
    ]
    proc = _run_subprocess(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise CacheFetchError(
            f"task scm:issue:view exit={proc.returncode} for repo={repo} "
            f"issue={number}: {proc.stderr.strip()}"
        )
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise CacheFetchError(
            f"task scm:issue:view emitted non-JSON for repo={repo} issue={number}: {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise CacheFetchError(
            f"task scm:issue:view emitted unexpected shape for repo={repo} issue={number}: "
            f"expected object, got {type(data).__name__}"
        )
    return data, proc.stderr or ""


def scm_list_issues(
    repo: str, state: str = "open", limit: int = 1000
) -> list[dict[str, Any]]:
    """Invoke ``task scm:issue:list`` and return the parsed JSON list."""
    fields = "number,title,state,updatedAt"
    cmd = [
        "task",
        "scm:issue:list",
        "--",
        "--repo",
        repo,
        "--state",
        state,
        "--limit",
        str(limit),
        "--json",
        fields,
    ]
    proc = _run_subprocess(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise CacheFetchError(
            f"task scm:issue:list exit={proc.returncode} for repo={repo}: "
            f"{proc.stderr.strip()}"
        )
    try:
        data = json.loads(proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise CacheFetchError(
            f"task scm:issue:list emitted non-JSON for repo={repo}: {exc}"
        ) from exc
    if not isinstance(data, list):
        raise CacheFetchError(
            f"task scm:issue:list emitted unexpected shape for repo={repo}: "
            f"expected array, got {type(data).__name__}"
        )
    return data


# ---------------------------------------------------------------------------
# Result aggregator
# ---------------------------------------------------------------------------


@dataclass
class FetchAllReport:
    """Aggregate counts returned by :func:`run_fetch_all`."""

    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    failures: list[dict[str, str]] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(
            {
                "succeeded": self.succeeded,
                "failed": self.failed,
                "skipped": self.skipped,
                "failures": self.failures,
            },
            ensure_ascii=False,
            sort_keys=True,
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
    """Drive the per-issue fetch loop. Returns a :class:`FetchAllReport`.

    Args:
        repo: Validated ``owner/repo`` slug.
        is_fresh: Callable ``meta_path -> bool`` that returns True when the
            on-disk meta.json is fresh per its TTL. Caller-supplied so this
            module does not import the cache layer's validator directly.
        entry_dir_for: Callable ``key -> Path`` that maps a cache key to the
            entry directory path.
        do_put: Callable ``(key, raw) -> None`` that persists a successful
            fetch via cache:put. Raises on failure.
        batch_size: Issues per checkpoint. Validated > 0 by the caller.
        delay_ms: Per-issue inter-call delay. Validated >= 0 by the caller.
        state: Forwarded to ``scm:issue:list --state``.
        limit: Forwarded to ``scm:issue:list --limit``.
    """
    issues = scm_list_issues(repo, state=state, limit=limit)
    report = FetchAllReport()

    for i, issue in enumerate(issues):
        number = issue.get("number")
        if not isinstance(number, int) or number <= 0:
            report.failed += 1
            report.failures.append(
                {"key": f"{repo}/?", "reason": f"invalid 'number' field: {number!r}"}
            )
            continue

        key = f"{repo}/{number}"
        edir = entry_dir_for(key)
        if is_fresh(edir / "meta.json"):
            report.skipped += 1
            continue

        raw = _fetch_one_issue(repo, number, key, report, delay_ms)
        if raw is None:
            continue

        try:
            do_put(key, raw)
            report.succeeded += 1
        except Exception as exc:  # noqa: BLE001 -- caller's CacheError variants
            report.failed += 1
            report.failures.append({"key": key, "reason": str(exc)})

        # Per-issue delay; batch-size checkpoint adds an extra pause.
        _maybe_sleep(delay_ms)
        if (i + 1) % batch_size == 0:
            _maybe_sleep(delay_ms)

    return report


def _fetch_one_issue(
    repo: str,
    number: int,
    key: str,
    report: FetchAllReport,
    delay_ms: int,
) -> dict[str, Any] | None:
    """Wrap :func:`scm_view_issue` with 429 retry + post-success rate-limit detection.

    Returns the raw issue dict on success, or ``None`` after recording
    the failure on ``report``.
    """
    try:
        raw, stderr = scm_view_issue(repo, number)
    except CacheFetchError as exc:
        is_429, retry_after = detect_rate_limit(str(exc))
        if not is_429:
            report.failed += 1
            report.failures.append({"key": key, "reason": str(exc)})
            _maybe_sleep(delay_ms)
            return None
        sys.stderr.write(
            f"cache:fetch-all rate-limited on {key}; sleeping {retry_after}s "
            "before retry\n"
        )
        _sleep(retry_after)
        try:
            raw, stderr = scm_view_issue(repo, number)
        except CacheFetchError as exc2:
            report.failed += 1
            report.failures.append({"key": key, "reason": str(exc2)})
            _maybe_sleep(delay_ms)
            return None

    # 429 may also arrive on a 0-exit (gh sometimes prints the warning to
    # stderr while still producing a partial JSON body on stdout). Detect
    # post-success and back off before the next iteration.
    is_429, retry_after = detect_rate_limit(stderr)
    if is_429:
        sys.stderr.write(
            f"cache:fetch-all post-success rate-limit on {key}; sleeping "
            f"{retry_after}s before next call\n"
        )
        _sleep(retry_after)

    return raw


def _maybe_sleep(delay_ms: int) -> None:
    if delay_ms > 0:
        _sleep(delay_ms / 1000.0)
