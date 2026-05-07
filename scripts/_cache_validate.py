#!/usr/bin/env python3
"""_cache_validate.py -- in-module mirror of cache-meta.schema.json (#883 Story 2).

Hand-rolled validator (no third-party ``jsonschema`` dependency) that pins
the same field set / types / enums declared in
``vbrief/schemas/cache-meta.schema.json``. Drift between the schema file
and this validator is caught by the
``tests/content/test_cache_schema_alignment.py`` regression suite.

Extracted from :mod:`cache` to keep the parent module under the 1000-line
MUST limit from deft/main.md (the cache module is a multi-command CLI plus
fetch orchestrator; the schema validator is a self-contained sub-surface).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any


class CacheValidationError(ValueError):
    """meta.json failed schema validation on read or write."""


# ---------------------------------------------------------------------------
# Regex + frozen-set surface
# ---------------------------------------------------------------------------

_VALID_DATETIME_RE: re.Pattern[str] = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)
_VALID_SEMVER_RE: re.Pattern[str] = re.compile(r"^\d+\.\d+\.\d+$")

_META_REQUIRED: tuple[str, ...] = (
    "source",
    "key",
    "fetched_at",
    "ttl_seconds",
    "expires_at",
    "scan_result",
    "size_bytes",
    "stale",
)
_META_ALLOWED: frozenset[str] = frozenset(_META_REQUIRED) | {"etag"}
_SCAN_RESULT_REQUIRED: tuple[str, ...] = (
    "passed",
    "scanned_at",
    "scanner_version",
    "flags",
)
_SCAN_RESULT_ALLOWED: frozenset[str] = frozenset(_SCAN_RESULT_REQUIRED)
_SCAN_FLAG_REQUIRED: tuple[str, ...] = ("category", "severity", "detail")
_SCAN_FLAG_ALLOWED: frozenset[str] = frozenset(_SCAN_FLAG_REQUIRED) | {"match_count"}
_SCAN_FLAG_CATEGORIES: frozenset[str] = frozenset(
    {"injection-heading", "credentials", "invisible-unicode"}
)
_SCAN_FLAG_SEVERITIES: frozenset[str] = frozenset(
    {"fence-and-pass", "hard-fail", "strip-and-pass"}
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_keys(obj: dict[str, Any], required: Iterable[str], path: str) -> None:
    missing = [k for k in required if k not in obj]
    if missing:
        raise CacheValidationError(
            f"meta.json validation failure at {path}: missing required keys {missing!r}"
        )


def _disallow_extras(obj: dict[str, Any], allowed: frozenset[str], path: str) -> None:
    extra = set(obj) - allowed
    if extra:
        raise CacheValidationError(
            f"meta.json validation failure at {path}: unknown keys {sorted(extra)!r}"
        )


def _is_non_negative_int(value: object) -> bool:
    """Reject bools (which are int subclass in Python) and negative ints."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate_datetime(value: object, path: str) -> None:
    if not isinstance(value, str) or not _VALID_DATETIME_RE.match(value):
        raise CacheValidationError(
            f"meta.json validation failure at {path}: not a UTC-suffixed "
            f"ISO-8601 timestamp ({value!r})"
        )


def _validate_meta_envelope(meta: dict[str, Any], allowed_sources: tuple[str, ...]) -> None:
    """Top-level (source/key/timestamps/ttl/size/stale) checks. Raises on failure."""
    if meta["source"] not in allowed_sources:
        raise CacheValidationError(
            f"meta.json validation failure at .source: {meta['source']!r} not in "
            f"{sorted(allowed_sources)!r}"
        )
    if not isinstance(meta["key"], str) or not meta["key"]:
        raise CacheValidationError(
            "meta.json validation failure at .key: expected non-empty string"
        )
    _validate_datetime(meta["fetched_at"], ".fetched_at")
    _validate_datetime(meta["expires_at"], ".expires_at")
    if not _is_non_negative_int(meta["ttl_seconds"]):
        raise CacheValidationError(
            f"meta.json validation failure at .ttl_seconds: expected non-negative int "
            f"(got {meta['ttl_seconds']!r})"
        )
    if not _is_non_negative_int(meta["size_bytes"]):
        raise CacheValidationError(
            f"meta.json validation failure at .size_bytes: expected non-negative int "
            f"(got {meta['size_bytes']!r})"
        )
    if not isinstance(meta["stale"], bool):
        raise CacheValidationError(
            f"meta.json validation failure at .stale: expected bool (got {meta['stale']!r})"
        )
    if "etag" in meta and not isinstance(meta["etag"], str):
        raise CacheValidationError(
            f"meta.json validation failure at .etag: expected string when present "
            f"(got {meta['etag']!r})"
        )


