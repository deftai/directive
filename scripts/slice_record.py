"""slice_record.py -- writer + reader for ``vbrief/.eval/slices.jsonl`` (#1132 / D13 of #1119).

Slicing skills (``deft-directive-gh-slice``, ``deft-directive-gh-arch``,
the slice phase of ``deft-directive-refinement``) call
:func:`write_slice` at slice-completion to record a durable cohort entry
sibling to the gitignored ``vbrief/.eval/candidates.jsonl`` (#845 Story
2). Unlike ``candidates.jsonl`` (per-operator, gitignored)
``slices.jsonl`` is **tracked in git** (see ``vbrief/.eval/README.md``
tracking-policy table) because cohort records are team-shared: a fresh
contributor needs to see prior cohort outputs to detect orphans and
avoid re-slicing the same scope.

Public surface
--------------

* :func:`write_slice` -- atomic, idempotent append. Re-writes with the
  same ``slice_id`` are no-ops (retry-safe). Returns the persisted
  ``slice_id``.
* :func:`read_all` -- yield every well-formed record. Tolerant of
  malformed lines (logs a warning, skips them).
* :func:`find_by_slice_id` / :func:`find_by_umbrella` -- targeted reads.
* :func:`new_slice_id` -- mint a fresh UUID4 for a new cohort.

Concurrency
-----------

Mirrors :mod:`candidates_log` (#845 Story 2):

* Cross-process safety via a sidecar ``slices.jsonl.lock`` file held
  with ``msvcrt.locking`` on Windows / ``fcntl.flock`` on POSIX.
* In-process thread safety via a module-level ``threading.Lock``.

Validation
----------

Every dict passed to :func:`write_slice` is validated against the
constraints in ``vbrief/schemas/slices.schema.json``. The validator is
hand-rolled so this module has no third-party dependency footprint --
the schema file remains the canonical reference. Validation errors are
raised as :class:`SliceRecordError` BEFORE any bytes hit disk.

Tracking policy
---------------

``vbrief/.eval/slices.jsonl`` is **tracked** in git (see
``vbrief/.eval/README.md`` Tracking policy table for the full rationale
+ the ``merge=union`` rebase ergonomic in ``.gitattributes``).
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
from collections.abc import Iterable, Iterator
from contextlib import contextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LOG = logging.getLogger(__name__)

# Canonical default storage location resolved relative to the repo root
# (mirrors :mod:`candidates_log`).
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG_PATH = REPO_ROOT / "vbrief" / ".eval" / "slices.jsonl"
SCHEMA_PATH = REPO_ROOT / "vbrief" / "schemas" / "slices.schema.json"

# Frozen enum mirrored from slices.schema.json. Keep in lockstep with the
# schema file -- bumping the schema's enum requires a follow-up child
# (additive only per the schema's frozen-interface preamble).
_VALID_EXPECTED_CLOSE_SIGNALS: frozenset[str] = frozenset(
    {
        "all-children-merged",
        "wave-1-merged",
        "manual",
    }
)

_REQUIRED_FIELDS: tuple[str, ...] = (
    "slice_id",
    "umbrella",
    "umbrella_url",
    "sliced_at",
    "actor",
    "children",
    "expected_close_signal",
)
_OPTIONAL_FIELDS: tuple[str, ...] = ("notes",)
_ALLOWED_FIELDS: frozenset[str] = frozenset(_REQUIRED_FIELDS + _OPTIONAL_FIELDS)
_CHILD_REQUIRED_FIELDS: tuple[str, ...] = ("n", "url", "wave", "role")
_CHILD_ALLOWED_FIELDS: frozenset[str] = frozenset(_CHILD_REQUIRED_FIELDS)

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# UTC-only on purpose: ``slices.jsonl`` is read by D11's queue ranking +
# D13's stalled-cohort surface, both of which compare ``sliced_at`` to
# ``datetime.now(UTC)`` via simple ISO-8601 lexicographic / parsed-utc
# comparison. A non-UTC offset would silently invert the chronological
# order (same failure mode as Greptile #876 P1 on candidates_log).
_ISO8601_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")

_thread_lock = threading.Lock()


class SliceRecordError(ValueError):
    """Raised when a record passed to :func:`write_slice` fails validation."""


def _validate_child(child: Any, index: int) -> None:
    if not isinstance(child, dict):
        raise SliceRecordError(
            f"children[{index}] must be a dict, got {type(child).__name__}"
        )
    missing = [f for f in _CHILD_REQUIRED_FIELDS if f not in child]
    if missing:
        raise SliceRecordError(
            f"children[{index}] missing required field(s): {missing}"
        )
    extras = sorted(set(child.keys()) - _CHILD_ALLOWED_FIELDS)
    if extras:
        raise SliceRecordError(
            f"children[{index}] has unknown field(s): {extras}"
        )
    n = child["n"]
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        raise SliceRecordError(
            f"children[{index}].n must be a positive int, got {n!r}"
        )
    url = child["url"]
    if not isinstance(url, str) or not url:
        raise SliceRecordError(
            f"children[{index}].url must be a non-empty string, got {url!r}"
        )
    wave = child["wave"]
    if not isinstance(wave, int) or isinstance(wave, bool) or wave < 1:
        raise SliceRecordError(
            f"children[{index}].wave must be a positive int, got {wave!r}"
        )
    role = child["role"]
    if not isinstance(role, str) or not role:
        raise SliceRecordError(
            f"children[{index}].role must be a non-empty string, got {role!r}"
        )


def _validate_record(record: Any) -> None:
    """Hand-rolled mirror of ``vbrief/schemas/slices.schema.json``.

    Raises :class:`SliceRecordError` with a human-readable message on the
    first violation encountered. Order-of-checks matches the schema so
    the error message cites the most upstream violation.
    """
    if not isinstance(record, dict):
        raise SliceRecordError(
            f"record must be a dict, got {type(record).__name__}"
        )

    missing = [f for f in _REQUIRED_FIELDS if f not in record]
    if missing:
        raise SliceRecordError(
            f"record missing required field(s): {missing}"
        )

    extras = sorted(set(record.keys()) - _ALLOWED_FIELDS)
    if extras:
        raise SliceRecordError(f"record has unknown field(s): {extras}")

    slice_id = record["slice_id"]
    if not isinstance(slice_id, str) or not _UUID_RE.match(slice_id):
        raise SliceRecordError(
            f"slice_id must be a UUID string, got {slice_id!r}"
        )

    umbrella = record["umbrella"]
    if (
        not isinstance(umbrella, int)
        or isinstance(umbrella, bool)
        or umbrella < 1
    ):
        raise SliceRecordError(
            f"umbrella must be a positive int, got {umbrella!r}"
        )

    umbrella_url = record["umbrella_url"]
    if not isinstance(umbrella_url, str) or not umbrella_url:
        raise SliceRecordError(
            f"umbrella_url must be a non-empty string, got {umbrella_url!r}"
        )

    sliced_at = record["sliced_at"]
    if not isinstance(sliced_at, str) or not _ISO8601_RE.match(sliced_at):
        raise SliceRecordError(
            "sliced_at must be ISO-8601 UTC with Z suffix "
            f"(e.g. 2026-05-13T18:00:00Z), got {sliced_at!r}"
        )

    actor = record["actor"]
    if not isinstance(actor, str) or not actor:
        raise SliceRecordError(
            f"actor must be a non-empty string, got {actor!r}"
        )

    children = record["children"]
    if not isinstance(children, list) or not children:
        raise SliceRecordError(
            "children must be a non-empty list of child records"
        )
    for i, child in enumerate(children):
        _validate_child(child, i)

    expected = record["expected_close_signal"]
    if expected not in _VALID_EXPECTED_CLOSE_SIGNALS:
        raise SliceRecordError(
            f"expected_close_signal must be one of "
            f"{sorted(_VALID_EXPECTED_CLOSE_SIGNALS)}, got {expected!r}"
        )

    if "notes" in record and not isinstance(record["notes"], str):
        raise SliceRecordError(
            f"notes must be a string, got {type(record['notes']).__name__}"
        )


@contextmanager
def _append_lock(log_path: Path) -> Iterator[None]:
    """Serialise appenders across threads AND processes.

    Sibling implementation of :func:`candidates_log._append_lock` --
    sidecar ``<log>.lock`` byte-range exclusive lock.

    Also exported as :func:`append_lock` for callers (e.g.
    :mod:`slice_record_existing` per #1231) that need to wrap a
    read-decide-write critical section -- specifically the duplicate
    detection + :func:`write_slice_unlocked` pair -- under the SAME
    lock so concurrent invocations cannot both observe "no duplicate"
    before either appends. The lock is NOT reentrant (the underlying
    ``threading.Lock`` + ``msvcrt.locking`` / ``fcntl.flock`` would
    deadlock on re-entry); callers wrapping a critical section MUST
    use :func:`write_slice_unlocked` rather than :func:`write_slice`
    while holding the lock.
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


def _resolve_path(path: Path | str | None) -> Path:
    return Path(path) if path is not None else DEFAULT_LOG_PATH


def new_slice_id() -> str:
    """Return a fresh UUID4 string for use as a :attr:`slice_id`.

    Provided so callers (slicing skills + tests) do not have to pull in
    :mod:`uuid` directly and so a future swap to UUID7 (time-ordered) is
    a single-file change.
    """
    return str(uuid.uuid4())


def now_iso() -> str:
    """Return the current UTC time in canonical ISO-8601 form with ``Z`` suffix."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _existing_slice_ids(log_path: Path) -> set[str]:
    """Return slice_ids already persisted (used for retry-dedup).

    Tolerant of malformed lines -- mirrors :func:`read_all`'s warn-and-skip.
    """
    if not log_path.exists():
        return set()
    seen: set[str] = set()
    with open(log_path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                LOG.warning(
                    "slices.jsonl: skipping malformed JSON on line %d: %s",
                    lineno,
                    exc,
                )
                continue
            if isinstance(obj, dict):
                sid = obj.get("slice_id")
                if isinstance(sid, str):
                    seen.add(sid)
    return seen


def write_slice(
    umbrella: int,
    children: Iterable[dict[str, Any]],
    *,
    umbrella_url: str,
    actor: str,
    expected_close_signal: str = "all-children-merged",
    slice_id: str | None = None,
    sliced_at: str | None = None,
    notes: str | None = None,
    path: Path | str | None = None,
) -> str:
    """Validate and atomically append a cohort record to ``slices.jsonl``.

    Args:
        umbrella: Umbrella issue number.
        children: Iterable of child dicts. Each child must carry
            ``{n, url, wave, role}`` per ``vbrief/schemas/slices.schema.json``.
        umbrella_url: Full URL of the umbrella issue.
        actor: Slicing actor identity (e.g. ``"skill:gh-slice"``).
        expected_close_signal: One of ``all-children-merged`` (default),
            ``wave-1-merged``, ``manual``.
        slice_id: Optional explicit slice_id; minted if omitted. Pass an
            existing slice_id to make a retry idempotent.
        sliced_at: Optional ISO-8601 UTC timestamp; current time if omitted.
        notes: Optional free-form rationale.
        path: Optional log file path override (test hook).

    Returns:
        The persisted ``slice_id`` (the supplied one if provided,
        otherwise the newly-minted UUID). On idempotent no-op (the
        ``slice_id`` is already present in the log), the same id is
        returned without re-writing.

    Raises:
        SliceRecordError: if any field fails validation. No bytes are
            written to disk in this case.
    """
    resolved_id = slice_id or new_slice_id()
    record: dict[str, Any] = {
        "slice_id": resolved_id,
        "umbrella": umbrella,
        "umbrella_url": umbrella_url,
        "sliced_at": sliced_at or now_iso(),
        "actor": actor,
        "children": [dict(c) for c in children],
        "expected_close_signal": expected_close_signal,
    }
    if notes is not None:
        record["notes"] = notes

    log_path = _resolve_path(path)
    with _append_lock(log_path):
        return write_slice_unlocked(record=record, path=log_path)


def write_slice_unlocked(
    *,
    record: dict[str, Any],
    path: Path | str | None = None,
) -> str:
    """Validate + append ``record`` without acquiring the sidecar lock.

    Companion to :func:`write_slice` for callers that wrap their own
    read-decide-write critical section under :func:`append_lock`
    directly (see :mod:`slice_record_existing` per #1231 -- the
    duplicate-detection + append pair must run under one lock for
    atomic idempotency).

    Behaviour mirrors :func:`write_slice`:

    * Validates ``record`` against the schema; raises
      :class:`SliceRecordError` before any bytes hit disk.
    * Idempotent retry: if ``record['slice_id']`` is already present
      in the log, returns it without re-writing.
    * Otherwise appends one JSONL line, fsync'd.

    The caller is responsible for holding :func:`append_lock` for the
    same ``path``. Use :func:`write_slice` instead when you do NOT
    need to compose with another read under the same lock.
    """
    _validate_record(record)
    log_path = _resolve_path(path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_id = record["slice_id"]
    line = json.dumps(record, sort_keys=True, ensure_ascii=False)
    # Re-check under the lock so a concurrent appender that wrote the
    # same slice_id between the validation pass and the append cannot
    # produce a duplicate.
    existing = _existing_slice_ids(log_path)
    if resolved_id in existing:
        LOG.info(
            "slices.jsonl: slice_id %s already present; write_slice is a no-op",
            resolved_id,
        )
        return resolved_id
    with open(log_path, "a", encoding="utf-8", newline="") as fh:
        fh.write(line + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return resolved_id


def read_all(*, path: Path | str | None = None) -> list[dict[str, Any]]:
    """Return every well-formed slice record in insertion order.

    Args:
        path: Optional log path override (test hook).

    Returns:
        A list of dicts -- never None. An empty list is returned both
        when the file does not exist and when every line is malformed.
    """
    log_path = _resolve_path(path)
    if not log_path.exists():
        return []
    out: list[dict[str, Any]] = []
    with open(log_path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                LOG.warning(
                    "slices.jsonl: skipping malformed JSON on line %d: %s",
                    lineno,
                    exc,
                )
                continue
            if not isinstance(obj, dict):
                LOG.warning(
                    "slices.jsonl: skipping non-object entry on line %d (got %s)",
                    lineno,
                    type(obj).__name__,
                )
                continue
            out.append(obj)
    return out


def find_by_slice_id(
    slice_id: str, *, path: Path | str | None = None
) -> dict[str, Any] | None:
    """Return the slice record matching ``slice_id`` or ``None``."""
    for record in read_all(path=path):
        if record.get("slice_id") == slice_id:
            return record
    return None


def find_by_umbrella(
    umbrella: int, *, path: Path | str | None = None
) -> list[dict[str, Any]]:
    """Return every slice record for ``umbrella`` in insertion order."""
    return [r for r in read_all(path=path) if r.get("umbrella") == umbrella]


# Public alias for the sidecar-file lock. Callers that need to wrap a
# read-decide-write critical section (`slice_record_existing` per #1231)
# can import this directly without reaching for the private name; the
# underscore form is preserved for in-module readability.
append_lock = _append_lock


__all__ = [
    "DEFAULT_LOG_PATH",
    "SCHEMA_PATH",
    "SliceRecordError",
    "append_lock",
    "find_by_slice_id",
    "find_by_umbrella",
    "new_slice_id",
    "now_iso",
    "read_all",
    "write_slice",
    "write_slice_unlocked",
]
