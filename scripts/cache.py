#!/usr/bin/env python3
r"""cache.py -- unified content cache for the deft framework (#883 Story 2).

Public surface (5 commands)
---------------------------

    python scripts/cache.py put         <source> <key> --raw-file PATH [--ttl-seconds N]
    python scripts/cache.py get         <source> <key> [--allow-stale | --no-stale]
    python scripts/cache.py invalidate  <source> <key> [--reason TEXT]
    python scripts/cache.py fetch-all   --source github-issue --repo OWNER/NAME [...]
    python scripts/cache.py prune       [--older-than-days 30] [--source ...] [--dry-run]

Storage: ``.deft-cache/<source>/<key>/{raw.json, content.md, meta.json}``
plus a global ``quarantine-audit.jsonl`` audit log.

Scanner integration: every ``cache_put`` runs ``cache_scanner.scan``;
``credentials`` -> hard-fail (no content.md written, exit 2);
``injection-heading`` -> fence-and-pass; ``invisible-unicode`` -> strip-and-pass.
One audit record per put / invalidate / evict regardless of scan outcome.

Quota (#947): pre-write LRU eviction enforces ``DEFT_CACHE_MAX_BYTES`` /
``DEFT_CACHE_MAX_ENTRIES`` (defaults 100 MB / 10,000); breach -> exit 3.

Rate limit + idempotency owned by :mod:`_cache_fetch`; schema validation
by :mod:`_cache_validate`; quota by :mod:`_cache_quota`; the #1476
refresh-closed reconciliation by :mod:`_cache_refresh`. Each cache concern
lives in its own module per the deft file-size discipline.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Make ``scripts`` importable when this file is invoked via
# ``python scripts/cache.py`` from a Taskfile dispatch.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _cache_fetch import (  # noqa: E402  -- intentional sys.path tweak
    CacheFetchError,
    FetchAllReport,
    StateRefreshReport,
    run_fetch_all,
)
from _cache_quota import (  # noqa: E402
    CacheCapBreachedError,
    CacheCaps,
    EnforceResult,
    EntryUsage,
    enforce_caps as _enforce_caps,
    predict_eviction_set,
    resolve_caps,
    scan_usage,
)

# #1476 refresh-closed path; lazily imports ``cache`` at call time so this
# top-level import does not create a cycle.
from _cache_refresh import cache_refresh_closed  # noqa: E402
from _cache_validate import (  # noqa: E402
    CacheValidationError,
    validate_meta as _validate_meta_against_sources,
)
from cache_scanner import SCANNER_VERSION, ScanResult, scan  # noqa: E402

# Reconfigure stdout / stderr to UTF-8 so the cache layer's status lines
# render under Windows cp1252 default (#814).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(Exception):
            _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

# Re-export the scanner version so callers / tests can verify the cache
# module advertises the same SemVer the scanner module persists.
__all__ = [
    "ALLOWED_SOURCES",
    "CacheCapBreachedError",
    "CacheCaps",
    "CacheError",
    "CacheNotFoundError",
    "CacheValidationError",
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_DELAY_MS",
    "DEFAULT_PRUNE_OLDER_THAN_DAYS",
    "EnforceResult",
    "EntryUsage",
    "FetchAllReport",
    "GetResult",
    "PutResult",
    "SCANNER_VERSION",
    "SOURCE_TTL_SECONDS",
    "StateRefreshReport",
    "audit_path",
    "cache_fetch_all",
    "cache_get",
    "cache_invalidate",
    "cache_prune",
    "cache_prune_to_cap",
    "cache_put",
    "cache_refresh_closed",
    "entry_dir",
    "main",
    "resolve_caps",
    "scan_usage",
    "validate_meta",
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_CACHE_ROOT: Path = Path(".deft-cache")
AUDIT_LOG_NAME: str = "quarantine-audit.jsonl"

#: Hard-coded TTLs per source type (v1 ships github-issue only).
SOURCE_TTL_SECONDS: dict[str, int] = {"github-issue": 7 * 24 * 60 * 60}
ALLOWED_SOURCES: tuple[str, ...] = tuple(SOURCE_TTL_SECONDS.keys())

#: github-issue key shape: owner/repo/N (alphanumerics, '.', '_', '-' only).
_GH_KEY_RE: re.Pattern[str] = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)/(\d+)$"
)
_REPO_RE: re.Pattern[str] = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)$"
)

DEFAULT_BATCH_SIZE: int = 10
#: REST-paginated fetch-all (#1239) no longer shells out per issue; the
#: old 500 ms default burned minutes on hundred-issue cohorts (#1562).
#: Explicit ``--delay-ms`` still paces local writes when operators need it.
DEFAULT_DELAY_MS: int = 0
DEFAULT_PRUNE_OLDER_THAN_DAYS: int = 30


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class CacheError(RuntimeError):
    """Generic cache-layer failure (subprocess, parse, IO)."""


class CacheNotFoundError(KeyError):
    """Cache miss for the requested (source, key)."""


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or _utc_now()).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(stamp: str) -> datetime:
    text = stamp.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


# ---------------------------------------------------------------------------
# Schema validation (delegates to _cache_validate)
# ---------------------------------------------------------------------------


def validate_meta(meta: dict[str, Any]) -> None:
    """Validate ``meta`` against cache-meta.schema.json. Raises :class:`CacheValidationError`."""
    _validate_meta_against_sources(meta, ALLOWED_SOURCES)


# ---------------------------------------------------------------------------
# Path layout
# ---------------------------------------------------------------------------


def _validate_key(source: str, key: str) -> None:
    if source == "github-issue":
        if not _GH_KEY_RE.match(key):
            raise CacheError(
                f"invalid github-issue key {key!r}: expected '<owner>/<repo>/<N>' "
                "(alphanumerics, '.', '_', '-' only; N positive integer)"
            )
        return
    raise CacheError(f"unknown source {source!r}: v1 supports {sorted(ALLOWED_SOURCES)!r}")


def entry_dir(source: str, key: str, *, cache_root: Path | None = None) -> Path:
    """Return ``<cache_root>/<source>/<key>/``."""
    if source not in ALLOWED_SOURCES:
        raise CacheError(f"unknown source {source!r}: v1 supports {sorted(ALLOWED_SOURCES)!r}")
    _validate_key(source, key)
    root = cache_root if cache_root is not None else DEFAULT_CACHE_ROOT
    return Path(root) / source / Path(*key.split("/"))


def audit_path(*, cache_root: Path | None = None) -> Path:
    root = cache_root if cache_root is not None else DEFAULT_CACHE_ROOT
    return Path(root) / AUDIT_LOG_NAME


# ---------------------------------------------------------------------------
# Atomic write + audit append
# ---------------------------------------------------------------------------


def _atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` via tempfile + ``os.replace``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise


def _append_audit(record: dict[str, Any], *, cache_root: Path | None = None) -> None:
    """Append ``record`` as one JSON line to quarantine-audit.jsonl."""
    path = audit_path(cache_root=cache_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, sort_keys=True)
    with open(path, "a", encoding="utf-8", newline="") as fh:
        fh.write(line + "\n")


# ---------------------------------------------------------------------------
# Source-specific content rendering
# ---------------------------------------------------------------------------


def _render_content(source: str, raw: dict[str, Any]) -> str:
    """Render the source-specific markdown body that the scanner consumes.

    For ``github-issue``: ``# #<N>: <title>\\n\\n<body>``. The title line
    is included so a hostile title becomes a suspicious heading and is
    wrapped in quarantined fences by the scanner (mirrors the
    Greptile-fixed contract in scripts/triage_cache.py::_render_issue_md).
    """
    if source == "github-issue":
        number = raw.get("number")
        title = raw.get("title") or ""
        body = raw.get("body") or ""
        if not isinstance(number, int):
            raise CacheError(
                f"invalid github-issue raw payload: 'number' must be int "
                f"(got {type(number).__name__})"
            )
        return f"# #{number}: {title}\n\n{body}"
    raise CacheError(f"unknown source {source!r}: v1 supports {sorted(ALLOWED_SOURCES)!r}")


# ---------------------------------------------------------------------------
# Cache primitives
# ---------------------------------------------------------------------------


@dataclass
class PutResult:
    source: str
    key: str
    entry_dir: Path
    meta: dict[str, Any]
    scan_result: ScanResult
    content_written: bool


@dataclass
class GetResult:
    source: str
    key: str
    entry_dir: Path
    meta: dict[str, Any]
    content_path: Path | None
    stale: bool


def cache_put(
    source: str,
    key: str,
    raw: dict[str, Any],
    *,
    ttl_seconds: int | None = None,
    cache_root: Path | None = None,
    fetched_at: datetime | None = None,
    caps: CacheCaps | None = None,
) -> PutResult:
    """Write a cache entry. Always writes raw.json + meta.json; conditionally writes content.md.

    Pre-write quota enforcement (#947): projects the new total against
    the resolved caps, evicts LRU entries until the put fits, and raises
    :class:`CacheCapBreachedError` if eviction can't free enough (CLI exit-3).
    """
    _validate_key(source, key)
    fetched = fetched_at or _utc_now()
    ttl = ttl_seconds if ttl_seconds is not None else SOURCE_TTL_SECONDS[source]
    if not isinstance(ttl, int) or ttl < 0:
        raise CacheError(f"ttl_seconds must be a non-negative int (got {ttl!r})")
    expires = fetched + timedelta(seconds=ttl)

    edir = entry_dir(source, key, cache_root=cache_root)

    # Project raw.json size pre-write (UTF-8 JSON has no platform variance).
    raw_text = json.dumps(raw, indent=2, sort_keys=True, ensure_ascii=False)
    raw_size = len(raw_text.encode("utf-8"))

    # Re-put: charge delta only (may be negative when shrinking; cap_breached
    # handles the arithmetic correctly). Protect the existing entry from
    # self-eviction. Flooring to 0 here was a P1 finding -- a shrinking re-put
    # against a tight cap was being rejected as a cap-breach even though the
    # smaller payload would bring the cache *under* the cap.
    existing_size = _existing_entry_size(edir)
    is_new_entry = existing_size is None
    incoming_delta = raw_size if is_new_entry else raw_size - existing_size
    incoming_entries = 1 if is_new_entry else 0

    cache_root_path = cache_root if cache_root is not None else DEFAULT_CACHE_ROOT
    enforce_result = _enforce_caps(
        cache_root_path,
        sources=ALLOWED_SOURCES,
        caps=caps,
        incoming_bytes=incoming_delta,
        incoming_entries=incoming_entries,
        protect_keys=[(source, key)],
        on_evict=_make_evict_audit_callback(
            cache_root=cache_root, trigger="cache:put"
        ),
    )
    if enforce_result.would_breach:
        resolved = caps if caps is not None else resolve_caps()
        reason_parts: list[str] = []
        if (
            resolved.bytes_enforced
            and enforce_result.final_usage.total_bytes + incoming_delta > resolved.max_bytes
        ):
            reason_parts.append("size_cap")
        if (
            resolved.entries_enforced
            and enforce_result.final_usage.total_entries + incoming_entries
            > resolved.max_entries
        ):
            reason_parts.append("entry_cap")
        raise CacheCapBreachedError(
            reason="+".join(reason_parts) or "unknown",
            max_bytes=resolved.max_bytes,
            max_entries=resolved.max_entries,
            current_bytes=enforce_result.final_usage.total_bytes,
            current_entries=enforce_result.final_usage.total_entries,
            incoming_bytes=incoming_delta,
        )

    edir.mkdir(parents=True, exist_ok=True)
    raw_path = edir / "raw.json"
    _atomic_write_text(raw_path, raw_text)
    raw_size = raw_path.stat().st_size  # authoritative for meta.json::size_bytes

    rendered = _render_content(source, raw)
    scan_result = scan(rendered, scanned_at=_utc_iso(fetched))

    content_path = edir / "content.md"
    content_written = False
    if scan_result.passed:
        _atomic_write_text(content_path, scan_result.transformed_content)
        content_written = True
    else:
        # On hard-fail, remove any prior content.md so cache:get does not
        # return safe-but-stale content for an entry whose latest fetch
        # contained credentials.
        with contextlib.suppress(FileNotFoundError):
            content_path.unlink()

    meta = _build_meta(
        source=source,
        key=key,
        fetched_at=fetched,
        ttl_seconds=ttl,
        expires_at=expires,
        scan_result=scan_result,
        size_bytes=raw_size,
    )
    validate_meta(meta)
    _atomic_write_text(
        edir / "meta.json",
        json.dumps(meta, indent=2, sort_keys=True, ensure_ascii=False),
    )

    _append_audit(
        {
            "event": "cache:put",
            "source": source,
            "key": key,
            "timestamp": _utc_iso(),
            "scan_passed": scan_result.passed,
            "scanner_version": scan_result.scanner_version,
            "flags": [
                {
                    "category": f.category,
                    "severity": f.severity,
                    "detail": f.detail,
                    "match_count": f.match_count,
                }
                for f in scan_result.flags
            ],
            "content_written": content_written,
        },
        cache_root=cache_root,
    )

    return PutResult(
        source=source,
        key=key,
        entry_dir=edir,
        meta=meta,
        scan_result=scan_result,
        content_written=content_written,
    )


def _build_meta(
    *,
    source: str,
    key: str,
    fetched_at: datetime,
    ttl_seconds: int,
    expires_at: datetime,
    scan_result: ScanResult,
    size_bytes: int,
) -> dict[str, Any]:
    return {
        "source": source,
        "key": key,
        "fetched_at": _utc_iso(fetched_at),
        "ttl_seconds": ttl_seconds,
        "expires_at": _utc_iso(expires_at),
        "scan_result": {
            "passed": scan_result.passed,
            "scanned_at": scan_result.scanned_at,
            "scanner_version": scan_result.scanner_version,
            "flags": [
                {
                    "category": f.category,
                    "severity": f.severity,
                    "detail": f.detail,
                    "match_count": f.match_count,
                }
                for f in scan_result.flags
            ],
        },
        "size_bytes": size_bytes,
        "stale": False,
    }


def cache_get(
    source: str,
    key: str,
    *,
    cache_root: Path | None = None,
    allow_stale: bool = True,
) -> GetResult:
    """Read a cache entry. Raises :class:`CacheNotFoundError` on miss / stale-blocked."""
    edir = entry_dir(source, key, cache_root=cache_root)
    meta_path = edir / "meta.json"
    if not meta_path.exists():
        raise CacheNotFoundError(
            f"cache miss for source={source!r} key={key!r} "
            f"(expected meta.json at {meta_path})"
        )
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CacheValidationError(
            f"meta.json at {meta_path} is not valid JSON: {exc}"
        ) from exc
    validate_meta(meta)

    expires = _parse_iso(meta["expires_at"])
    is_stale = _utc_now() > expires
    if is_stale and not allow_stale:
        raise CacheNotFoundError(
            f"cache entry stale for source={source!r} key={key!r}; "
            f"expires_at={meta['expires_at']} (pass --allow-stale to override)"
        )

    # Mirror the computed staleness onto the in-memory meta dict so callers
    # that inspect GetResult.meta["stale"] see the runtime truth (the on-disk
    # meta.json is always written with stale=False because staleness is a
    # read-time concept; without this the field is misleading on cache hits
    # against TTL-expired entries). #883 Story 2 P2 cleanup.
    meta["stale"] = is_stale

    # LRU signal (#947): touch meta.json mtime so future eviction passes
    # see this entry as recently-accessed. Single os.utime syscall; no
    # rewrite, no schema validation, no extra disk I/O. Failures are
    # swallowed so a read-only cache tree still serves cache hits.
    _touch_mtime(meta_path)

    content_path = edir / "content.md"
    return GetResult(
        source=source,
        key=key,
        entry_dir=edir,
        meta=meta,
        content_path=content_path if content_path.exists() else None,
        stale=is_stale,
    )


def cache_invalidate(
    source: str,
    key: str,
    *,
    reason: str | None = None,
    cache_root: Path | None = None,
) -> bool:
    """Delete the entry directory and append an invalidate audit record. Idempotent."""
    _validate_key(source, key)
    edir = entry_dir(source, key, cache_root=cache_root)
    existed = edir.exists()
    if existed:
        shutil.rmtree(edir)
    _append_audit(
        {
            "event": "cache:invalidate",
            "source": source,
            "key": key,
            "timestamp": _utc_iso(),
            "reason": reason or "",
            "existed": existed,
        },
        cache_root=cache_root,
    )
    return existed


# ---------------------------------------------------------------------------
# Idempotency check (for fetch-all)
# ---------------------------------------------------------------------------


def _is_fresh(meta_path: Path) -> bool:
    """Return True iff meta_path exists, parses, and expires_at is in the future."""
    if not meta_path.exists():
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        validate_meta(meta)
    except (json.JSONDecodeError, CacheValidationError):
        return False
    try:
        expires = _parse_iso(meta["expires_at"])
    except (ValueError, KeyError):
        return False
    return _utc_now() <= expires


# ---------------------------------------------------------------------------
# fetch-all (delegates loop body to _cache_fetch.run_fetch_all)
# ---------------------------------------------------------------------------


def cache_fetch_all(
    *,
    source: str,
    repo: str,
    batch_size: int = DEFAULT_BATCH_SIZE,
    delay_ms: int = DEFAULT_DELAY_MS,
    ttl_seconds: int | None = None,
    state: str = "open",
    limit: int = 1000,
    labels: tuple[str, ...] = (),
    author: str | None = None,
    cache_root: Path | None = None,
) -> FetchAllReport:
    """Populate the cache for issues in ``repo``. See :mod:`_cache_fetch`.

    ``labels`` (#1033) and ``author`` (#1055) scope the REST issue
    enumeration so an operator can ingest a subset of the backlog rather
    than the whole open queue. Both default to the unfiltered case
    (empty labels / no author); when both are supplied they compose with
    AND semantics (label-matching issues created by the given login).
    """
    if source != "github-issue":
        raise CacheError(
            f"cache:fetch-all source={source!r} not supported in v1 "
            "(supports: github-issue only; other sources deferred to v2)"
        )
    if not _REPO_RE.match(repo):
        raise CacheError(
            f"invalid --repo {repo!r}: expected 'owner/repo' "
            "(alphanumerics, '.', '_', '-' only)"
        )
    if batch_size < 1:
        raise CacheError(f"--batch-size must be >= 1 (got {batch_size!r})")
    if delay_ms < 0:
        raise CacheError(f"--delay-ms must be >= 0 (got {delay_ms!r})")

    def _entry_dir_for(key: str) -> Path:
        return entry_dir(source, key, cache_root=cache_root)

    def _do_put(key: str, raw: dict[str, Any]) -> None:
        cache_put(source, key, raw, ttl_seconds=ttl_seconds, cache_root=cache_root)

    return run_fetch_all(
        repo=repo,
        is_fresh=_is_fresh,
        entry_dir_for=_entry_dir_for,
        do_put=_do_put,
        batch_size=batch_size,
        delay_ms=delay_ms,
        state=state,
        limit=limit,
        labels=labels,
        author=author,
    )


# refresh-closed (#1476): ``cache_refresh_closed`` is re-exported from
# :mod:`_cache_refresh` (imported above).


# ---------------------------------------------------------------------------
# prune
# ---------------------------------------------------------------------------


def cache_prune(
    *,
    older_than_days: int = DEFAULT_PRUNE_OLDER_THAN_DAYS,
    source: str | None = None,
    dry_run: bool = False,
    cache_root: Path | None = None,
) -> list[Path]:
    """Remove entries whose ``expires_at`` is older than ``older_than_days``."""
    if older_than_days < 0:
        raise CacheError(f"--older-than-days must be >= 0 (got {older_than_days!r})")
    root = cache_root if cache_root is not None else DEFAULT_CACHE_ROOT
    if not root.exists():
        return []

    cutoff = _utc_now() - timedelta(days=older_than_days)
    removed: list[Path] = []
    sources = [source] if source else list(ALLOWED_SOURCES)
    for src in sources:
        src_root = Path(root) / src
        if not src_root.exists():
            continue
        # Materialize the iterator before mutating the tree: shutil.rmtree()
        # below removes entry directories while rglob() lazily walks them on
        # POSIX, raising FileNotFoundError on the next scandir() (#883). Tests
        # passed on Windows due to a different walk order; CI on Linux caught
        # it. list(...) snapshots the matches up-front so deletions are safe.
        for meta_path in list(src_root.rglob("meta.json")):
            edir = meta_path.parent
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                expires = _parse_iso(meta["expires_at"])
            except (json.JSONDecodeError, KeyError, ValueError):
                # Corrupt entries are pruned -- they can't be served by
                # cache:get anyway, and leaving them masks the next
                # re-populate behind a stale meta.json shadow.
                expires = cutoff - timedelta(days=1)
                meta = {}
            if expires >= cutoff:
                continue
            if not dry_run:
                shutil.rmtree(edir)
                _append_audit(
                    {
                        "event": "cache:prune-entry",
                        "source": src,
                        "key": _meta_key_or_relpath(meta_path, src_root),
                        "timestamp": _utc_iso(),
                        "expires_at": (
                            meta.get("expires_at", "unknown")
                            if isinstance(meta, dict)
                            else "unknown"
                        ),
                    },
                    cache_root=cache_root,
                )
            removed.append(edir)
    return removed


def _meta_key_or_relpath(meta_path: Path, src_root: Path) -> str:
    try:
        return str(meta_path.parent.relative_to(src_root)).replace(os.sep, "/")
    except ValueError:
        return str(meta_path.parent)


# ---------------------------------------------------------------------------
# Quota helpers (#947) -- size cap, entry cap, LRU eviction integration
# ---------------------------------------------------------------------------


def _existing_entry_size(edir: Path) -> int | None:
    """Return ``meta.json::size_bytes`` for an existing entry, or ``None`` if absent.

    Used by :func:`cache_put` to compute the byte delta on a re-put so
    cap projection does not double-count the replaced entry. Corrupt /
    parse-failed meta.json returns 0 (treat re-put as adding full size).
    """
    meta_path = edir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    size = meta.get("size_bytes") if isinstance(meta, dict) else None
    if not isinstance(size, int) or size < 0:
        return 0
    return size


def _make_evict_audit_callback(
    *,
    cache_root: Path | None,
    trigger: str,
) -> Any:
    """Build the ``on_evict`` callback that appends ``cache:evict`` records.

    One audit record per eviction; operators can grep for the
    ``"event":"cache:evict"`` line to trace why an entry vanished. The
    ``reason`` field is the precomputed breach descriptor passed in by
    ``evict_lru`` -- it reflects the cap actually exceeded at the moment
    of *this* eviction (not just the configured caps), so an operator
    grepping ``"reason":"entry_cap"`` gets only the entry-cap-driven
    evictions even when both caps are configured. P1 fix from the iter-1
    review (the prior callback derived reason from caps alone, tagging
    every record ``size_cap+entry_cap`` under the defaults).
    """

    def _on_evict(victim: EntryUsage, reason: str, _caps: CacheCaps) -> None:
        last_accessed_iso = (
            datetime.fromtimestamp(victim.last_accessed, tz=UTC).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            if victim.last_accessed > 0
            else "unknown"
        )
        _append_audit(
            {
                "event": "cache:evict",
                "source": victim.source,
                "key": victim.key,
                "timestamp": _utc_iso(),
                "reason": reason,
                "trigger": trigger,
                "freed_bytes": victim.size_bytes,
                "last_accessed_at": last_accessed_iso,
            },
            cache_root=cache_root,
        )

    return _on_evict


def _touch_mtime(path: Path) -> None:
    """Update ``path``'s mtime to now (LRU signal). Single ``os.utime`` syscall.

    Failures are swallowed: a read-only meta.json on a locked-down filesystem
    still serves cache hits. Stale mtime degrades gracefully -- old mtime just
    makes the entry a stronger eviction candidate next round.
    """
    with contextlib.suppress(OSError):
        os.utime(path, None)


def cache_prune_to_cap(
    *,
    cache_root: Path | None = None,
    caps: CacheCaps | None = None,
    dry_run: bool = False,
) -> list[EntryUsage]:
    """Drain LRU entries until the cache is under the resolved caps.

    Idempotent: a second invocation against an already-under-cap tree
    returns ``[]``. ``dry_run=True`` evaluates the eviction set without
    removing anything (no audit records are written either).
    """
    root = cache_root if cache_root is not None else DEFAULT_CACHE_ROOT
    resolved = caps if caps is not None else resolve_caps()
    if not resolved.any_enforced:
        return []
    if dry_run:
        return list(
            predict_eviction_set(root, sources=ALLOWED_SOURCES, caps=resolved)
        )
    enforce_result = _enforce_caps(
        root,
        sources=ALLOWED_SOURCES,
        caps=resolved,
        on_evict=_make_evict_audit_callback(
            cache_root=cache_root, trigger="cache:prune-to-cap"
        ),
    )
    return list(enforce_result.evicted)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cache",
        description="Unified content cache + quarantine layer (#883 Story 2).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_put = sub.add_parser("put", help="Cache a (source, key) entry from a raw JSON file.")
    p_put.add_argument("source", choices=list(ALLOWED_SOURCES))
    p_put.add_argument("key")
    p_put.add_argument("--raw-file", required=True, help="Path to the upstream JSON payload.")
    p_put.add_argument("--ttl-seconds", type=int, default=None, help="Override the source TTL.")

    p_get = sub.add_parser("get", help="Print the cache entry's content.md path + meta.json.")
    p_get.add_argument("source", choices=list(ALLOWED_SOURCES))
    p_get.add_argument("key")
    grp = p_get.add_mutually_exclusive_group()
    grp.add_argument("--allow-stale", action="store_true", help="Default. Stale entries returned.")
    grp.add_argument("--no-stale", action="store_true", help="Stale entries treated as miss.")

    p_inv = sub.add_parser("invalidate", help="Delete an entry directory + append audit.")
    p_inv.add_argument("source", choices=list(ALLOWED_SOURCES))
    p_inv.add_argument("key")
    p_inv.add_argument("--reason", default=None, help="Audit-log reason text.")

    p_fa = sub.add_parser("fetch-all", help="Bulk-populate the cache for a repo.")
    p_fa.add_argument("--source", required=True, choices=["github-issue"])
    p_fa.add_argument("--repo", required=True, help="owner/repo slug.")
    p_fa.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    p_fa.add_argument("--delay-ms", type=int, default=DEFAULT_DELAY_MS)
    p_fa.add_argument("--ttl-seconds", type=int, default=None)
    p_fa.add_argument("--state", default="open")
    p_fa.add_argument("--limit", type=int, default=1000)
    p_fa.add_argument(
        "--label",
        action="append",
        default=None,
        dest="labels",
        metavar="NAME[,NAME...]",
        help=(
            "Scope ingestion to issues carrying the given label(s) (#1033). "
            "Repeatable and comma-separated (--label a,b --label c). "
            "Composes with --author via AND."
        ),
    )
    p_fa.add_argument(
        "--author",
        default=None,
        metavar="LOGIN",
        help=(
            "Scope ingestion to issues created by LOGIN (#1055). Maps to "
            "the REST 'creator' param. Composes with --label via AND."
        ),
    )
    p_fa.add_argument(
        "--refresh-closed",
        action="store_true",
        help=(
            "After populating, revisit cached-open entries that are no "
            "longer in the open enumeration and rewrite any that closed "
            "upstream to state=closed (#1476). Adds one single-issue REST "
            "read per closed-upstream candidate."
        ),
    )

    p_pr = sub.add_parser("prune", help="Drop entries older than the threshold.")
    p_pr.add_argument("--older-than-days", type=int, default=DEFAULT_PRUNE_OLDER_THAN_DAYS)
    p_pr.add_argument("--source", default=None, choices=list(ALLOWED_SOURCES))
    p_pr.add_argument("--dry-run", action="store_true")
    p_pr.add_argument(
        "--to-cap",
        action="store_true",
        help=(
            "LRU-evict entries until the cache is under the configured "
            "size + entry caps (DEFT_CACHE_MAX_BYTES, DEFT_CACHE_MAX_ENTRIES). "
            "Mutually exclusive with --older-than-days semantics; ignores "
            "the threshold and uses LRU recency instead."
        ),
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Per-command exit codes documented in the module docstring."""
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    try:
        return _DISPATCH[args.cmd](args)
    except CacheCapBreachedError as exc:
        # Cap breached even after eviction (#947). Distinct exit-3 so
        # operators / orchestrators can branch on "impossible to honor
        # the cap" vs the schema (exit 2) and generic (exit 1) failures.
        print(f"cache: cap breached: {exc}", file=sys.stderr)
        return 3
    except (CacheError, CacheFetchError) as exc:
        # CacheFetchError is a sibling of CacheError (extends RuntimeError
        # directly to avoid a circular import in _cache_fetch). It surfaces
        # from the REST list-enumeration phase before the local cache:put
        # loop's try/except wraps anything; catching it here gives a
        # clean ``cache: error: ...`` exit instead of a raw traceback.
        print(f"cache: error: {exc}", file=sys.stderr)
        return 1
    except CacheValidationError as exc:
        print(f"cache: schema error: {exc}", file=sys.stderr)
        return 2


def _cmd_put(args: argparse.Namespace) -> int:
    raw_path = Path(args.raw_file)
    if not raw_path.exists():
        raise CacheError(f"--raw-file not found: {raw_path}")
    try:
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CacheError(f"--raw-file is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise CacheError(f"--raw-file must be a JSON object (got {type(raw).__name__})")
    result = cache_put(args.source, args.key, raw, ttl_seconds=args.ttl_seconds)
    sys.stdout.write(
        f"cache:put source={result.source} key={result.key} "
        f"scan_passed={result.scan_result.passed} "
        f"flags={[f.category for f in result.scan_result.flags]} "
        f"content_written={result.content_written} dir={result.entry_dir}\n"
    )
    return 0 if result.scan_result.passed else 2


def _cmd_get(args: argparse.Namespace) -> int:
    allow_stale = not args.no_stale
    try:
        result = cache_get(args.source, args.key, allow_stale=allow_stale)
    except CacheNotFoundError as exc:
        print(f"cache:get miss: {exc}", file=sys.stderr)
        return 1
    payload = {
        "source": result.source,
        "key": result.key,
        "entry_dir": str(result.entry_dir),
        "content_path": str(result.content_path) if result.content_path else None,
        "stale": result.stale,
        "meta": result.meta,
    }
    sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    return 0


def _cmd_invalidate(args: argparse.Namespace) -> int:
    existed = cache_invalidate(args.source, args.key, reason=args.reason)
    sys.stdout.write(
        f"cache:invalidate source={args.source} key={args.key} existed={existed}\n"
    )
    return 0


def _normalise_label_filter(raw: list[str] | None) -> tuple[str, ...]:
    """Flatten repeated + comma-separated ``--label`` values into a tuple.

    ``argparse(action="append")`` yields a list with one entry per flag
    occurrence; each entry may itself be comma-separated. This mirrors
    the gh CLI multi-label convention and the scm.py ``--rest issue
    list`` label parsing so the two surfaces stay consistent (#1033).
    """
    if not raw:
        return ()
    return tuple(
        item.strip()
        for value in raw
        for item in value.split(",")
        if item.strip()
    )


def _cmd_fetch_all(args: argparse.Namespace) -> int:
    labels = _normalise_label_filter(getattr(args, "labels", None))
    report = cache_fetch_all(
        source=args.source,
        repo=args.repo,
        batch_size=args.batch_size,
        delay_ms=args.delay_ms,
        ttl_seconds=args.ttl_seconds,
        state=args.state,
        limit=args.limit,
        labels=labels,
        author=args.author,
    )
    sys.stdout.write(report.to_json() + "\n")
    rc = 0 if report.failed == 0 else 1
    # #1476: opt-in state reconciliation so a closed-upstream issue whose
    # cached entry is still TTL-fresh is rewritten to state=closed and
    # stops surfacing in triage:queue.
    if getattr(args, "refresh_closed", False):
        refresh = cache_refresh_closed(
            source=args.source,
            repo=args.repo,
            ttl_seconds=args.ttl_seconds,
            delay_ms=args.delay_ms,
            limit=args.limit,
        )
        sys.stdout.write(refresh.to_json() + "\n")
        if refresh.refresh_failed:
            rc = 1
    return rc


def _cmd_prune(args: argparse.Namespace) -> int:
    if args.to_cap:
        evicted = cache_prune_to_cap(dry_run=args.dry_run)
        caps = resolve_caps()
        payload = {
            "mode": "to-cap",
            "max_bytes": caps.max_bytes,
            "max_entries": caps.max_entries,
            "dry_run": args.dry_run,
            "evicted_count": len(evicted),
            "evicted_keys": [f"{e.source}/{e.key}" for e in evicted],
            "freed_bytes": sum(e.size_bytes for e in evicted),
        }
        sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        return 0
    removed = cache_prune(
        older_than_days=args.older_than_days,
        source=args.source,
        dry_run=args.dry_run,
    )
    payload = {
        "older_than_days": args.older_than_days,
        "source": args.source or "all",
        "dry_run": args.dry_run,
        "removed_count": len(removed),
        "removed_paths": [str(p) for p in removed],
    }
    sys.stdout.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    return 0


_DISPATCH = {
    "put": _cmd_put,
    "get": _cmd_get,
    "invalidate": _cmd_invalidate,
    "fetch-all": _cmd_fetch_all,
    "prune": _cmd_prune,
}


if __name__ == "__main__":
    raise SystemExit(main())