def _validate_scan_result(scan_result: object) -> None:
    if not isinstance(scan_result, dict):
        raise CacheValidationError(
            "meta.json validation failure at .scan_result: expected object"
        )
    _require_keys(scan_result, _SCAN_RESULT_REQUIRED, ".scan_result")
    _disallow_extras(scan_result, _SCAN_RESULT_ALLOWED, ".scan_result")
    if not isinstance(scan_result["passed"], bool):
        raise CacheValidationError(
            "meta.json validation failure at .scan_result.passed: expected bool"
        )
    _validate_datetime(scan_result["scanned_at"], ".scan_result.scanned_at")
    sv = scan_result["scanner_version"]
    if not isinstance(sv, str) or not _VALID_SEMVER_RE.match(sv):
        raise CacheValidationError(
            "meta.json validation failure at .scan_result.scanner_version: not a "
            f"SemVer string ({sv!r})"
        )
    flags = scan_result["flags"]
    if not isinstance(flags, list):
        raise CacheValidationError(
            "meta.json validation failure at .scan_result.flags: expected array"
        )
    for i, flag in enumerate(flags):
        _validate_scan_flag(flag, i)


def _validate_scan_flag(flag: object, index: int) -> None:
    path = f".scan_result.flags[{index}]"
    if not isinstance(flag, dict):
        raise CacheValidationError(
            f"meta.json validation failure at {path}: expected object"
        )
    _require_keys(flag, _SCAN_FLAG_REQUIRED, path)
    _disallow_extras(flag, _SCAN_FLAG_ALLOWED, path)
    if flag["category"] not in _SCAN_FLAG_CATEGORIES:
        raise CacheValidationError(
            f"meta.json validation failure at {path}.category: "
            f"{flag['category']!r} not in {sorted(_SCAN_FLAG_CATEGORIES)!r}"
        )
    if flag["severity"] not in _SCAN_FLAG_SEVERITIES:
        raise CacheValidationError(
            f"meta.json validation failure at {path}.severity: "
            f"{flag['severity']!r} not in {sorted(_SCAN_FLAG_SEVERITIES)!r}"
        )
    if not isinstance(flag["detail"], str):
        raise CacheValidationError(
            f"meta.json validation failure at {path}.detail: expected string"
        )
    if "match_count" in flag and not _is_non_negative_int(flag["match_count"]):
        raise CacheValidationError(
            f"meta.json validation failure at {path}.match_count: expected "
            f"non-negative int (got {flag['match_count']!r})"
        )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def validate_meta(meta: dict[str, Any], allowed_sources: tuple[str, ...]) -> None:
    """Validate ``meta`` against cache-meta.schema.json. Raises :class:`CacheValidationError`.

    Args:
        meta: The parsed meta.json object.
        allowed_sources: The cache layer's :data:`cache.ALLOWED_SOURCES` tuple. Threaded
            through as a parameter (rather than imported) so this module
            is independent of the parent cache module's import graph.
    """
    if not isinstance(meta, dict):
        raise CacheValidationError(
            f"meta.json validation failure at <root>: expected object, got "
            f"{type(meta).__name__}"
        )
    _require_keys(meta, _META_REQUIRED, "<root>")
    _disallow_extras(meta, _META_ALLOWED, "<root>")
    _validate_meta_envelope(meta, allowed_sources)
    _validate_scan_result(meta["scan_result"])
