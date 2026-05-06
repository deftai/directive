#!/usr/bin/env python3
r"""cache.py -- unified content cache for the deft framework (#883 Story 2).

Public surface (5 commands)
---------------------------

    python scripts/cache.py put         <source> <key> --raw-file PATH [--ttl-seconds N]
    python scripts/cache.py get         <source> <key> [--allow-stale | --no-stale]
    python scripts/cache.py invalidate  <source> <key> [--reason TEXT]
    python scripts/cache.py fetch-all   --source github-issue --repo OWNER/NAME [...]
    python scripts/cache.py prune       [--older-than-days 30] [--source ...] [--dry-run]

Storage layout
--------------

    .deft-cache/
      <source>/<key>/
        raw.json     -- original API response (always written)
        content.md   -- scanner-passed markdown (omitted on hard-fail)
        meta.json    -- per-entry metadata, validated against
                        vbrief/schemas/cache-meta.schema.json on read AND write
      quarantine-audit.jsonl
                     -- append-only audit log; one record per cache:put / cache:invalidate

For ``source=github-issue``, ``key`` is ``<owner>/<repo>/<N>`` and the
on-disk path is ``.deft-cache/github-issue/<owner>/<repo>/<N>/``.

Scanner integration
-------------------

Every :func:`cache_put` call runs :func:`cache_scanner.scan` BEFORE
writing ``content.md``:

- ``credentials`` -- severity hard-fail. ``content.md`` is NOT written;
  ``raw.json`` + ``meta.json`` ARE written (audit). Exit code is ``2``.
- ``injection-heading`` -- severity fence-and-pass. ``content.md`` is
  written with suspicious sections wrapped in ```quarantined`` fences.
- ``invisible-unicode`` -- severity strip-and-pass. ``content.md`` is
  written with the matched codepoints stripped.

A single append to ``quarantine-audit.jsonl`` happens for every
``cache_put`` call regardless of the scan outcome.

Rate limit + idempotency are owned by :mod:`_cache_fetch`; meta.json
schema validation is owned by :mod:`_cache_validate`. The split keeps
this module under the deft 1000-line MUST limit.
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
    run_fetch_all,
)
from _cache_validate import (  # noqa: E402
    CacheValidationError,
    validate_meta as _validate_meta_against_sources,
)
from cache_scanner import (  # noqa: E402
    SCANNER_VERSION,
    ScanResult,
    scan,
)

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
    "CacheError",
    "CacheNotFoundError",
    "CacheValidationError",
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_DELAY_MS",
    "DEFAULT_PRUNE_OLDER_THAN_DAYS",
    "FetchAllReport",
    "GetResult",
    "PutResult",
    "SCANNER_VERSION",
    "SOURCE_TTL_SECONDS",
    "audit_path",
    "cache_fetch_all",
    "cache_get",
    "cache_invalidate",
    "cache_prune",
    "cache_put",
    "entry_dir",
    "main",
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
DEFAULT_DELAY_MS: int = 500
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
) -> PutResult:
    """Write a cache entry. Always writes raw.json + meta.json; conditionally writes content.md."""
    _validate_key(source, key)
    fetched = fetched_at or _utc_now()
    ttl = ttl_seconds if ttl_seconds is not None else SOURCE_TTL_SECONDS[source]
    if not isinstance(ttl, int) or ttl < 0:
        raise CacheError(f"ttl_seconds must be a non-negative int (got {ttl!r})")
    expires = fetched + timedelta(seconds=ttl)

    edir = entry_dir(source, key, cache_root=cache_root)
    edir.mkdir(parents=True, exist_ok=True)

    raw_text = json.dumps(raw, indent=2, sort_keys=True, ensure_ascii=False)
    raw_path = edir / "raw.json"
    _atomic_write_text(raw_path, raw_text)
    raw_size = raw_path.stat().st_size

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
    cache_root: Path | None = None,
) -> FetchAllReport:
    """Populate the cache for every issue in ``repo``. See :mod:`_cache_fetch`."""
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
    )


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

    p_pr = sub.add_parser("prune", help="Drop entries older than the threshold.")
    p_pr.add_argument("--older-than-days", type=int, default=DEFAULT_PRUNE_OLDER_THAN_DAYS)
    p_pr.add_argument("--source", default=None, choices=list(ALLOWED_SOURCES))
    p_pr.add_argument("--dry-run", action="store_true")

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
    except (CacheError, CacheFetchError) as exc:
        # CacheFetchError is a sibling of CacheError (extends RuntimeError
        # directly to avoid a circular import in _cache_fetch). It surfaces
        # from the scm:issue:list enumeration phase before the per-issue
        # batch loop's try/except wraps anything; catching it here gives a
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


def _cmd_fetch_all(args: argparse.Namespace) -> int:
    report = cache_fetch_all(
        source=args.source,
        repo=args.repo,
        batch_size=args.batch_size,
        delay_ms=args.delay_ms,
        ttl_seconds=args.ttl_seconds,
        state=args.state,
        limit=args.limit,
    )
    sys.stdout.write(report.to_json() + "\n")
    return 0 if report.failed == 0 else 1


def _cmd_prune(args: argparse.Namespace) -> int:
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
