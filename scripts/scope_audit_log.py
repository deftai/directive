"""scope_audit_log.py -- append-only audit log for scope lifecycle decisions.

Public surface:
    append(entry: dict, *, log_path: Path | None = None) -> str
    read_all(*, log_path: Path | None = None) -> list[dict]
    find_by_path(vbrief_path: str, *, log_path: Path | None = None) -> list[dict]
    latest_for_path(vbrief_path: str, action: str | None = None,
                    *, log_path: Path | None = None) -> dict | None
    new_decision_id() -> str
    canonical_log_path(project_root: Path) -> Path

Storage:
    ``<project_root>/vbrief/.eval/scope-lifecycle.jsonl`` -- one JSON object
    per line, UTF-8. Parent directory is created on first append. The file is
    operator-private and is gitignored alongside ``candidates.jsonl`` /
    ``summary-history.jsonl`` (#1144). The ``vbrief/.eval/*.jsonl
    merge=union`` rule in ``.gitattributes`` covers single-operator rebases.

Concurrency:
    Mirrors ``candidates_log.py`` (#845 Story 2):

    - Cross-process safety: an advisory lock is held on a sidecar
      ``scope-lifecycle.jsonl.lock`` file via ``msvcrt.locking`` on Windows
      and ``fcntl.flock`` on POSIX while the writer appends a single line.
    - In-process thread safety: a module-level ``threading.Lock`` serialises
      appends from threads in the same Python process.

Entry shape (operator-facing -- separate from ``candidates.jsonl``, which is
the FROZEN triage schema):

    {
      "decision_id": "<uuid4>",
      "timestamp": "2026-05-17T21:05:00Z",
      "action": "demote",
      "vbrief_path": "vbrief/proposed/2026-05-17-1121-d1-scope-demote.vbrief.json",
      "from_status": "pending",
      "to_status": "proposed",
      "actor": "operator",
      "demote_meta": {
        "was_promoted": true,
        "original_promotion_decision_id": null,
        "days_in_pending": 12,
        "demote_reason": "operator-requested",
        "demoted_from": "pending"
      }
    }

The ``action`` vocabulary starts as ``{"demote"}``; future scope-lifecycle
audit emitters MAY widen it (e.g. ``"promote"``) so this writer keeps the
field free-form. ``demote_meta`` is the only action-specific block this
module recognises; readers MUST tolerate entries that lack it (forward-compat
for future actions).
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LOG = logging.getLogger(__name__)

_AUDIT_LOG_RELPATH = Path("vbrief") / ".eval" / "scope-lifecycle.jsonl"

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# Match candidates_log: UTC-only timestamps with literal Z suffix so a
# downstream lexicographic sort is chronologically correct.
_ISO8601_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"
)

_REQUIRED_FIELDS: tuple[str, ...] = (
    "decision_id",
    "timestamp",
    "action",
    "vbrief_path",
    "from_status",
    "to_status",
    "actor",
)
_DEMOTE_META_REQUIRED: tuple[str, ...] = (
    "was_promoted",
    "original_promotion_decision_id",
    "days_in_pending",
    "demote_reason",
    "demoted_from",
)

_thread_lock = threading.Lock()


class ScopeAuditLogError(ValueError):
    """Raised when an entry passed to :func:`append` fails validation."""


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def new_decision_id() -> str:
    """Return a fresh UUID4 string for use as ``decision_id``."""
    return str(uuid.uuid4())


def utc_now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string with literal Z."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_log_path(project_root: Path) -> Path:
    """Resolve the canonical audit log path under *project_root*."""
    return project_root / _AUDIT_LOG_RELPATH


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_entry(entry: Any) -> None:
    if not isinstance(entry, dict):
        raise ScopeAuditLogError(
            f"entry must be a dict, got {type(entry).__name__}"
        )

    missing = [f for f in _REQUIRED_FIELDS if f not in entry]
    if missing:
        raise ScopeAuditLogError(
            f"entry missing required field(s): {missing}"
        )

    decision_id = entry["decision_id"]
    if not isinstance(decision_id, str) or not _UUID_RE.match(decision_id):
        raise ScopeAuditLogError(
            f"decision_id must be a UUID string, got {decision_id!r}"
        )

    timestamp = entry["timestamp"]
    if not isinstance(timestamp, str) or not _ISO8601_RE.match(timestamp):
        raise ScopeAuditLogError(
            f"timestamp must be ISO-8601 UTC with Z suffix, got {timestamp!r}"
        )

    for field in ("action", "vbrief_path", "from_status", "to_status", "actor"):
        value = entry[field]
        if not isinstance(value, str) or not value:
            raise ScopeAuditLogError(
                f"{field} must be a non-empty string, got {value!r}"
            )

    # demote_meta is required only for action == "demote" (forward-compat
    # for future scope-lifecycle audit emitters).
    if entry["action"] == "demote":
        meta = entry.get("demote_meta")
        if not isinstance(meta, dict):
            raise ScopeAuditLogError(
                f"action='demote' requires a 'demote_meta' object, got {meta!r}"
            )
        _validate_demote_meta(meta)


def _validate_demote_meta(meta: dict) -> None:
    missing = [f for f in _DEMOTE_META_REQUIRED if f not in meta]
    if missing:
        raise ScopeAuditLogError(
            f"demote_meta missing required field(s): {missing}"
        )

    was_promoted = meta["was_promoted"]
    if not isinstance(was_promoted, bool):
        raise ScopeAuditLogError(
            f"demote_meta.was_promoted must be bool, got {was_promoted!r}"
        )

    opdid = meta["original_promotion_decision_id"]
    if opdid is not None and (
        not isinstance(opdid, str) or not _UUID_RE.match(opdid)
    ):
        raise ScopeAuditLogError(
            f"demote_meta.original_promotion_decision_id must be a UUID string"
            f" or null, got {opdid!r}"
        )

    days = meta["days_in_pending"]
    # bool is a subclass of int -- explicitly reject it.
    if (
        not isinstance(days, int)
        or isinstance(days, bool)
        or days < 0
    ):
        raise ScopeAuditLogError(
            f"demote_meta.days_in_pending must be a non-negative int, got {days!r}"
        )

    reason = meta["demote_reason"]
    if not isinstance(reason, str) or not reason:
        raise ScopeAuditLogError(
            f"demote_meta.demote_reason must be a non-empty string, got {reason!r}"
        )

    demoted_from = meta["demoted_from"]
    if not isinstance(demoted_from, str) or not demoted_from:
        raise ScopeAuditLogError(
            f"demote_meta.demoted_from must be a non-empty string, got {demoted_from!r}"
        )


# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------


@contextmanager
def _append_lock(log_path: Path) -> Iterator[None]:
    """Serialise appenders across threads AND processes.

    Mirrors ``candidates_log._append_lock``. Sidecar lock file keeps the
    advisory lock orthogonal to the data file so a torn lock-file write
    never corrupts the audit trail.
    """
    lock_path = log_path.parent / (log_path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with _thread_lock:
        try:
            with open(lock_path, "a+b") as fh:
                if not lock_path.stat().st_size:
                    fh.write(b"\0")
                    fh.flush()
                fh.seek(0)
                if sys.platform == "win32":
                    import msvcrt

                    acquired = False
                    deadline = time.monotonic() + 30.0
                    while True:
                        try:
                            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                            acquired = True
                            break
                        except OSError:
                            if time.monotonic() > deadline:
                                raise
                            time.sleep(0.02)
                    try:
                        yield
                    finally:
                        if acquired:
                            fh.seek(0)
                            with suppress(OSError):
                                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            # Remove the sidecar ``<log>.lock`` so a clean append never leaves
            # an untracked lock file behind (#1311 discipline). The handle is
            # closed by the `with open(...)` block above BEFORE this unlink
            # (Windows refuses to delete an open file); held under
            # ``_thread_lock`` so the unlink cannot race an in-process
            # re-acquire. Best-effort across processes.
            with suppress(OSError):
                lock_path.unlink()


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------


def append(entry: dict, *, log_path: Path | str | None = None) -> str:
    """Validate *entry* and atomically append it to the audit log.

    Args:
        entry: dict matching the schema documented in the module docstring.
        log_path: optional override of the log file path. Production callers
            MUST leave this as None and let the caller pass the canonical
            path resolved via :func:`canonical_log_path` (this signature
            keeps the test hook explicit).

    Returns:
        The ``decision_id`` from *entry*.
    """
    if log_path is None:
        raise ScopeAuditLogError(
            "append() requires log_path; pass canonical_log_path(project_root)"
        )
    _validate_entry(entry)
    log_file = Path(log_path)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    with _append_lock(log_file), open(
        log_file, "a", encoding="utf-8", newline=""
    ) as fh:
        fh.write(line + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return str(entry["decision_id"])


def read_all(*, log_path: Path | str | None = None) -> list[dict]:
    """Return every well-formed entry in insertion order. Tolerant of
    malformed lines (logs a warning, skips them).
    """
    if log_path is None:
        raise ScopeAuditLogError(
            "read_all() requires log_path; pass canonical_log_path(project_root)"
        )
    log_file = Path(log_path)
    if not log_file.exists():
        return []
    out: list[dict] = []
    with open(log_file, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                LOG.warning(
                    "scope-lifecycle.jsonl: skipping malformed line %d: %s",
                    lineno,
                    exc,
                )
                continue
            if not isinstance(obj, dict):
                LOG.warning(
                    "scope-lifecycle.jsonl: skipping non-object on line %d",
                    lineno,
                )
                continue
            out.append(obj)
    return out


def find_by_path(
    vbrief_path: str, *, log_path: Path | str | None = None
) -> list[dict]:
    """Return every entry matching ``vbrief_path`` (string equality).

    Path normalisation:
        Callers SHOULD pass the canonical form used at write time
        (forward-slash project-root-relative). This helper does NOT
        re-normalise -- byte-equal match is the contract.
    """
    return [
        e for e in read_all(log_path=log_path) if e.get("vbrief_path") == vbrief_path
    ]


def latest_for_path(
    vbrief_path: str,
    action: str | None = None,
    *,
    log_path: Path | str | None = None,
) -> dict | None:
    """Return the most recent entry for ``vbrief_path``, optionally filtered
    by ``action`` (e.g. ``"promote"`` to find the prior promotion).

    Sort key is the entry's ``timestamp``. ISO-8601 UTC strings sort
    lexicographically in chronological order.
    """
    rows = find_by_path(vbrief_path, log_path=log_path)
    if action is not None:
        rows = [r for r in rows if r.get("action") == action]
    if not rows:
        return None
    rows.sort(key=lambda r: r.get("timestamp", ""))
    return rows[-1]
