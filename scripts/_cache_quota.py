#!/usr/bin/env python3
"""_cache_quota.py -- size cap, entry cap, LRU eviction for the cache (#947).

Extracted from :mod:`cache` to keep the parent module under the deft
1000-line MUST limit (mirrors the existing ``_cache_fetch`` /
``_cache_validate`` split). The module owns:

- Cap resolution from env vars (``DEFT_CACHE_MAX_BYTES``,
  ``DEFT_CACHE_MAX_ENTRIES``) with sensible defaults baked in
  (100 MB / 10,000 entries; sized from the v0.26.0 smoke evidence
  documented in ``docs/smoke-2026-05-07-v0.26.0-rerun.md`` --
  320 entries = 3.03 MB, ~10 KB/entry average).
- Usage scanning across the cache root: enumerate every entry's
  ``meta.json``, sum ``size_bytes`` for the byte total, count entries,
  and read ``meta.json`` ``mtime`` for the LRU timestamp.
- LRU eviction: pick the oldest entry by ``(mtime, path)`` (path tie-break
  for filesystems with 1s mtime granularity), remove the directory,
  return the freed bytes + record so the caller can append a
  ``cache:evict`` audit row.
- :class:`CacheCapBreachedError`: raised when caps cannot be honored
  even after eviction (e.g. the new entry alone exceeds the byte cap,
  or every entry on disk is the just-written one). The cache CLI maps
  this to exit-code 3 so callers can distinguish "schema invalid"
  (exit 2) from "honoring the cap is impossible" (exit 3).

LRU signal: the ``meta.json`` mtime is touched (single ``os.utime``
syscall) on each ``cache:get`` hit. A v0.26.0 cache tree's existing
entries already have a valid mtime (the original write timestamp),
so this is backward-compatible without migration. The schema-bump
alternative (add a ``last_accessed_at`` field) was rejected because
it would (a) force a write-on-read of meta.json including schema
re-validation, (b) require coordinated edits to the FROZEN
``vbrief/schemas/cache-meta.schema.json`` plus the in-module
validator, and (c) impose a migration burden on pre-existing
cache trees. See the #947 vBRIEF ``DesignChoice`` narrative.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults + env-var contract
# ---------------------------------------------------------------------------

#: 100 MB. Defensible at the smoke-evidenced ~10 KB/entry average;
#: a 50,000-issue mono-repo would consume ~500 MB without a cap.
DEFAULT_MAX_BYTES: int = 100 * 1024 * 1024

#: 10,000 entries. Equivalent to the byte cap at the smoke-evidenced
#: per-entry average, so either threshold should trip first depending
#: on the actual mix of small vs large issues in the working set.
DEFAULT_MAX_ENTRIES: int = 10_000

#: A cap value of 0 (or a non-numeric env value) disables that cap.
ENV_MAX_BYTES: str = "DEFT_CACHE_MAX_BYTES"
ENV_MAX_ENTRIES: str = "DEFT_CACHE_MAX_ENTRIES"

#: Sentinel meaning "the cap is disabled" -- evictor never trips for it.
CAP_DISABLED: int = 0


class CacheCapBreachedError(RuntimeError):
    """Raised when the cache cap cannot be honored even after eviction.

    Attributes mirror the structured exit shape that callers (and the
    CLI exit-3 path) display so an operator can see *why* the put was
    refused and what they could free up to make room.
    """

    def __init__(
        self,
        *,
        reason: str,
        max_bytes: int,
        max_entries: int,
        current_bytes: int,
        current_entries: int,
        incoming_bytes: int,
    ) -> None:
        self.reason = reason
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.current_bytes = current_bytes
        self.current_entries = current_entries
        self.incoming_bytes = incoming_bytes
        super().__init__(
            f"cache cap breached ({reason}): "
            f"max_bytes={max_bytes} max_entries={max_entries} "
            f"current_bytes={current_bytes} current_entries={current_entries} "
            f"incoming_bytes={incoming_bytes}"
        )


# ---------------------------------------------------------------------------
# Cap resolution
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CacheCaps:
    """Resolved cap thresholds in effect for one operation.

    A value of :data:`CAP_DISABLED` (0) means the corresponding cap is
    not enforced. Negative env values are clamped to 0 (disabled) rather
    than raising -- the caps are an operator-friendly knob, not a
    strict-mode setting.
    """

    max_bytes: int
    max_entries: int

    @property
    def bytes_enforced(self) -> bool:
        return self.max_bytes > 0

    @property
    def entries_enforced(self) -> bool:
        return self.max_entries > 0

    @property
    def any_enforced(self) -> bool:
        return self.bytes_enforced or self.entries_enforced


def _parse_int_env(name: str, default: int) -> int:
    """Parse an int from ``os.environ[name]``, falling back to ``default``.

    Non-numeric or negative values resolve to ``CAP_DISABLED`` so a typo
    in the env var doesn't masquerade as an enforced cap. ``""`` (empty
    string) means "use the default" (consistent with how shell-set-but-
    -unset env vars usually behave).
    """
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return CAP_DISABLED
    return value if value >= 0 else CAP_DISABLED


def resolve_caps(
    *,
    max_bytes: int | None = None,
    max_entries: int | None = None,
) -> CacheCaps:
    """Resolve the active caps from explicit args, env vars, or defaults.

    Resolution order (highest precedence first):

    1. Explicit ``max_bytes`` / ``max_entries`` kwargs (used by tests
       that need deterministic caps regardless of process env).
    2. ``DEFT_CACHE_MAX_BYTES`` / ``DEFT_CACHE_MAX_ENTRIES`` env vars.
    3. Module defaults (:data:`DEFAULT_MAX_BYTES`,
       :data:`DEFAULT_MAX_ENTRIES`).
    """
    if max_bytes is None:
        max_bytes = _parse_int_env(ENV_MAX_BYTES, DEFAULT_MAX_BYTES)
    if max_entries is None:
        max_entries = _parse_int_env(ENV_MAX_ENTRIES, DEFAULT_MAX_ENTRIES)
    if max_bytes < 0:
        max_bytes = CAP_DISABLED
    if max_entries < 0:
        max_entries = CAP_DISABLED
    return CacheCaps(max_bytes=max_bytes, max_entries=max_entries)


# ---------------------------------------------------------------------------
# Usage scan
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EntryUsage:
    """One on-disk cache entry seen by the usage scan.

    ``size_bytes`` is read from the entry's ``meta.json`` (authoritative
    -- written at cache:put time and validated against the schema). If
    the meta.json is missing or unparseable the entry is still listed
    with ``size_bytes=0`` so eviction can drain corrupt entries first
    (they cannot be served by ``cache_get`` anyway).
    """

    entry_dir: Path
    source: str
    key: str
    size_bytes: int
    last_accessed: float
    meta_present: bool


@dataclass(frozen=True)
class UsageReport:
    """Aggregate usage at the time of the scan."""

    total_bytes: int
    total_entries: int
    entries: tuple[EntryUsage, ...]


def _read_meta_size(meta_path: Path) -> tuple[int, str, str, bool]:
    """Read ``size_bytes`` + (source, key) from a meta.json.

    Returns ``(size_bytes, source, key, meta_present)``. On parse
    failure, returns zeros so the corrupt entry sorts as evictable
    without polluting the byte total.
    """
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0, "", "", False
    if not isinstance(meta, dict):
        return 0, "", "", False
    size = meta.get("size_bytes")
    src = meta.get("source")
    key = meta.get("key")
    if not isinstance(size, int) or size < 0:
        size = 0
    if not isinstance(src, str):
        src = ""
    if not isinstance(key, str):
        key = ""
    return size, src, key, True


def scan_usage(
    cache_root: Path,
    *,
    sources: Iterable[str],
) -> UsageReport:
    """Walk the cache root, returning one :class:`EntryUsage` per entry.

    ``sources`` is the cache layer's ``ALLOWED_SOURCES`` tuple. The
    scan only descends into those subtrees so audit-log / scratch files
    at the cache root level don't pollute the count.
    """
    if not cache_root.exists():
        return UsageReport(total_bytes=0, total_entries=0, entries=())
    entries: list[EntryUsage] = []
    total_bytes = 0
    for src in sources:
        src_root = cache_root / src
        if not src_root.exists():
            continue
        # Snapshot before iteration: callers may evict mid-walk.
        for meta_path in list(src_root.rglob("meta.json")):
            size, meta_src, meta_key, present = _read_meta_size(meta_path)
            try:
                mtime = meta_path.stat().st_mtime
            except OSError:
                mtime = 0.0
            entries.append(
                EntryUsage(
                    entry_dir=meta_path.parent,
                    source=meta_src or src,
                    key=meta_key
                    or str(meta_path.parent.relative_to(src_root)).replace(
                        os.sep, "/"
                    ),
                    size_bytes=size,
                    last_accessed=mtime,
                    meta_present=present,
                )
            )
            total_bytes += size
    return UsageReport(
        total_bytes=total_bytes,
        total_entries=len(entries),
        entries=tuple(entries),
    )


# ---------------------------------------------------------------------------
# LRU eviction primitives
# ---------------------------------------------------------------------------


def lru_order(usage: UsageReport) -> tuple[EntryUsage, ...]:
    """Return entries oldest-first by (mtime, entry_dir-as-str).

    The path tie-break is what makes eviction deterministic across
    filesystems with 1s mtime granularity (most ext4 / NTFS configs).
    Tests can rely on a stable order even for entries written within
    the same second.
    """
    return tuple(sorted(usage.entries, key=lambda e: (e.last_accessed, str(e.entry_dir))))


def cap_breached(
    usage: UsageReport,
    caps: CacheCaps,
    *,
    incoming_bytes: int = 0,
    incoming_entries: int = 0,
) -> bool:
    """Return True iff ``usage`` plus a hypothetical add breaches caps.

    ``incoming_bytes`` is the net byte delta the caller plans to add
    (already accounting for any existing entry being replaced).
    ``incoming_entries`` is the entry-count delta (0 for a re-put of an
    existing key, 1 for a brand-new entry, 0 for prune-to-cap).
    """
    if caps.bytes_enforced and usage.total_bytes + incoming_bytes > caps.max_bytes:
        return True
    return bool(
        caps.entries_enforced
        and usage.total_entries + incoming_entries > caps.max_entries
    )


def evict_lru(
    cache_root: Path,
    *,
    sources: Iterable[str],
    caps: CacheCaps,
    incoming_bytes: int = 0,
    incoming_entries: int = 0,
    protect_keys: Iterable[tuple[str, str]] = (),
    on_evict: EvictCallback | None = None,
) -> list[EntryUsage]:
    """Evict LRU entries until the cap fits the incoming delta.

    Single-pass O(n log n): one ``scan_usage`` call up-front, then iterate
    the LRU-ordered candidate list maintaining running totals so each
    eviction does not re-scan the cache root (the previous O(n^2)
    re-scan pattern was a P2 finding from the iter-0 review).

    Returns the list of evicted :class:`EntryUsage` records, oldest
    first, in eviction order.

    Args:
        cache_root: Cache root path.
        sources: Cache layer's ALLOWED_SOURCES tuple.
        caps: Resolved cap thresholds.
        incoming_bytes: Bytes the caller plans to add post-eviction.
            May be negative for a shrinking re-put (caller subtracts
            the existing entry's size).
        incoming_entries: Entry-count delta (0 for re-put / prune-to-
            cap, 1 for a brand-new entry).
        protect_keys: Iterable of (source, key) pairs that MUST NOT be
            evicted (typically the entry currently being written, so a
            re-put cannot self-evict).
        on_evict: Optional callback invoked once per evicted entry
            BEFORE the directory is removed. Receives the victim, the
            already-narrowed reason string (``"size_cap"`` /
            ``"entry_cap"`` / ``"size_cap+entry_cap"``) reflecting which
            cap was actually exceeded at the moment of eviction, and
            the resolved caps for caller introspection.
    """
    if not caps.any_enforced:
        return []
    protect = {(s, k) for s, k in protect_keys}
    usage = scan_usage(cache_root, sources=sources)
    if not cap_breached(
        usage,
        caps,
        incoming_bytes=incoming_bytes,
        incoming_entries=incoming_entries,
    ):
        return []
    ordered = [e for e in lru_order(usage) if (e.source, e.key) not in protect]
    if not ordered:
        # Every entry is protected -- caller decides what to do.
        return []
    evicted: list[EntryUsage] = []
    running_bytes = usage.total_bytes
    running_entries = usage.total_entries
    for victim in ordered:
        bytes_breach = (
            caps.bytes_enforced
            and running_bytes + incoming_bytes > caps.max_bytes
        )
        entries_breach = (
            caps.entries_enforced
            and running_entries + incoming_entries > caps.max_entries
        )
        if not (bytes_breach or entries_breach):
            break
        reasons: list[str] = []
        if bytes_breach:
            reasons.append("size_cap")
        if entries_breach:
            reasons.append("entry_cap")
        reason = "+".join(reasons) or "unknown"
        if on_evict is not None:
            on_evict(victim, reason, caps)
        # Concurrent removal -- treat as a no-op.
        with contextlib.suppress(FileNotFoundError):
            shutil.rmtree(victim.entry_dir)
        evicted.append(victim)
        running_bytes -= victim.size_bytes
        running_entries -= 1
    return evicted


#: Type alias for the on_evict callback used by :func:`evict_lru` and
#: :func:`enforce_caps`. Invoked once per evicted entry BEFORE the
#: directory is removed. Signature is ``(victim, reason, caps)`` where
#: ``reason`` is the already-narrowed breach descriptor reflecting which
#: cap was actually exceeded at the moment of eviction (P1 fix from the
#: iter-1 review: the previous ``(victim, caps, incoming_bytes)`` shape
#: forced the audit callback to recompute reason without enough context
#: and ended up tagging every record ``size_cap+entry_cap`` under the
#: defaults).
EvictCallback = Callable[[EntryUsage, str, CacheCaps], None]


# ---------------------------------------------------------------------------
# High-level enforce_caps entry point
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EnforceResult:
    """Outcome of an enforce_caps() call.

    ``evicted`` is the list of entries removed during enforcement. Empty
    when the cache was already under cap or no caps were enforced.
    ``would_breach`` is True iff eviction could not free enough -- the
    caller (cache:put) raises :class:`CacheCapBreachedError` in that
    case; prune-to-cap surfaces a structured warning.
    """

    evicted: tuple[EntryUsage, ...]
    final_usage: UsageReport
    would_breach: bool


def predict_eviction_set(
    cache_root: Path,
    *,
    sources: Iterable[str],
    caps: CacheCaps,
) -> tuple[EntryUsage, ...]:
    """Compute the LRU eviction set without removing anything (dry-run).

    Walks entries in LRU order, accumulating evictions until the
    projected running totals fit under the caps. Used by
    ``cache:prune --to-cap --dry-run`` so operators can preview what
    would be evicted before committing.
    """
    if not caps.any_enforced:
        return ()
    usage = scan_usage(cache_root, sources=sources)
    if not cap_breached(usage, caps):
        return ()
    ordered = lru_order(usage)
    evicted: list[EntryUsage] = []
    running_bytes = usage.total_bytes
    running_entries = usage.total_entries
    for entry in ordered:
        if not (
            (caps.bytes_enforced and running_bytes > caps.max_bytes)
            or (caps.entries_enforced and running_entries > caps.max_entries)
        ):
            break
        evicted.append(entry)
        running_bytes -= entry.size_bytes
        running_entries -= 1
    return tuple(evicted)


def enforce_caps(
    cache_root: Path,
    *,
    sources: Iterable[str],
    caps: CacheCaps | None = None,
    incoming_bytes: int = 0,
    incoming_entries: int = 0,
    protect_keys: Iterable[tuple[str, str]] = (),
    on_evict: EvictCallback | None = None,
) -> EnforceResult:
    """Evict LRU entries until the cap fits the incoming delta.

    Wrap :func:`evict_lru` with a final cap-breach check so callers can
    differentiate "evicted cleanly" from "evicted but still breached".
    """
    resolved = caps if caps is not None else resolve_caps()
    evicted = evict_lru(
        cache_root,
        sources=sources,
        caps=resolved,
        incoming_bytes=incoming_bytes,
        incoming_entries=incoming_entries,
        protect_keys=protect_keys,
        on_evict=on_evict,
    )
    final_usage = scan_usage(cache_root, sources=sources)
    breached = cap_breached(
        final_usage,
        resolved,
        incoming_bytes=incoming_bytes,
        incoming_entries=incoming_entries,
    )
    return EnforceResult(
        evicted=tuple(evicted),
        final_usage=final_usage,
        would_breach=breached,
    )


__all__ = [
    "CAP_DISABLED",
    "CacheCapBreachedError",
    "CacheCaps",
    "DEFAULT_MAX_BYTES",
    "DEFAULT_MAX_ENTRIES",
    "ENV_MAX_BYTES",
    "ENV_MAX_ENTRIES",
    "EnforceResult",
    "EntryUsage",
    "EvictCallback",
    "UsageReport",
    "cap_breached",
    "enforce_caps",
    "evict_lru",
    "lru_order",
    "predict_eviction_set",
    "resolve_caps",
    "scan_usage",
]
