#!/usr/bin/env python3
"""_cache_refresh.py -- cache:refresh-closed reconciliation (#1476).

Split out of :mod:`cache` so the parent stays under the deft 1000-line
MUST limit (mirrors the existing ``_cache_fetch`` / ``_cache_quota`` /
``_cache_validate`` split).

Why this module exists
----------------------
The default ``cache:fetch-all`` enumeration is ``state=open``. Once an
upstream GitHub issue closes it drops out of that enumeration, so its
cached ``raw.json`` is never rewritten and keeps saying ``state=open``
for the full 7-day cache TTL. ``triage:queue`` then keeps ranking the
closed issue as actionable untriaged work -- the #1322 shape recorded
in #1476.

This module reconciles that gap. :func:`cache_refresh_closed`:

1. Scans on-disk cache entries whose ``raw.json`` says ``state=open``.
2. Enumerates the current open issue numbers (the authoritative set).
3. For each cached-open entry NOT in the open enumeration, fetches its
   live single-issue state and, when closed, rewrites the entry via
   ``cache.cache_put`` so the next queue walk excludes it.

The single-issue fetch + rewrite loop lives in
:func:`_cache_fetch.run_state_refresh`; the open enumeration in
:func:`_cache_fetch.list_open_issue_numbers`. This module owns the
on-disk scan and the ``cache_put`` binding.

Import-cycle note
-----------------
``cache`` imports ``cache_refresh_closed`` from here at module load, so
this module MUST NOT import ``cache`` at the top level. The single
``import cache`` lives inside :func:`cache_refresh_closed`, by which
time ``cache`` is fully initialised.
"""

from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when invoked via
# ``python scripts/cache.py`` from a Taskfile dispatch.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cache_fetch import (  # noqa: E402  -- intentional sys.path tweak
    StateRefreshReport,
    list_open_issue_numbers,
    run_state_refresh,
)

#: Default cache source. v1 ships ``github-issue`` only (mirrors
#: ``cache.ALLOWED_SOURCES``).
_DEFAULT_SOURCE = "github-issue"


def scan_cached_open_entries(
    repo: str,
    *,
    source: str,
    cache_root: Path,
) -> list[tuple[int, dict[str, Any]]]:
    """Return ``(number, raw)`` for on-disk cache entries that say ``state=open``.

    Walks ``<cache_root>/<source>/<owner>/<name>/<N>/raw.json`` and yields
    the parsed payloads whose normalised ``state`` is ``open`` -- the
    candidate set :func:`cache_refresh_closed` revisits against the live
    open enumeration. The lowercase compare mirrors the #1236 reader-side
    normalisation so a pre-#1239 cache carrying ``"state": "OPEN"`` is
    still considered.
    """
    if "/" not in repo:
        return []
    owner, name = repo.split("/", 1)
    base = cache_root / source / owner / name
    if not base.is_dir():
        return []
    out: list[tuple[int, dict[str, Any]]] = []
    for entry in sorted(base.iterdir()):
        if not entry.is_dir() or not entry.name.isdigit():
            continue
        raw_path = entry / "raw.json"
        if not raw_path.is_file():
            continue
        try:
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict):
            continue
        number = raw.get("number")
        if not isinstance(number, int):
            with contextlib.suppress(ValueError, TypeError):
                number = int(entry.name)
        if not isinstance(number, int):
            continue
        state_raw = raw.get("state") or "open"
        state = state_raw.lower() if isinstance(state_raw, str) else "open"
        if state != "open":
            continue
        out.append((int(number), raw))
    return out


def cache_refresh_closed(
    *,
    source: str,
    repo: str,
    ttl_seconds: int | None = None,
    delay_ms: int | None = None,
    limit: int = 1000,
    cache_root: Path | None = None,
) -> StateRefreshReport:
    """Rewrite cached-open entries that closed upstream to ``state=closed`` (#1476).

    See the module docstring for the three-step reconciliation. Returns a
    :class:`_cache_fetch.StateRefreshReport`. When no cached-open entries
    exist the open enumeration is skipped entirely (an empty report is
    returned without any network call).

    Raises:
        cache.CacheError: On an unsupported source, a malformed repo, or a
            negative ``delay_ms`` -- so CLI / Taskfile callers exit non-zero
            via the same error class as the rest of the cache surface.
    """
    # Deferred import breaks the cache <-> _cache_refresh cycle (see the
    # module docstring). ``cache`` is fully initialised by call time.
    import cache

    if source != _DEFAULT_SOURCE:
        raise cache.CacheError(
            f"cache:refresh-closed source={source!r} not supported in v1 "
            "(supports: github-issue only; other sources deferred to v2)"
        )
    if not cache._REPO_RE.match(repo):
        raise cache.CacheError(
            f"invalid --repo {repo!r}: expected 'owner/repo' "
            "(alphanumerics, '.', '_', '-' only)"
        )
    effective_delay = delay_ms if delay_ms is not None else cache.DEFAULT_DELAY_MS
    if effective_delay < 0:
        raise cache.CacheError(f"--delay-ms must be >= 0 (got {effective_delay!r})")

    root = cache_root if cache_root is not None else cache.DEFAULT_CACHE_ROOT
    cached_open = scan_cached_open_entries(repo, source=source, cache_root=Path(root))
    if not cached_open:
        return StateRefreshReport()
    open_numbers = list_open_issue_numbers(repo, state="open", limit=limit)

    def _do_put(key: str, raw: dict[str, Any]) -> None:
        cache.cache_put(source, key, raw, ttl_seconds=ttl_seconds, cache_root=cache_root)

    return run_state_refresh(
        repo=repo,
        open_numbers=open_numbers,
        cached_open=cached_open,
        do_put=_do_put,
        delay_ms=effective_delay,
    )
