"""Append-only audit log for triage decisions (#845 Story 2).

Public surface:
    append(entry: dict) -> str             # returns decision_id
    read_all(repo: str | None = None) -> list[dict]
    find_by_issue(issue_number: int, repo: str) -> list[dict]
    latest_decision(issue_number: int, repo: str) -> dict | None

Storage:
    vbrief/.eval/candidates.jsonl -- one JSON object per line, UTF-8.
    Parent directory is created on first append.

Concurrency:
    - Cross-process safety: an advisory lock is held on a sidecar
      ``candidates.jsonl.lock`` file via ``msvcrt.locking`` on Windows and
      ``fcntl.flock`` on POSIX while the writer appends a single line.
    - In-process thread safety: a module-level ``threading.Lock`` serialises
      appends from threads in the same Python process so the line-level
      atomicity holds even when the OS-level byte-range lock would otherwise
      be granted to multiple file descriptors held by the same process.

Validation:
    Every dict passed to :func:`append` is validated against the constraints
    in ``vbrief/schemas/candidates.schema.json`` (the FROZEN interface
    contract for downstream agents A3, A4, A6). The validator is hand-rolled
    so this module has no third-party dependency footprint -- the schema
    file remains the canonical reference.

Tolerance:
    :func:`read_all` tolerates malformed JSON lines: it logs a warning and
    skips them rather than raising. A partially-written tail from a crashed
    appender must not brick the audit trail for downstream readers.
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
from pathlib import Path
from typing import Any

LOG = logging.getLogger(__name__)

# Canonical default storage location, resolved relative to the repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG_PATH = REPO_ROOT / "vbrief" / ".eval" / "candidates.jsonl"
SCHEMA_PATH = REPO_ROOT / "vbrief" / "schemas" / "candidates.schema.json"

# Frozen vocabulary mirrored from candidates.schema.json. Keep in lockstep.
_VALID_DECISIONS: frozenset[str] = frozenset(
    {"accept", "reject", "defer", "needs-ac", "mark-duplicate", "reset"}
)
_REQUIRED_FIELDS: tuple[str, ...] = (
    "decision_id",
    "timestamp",
    "repo",
    "issue_number",
    "decision",
    "actor",
)
_OPTIONAL_FIELDS: tuple[str, ...] = ("reason", "linked_to", "prior_decision_id")
_ALLOWED_FIELDS: frozenset[str] = frozenset(_REQUIRED_FIELDS + _OPTIONAL_FIELDS)

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
# UTC-only on purpose: ``latest_decision`` sorts entries by lexicographic
# timestamp comparison, which is correct only when every timestamp uses the
# canonical ``Z`` (UTC) suffix. An offset like ``+05:30`` would represent the
# same instant as a Z-suffixed timestamp at a different wall-clock string and
# silently invert the chronological order (Greptile #876 P1).
_ISO8601_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"
)

_thread_lock = threading.Lock()


class CandidatesLogError(ValueError):
    """Raised when an entry passed to :func:`append` fails schema validation."""


def _validate_entry(entry: Any) -> None:
    """Hand-rolled mirror of ``vbrief/schemas/candidates.schema.json``.

    Raises :class:`CandidatesLogError` with a human-readable message on the
    first violation encountered. Order-of-checks matches the schema (required
    presence -> type -> pattern/enum -> conditional dependencies) so error
    messages cite the most upstream violation.
    """
    if not isinstance(entry, dict):
        raise CandidatesLogError(
            f"entry must be a dict, got {type(entry).__name__}"
        )

    missing = [f for f in _REQUIRED_FIELDS if f not in entry]
    if missing:
        raise CandidatesLogError(
            f"entry missing required field(s): {missing}"
        )

    extras = sorted(set(entry.keys()) - _ALLOWED_FIELDS)
    if extras:
        raise CandidatesLogError(f"entry has unknown field(s): {extras}")

    decision_id = entry["decision_id"]
    if not isinstance(decision_id, str) or not _UUID_RE.match(decision_id):
        raise CandidatesLogError(
            f"decision_id must be a UUID string, got {decision_id!r}"
        )

    timestamp = entry["timestamp"]
    if not isinstance(timestamp, str) or not _ISO8601_RE.match(timestamp):
        raise CandidatesLogError(
            f"timestamp must be ISO-8601 UTC with Z suffix "
            f"(e.g. 2026-05-03T16:32:54Z), got {timestamp!r}"
        )

    repo = entry["repo"]
    if not isinstance(repo, str) or not _REPO_RE.match(repo):
        raise CandidatesLogError(
            f"repo must match 'owner/name', got {repo!r}"
        )

    issue_number = entry["issue_number"]
    # bool is a subclass of int -- explicitly reject it.
    if (
        not isinstance(issue_number, int)
        or isinstance(issue_number, bool)
        or issue_number < 1
    ):
        raise CandidatesLogError(
            f"issue_number must be a positive int, got {issue_number!r}"
        )

    decision = entry["decision"]
    if decision not in _VALID_DECISIONS:
        raise CandidatesLogError(
            f"decision must be one of {sorted(_VALID_DECISIONS)}, "
            f"got {decision!r}"
        )

    actor = entry["actor"]
    if not isinstance(actor, str) or not actor:
        raise CandidatesLogError(
            f"actor must be a non-empty string, got {actor!r}"
        )

    if "reason" in entry and not isinstance(entry["reason"], str):
        raise CandidatesLogError(
            f"reason must be a string, got "
            f"{type(entry['reason']).__name__}"
        )

    # Conditional fields: linked_to is required for mark-duplicate and forbidden
    # otherwise; prior_decision_id is required for reset and forbidden otherwise.
    if decision == "mark-duplicate":
        if "linked_to" not in entry:
            raise CandidatesLogError(
                "decision 'mark-duplicate' requires 'linked_to'"
            )
        linked_to = entry["linked_to"]
        if (
            not isinstance(linked_to, int)
            or isinstance(linked_to, bool)
            or linked_to < 1
        ):
            raise CandidatesLogError(
                f"linked_to must be a positive int, got {linked_to!r}"
            )
    elif "linked_to" in entry:
        raise CandidatesLogError(
            "'linked_to' is only valid for decision='mark-duplicate'"
        )

    if decision == "reset":
        if "prior_decision_id" not in entry:
            raise CandidatesLogError(
                "decision 'reset' requires 'prior_decision_id'"
            )
        pid = entry["prior_decision_id"]
        if not isinstance(pid, str) or not _UUID_RE.match(pid):
            raise CandidatesLogError(
                f"prior_decision_id must be a UUID string, got {pid!r}"
            )
    elif "prior_decision_id" in entry:
        raise CandidatesLogError(
            "'prior_decision_id' is only valid for decision='reset'"
        )


@contextmanager
def _append_lock(log_path: Path) -> Iterator[None]:
    """Serialise appenders across threads AND processes.

    Acquires the module-level :data:`_thread_lock` first to serialise
    in-process callers, then opens a sidecar ``<log>.lock`` file and takes
    an exclusive byte-range lock via ``msvcrt`` (Windows) or ``fcntl``
    (POSIX). The sidecar pattern keeps the lock orthogonal to the data
    file so a torn lock-file write never affects the audit trail.
    """
    lock_path = log_path.parent / (log_path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # ``a+b`` opens for read+write+create without truncating -- needed because
    # msvcrt.locking requires the byte range to exist.
    with _thread_lock, open(lock_path, "a+b") as fh:
        if not lock_path.stat().st_size:
            fh.write(b"\0")
            fh.flush()
        fh.seek(0)
        if sys.platform == "win32":
            import msvcrt

            # Spin on LK_NBLCK -- the LK_LOCK retry loop is fixed at 10x
            # 1s and would block the test suite on bursty contention. The
            # acquire spin is INTENTIONALLY outside the post-acquire try/
            # finally so a deadline-driven raise does NOT trigger the
            # release path on a never-acquired lock; the explicit
            # ``acquired`` flag makes that invariant load-bearing for
            # future readers (Slizard #876 P2).
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
                    # Best-effort release: the lock may already be gone if
                    # the process is mid-shutdown; that is not an error.
                    with suppress(OSError):
                        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _resolve_path(path: Path | str | None) -> Path:
    return Path(path) if path is not None else DEFAULT_LOG_PATH


def append(entry: dict, *, path: Path | str | None = None) -> str:
    """Validate ``entry`` and atomically append it to the audit log.

    Args:
        entry: A dict matching ``vbrief/schemas/candidates.schema.json``.
            The caller is responsible for generating ``decision_id`` (a
            UUID4 string) and ``timestamp`` (ISO-8601 UTC). The module
            does not silently fill these in -- callers MUST be explicit so
            tests and replays are deterministic.
        path: Optional override of the log file path. Used by tests to
            redirect writes to a tmp directory; in production callers
            this MUST be left as None to hit the canonical location.

    Returns:
        The validated ``decision_id`` string from ``entry``.

    Raises:
        CandidatesLogError: if ``entry`` fails validation. No bytes are
            written to disk in this case.
    """
    _validate_entry(entry)
    log_path = _resolve_path(path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys for stable on-disk ordering; ensure_ascii=False preserves
    # non-ASCII actor/reason strings as UTF-8 rather than \uXXXX escapes.
    line = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    with _append_lock(log_path), open(
        log_path, "a", encoding="utf-8", newline=""
    ) as fh:
        fh.write(line + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return entry["decision_id"]


def read_all(
    repo: str | None = None, *, path: Path | str | None = None
) -> list[dict]:
    """Return every well-formed entry in chronological insertion order.

    Args:
        repo: Optional ``owner/name`` filter; entries with a different
            ``repo`` are excluded.
        path: Optional log path override (test hook).

    Returns:
        A list of dicts -- never None. An empty list is returned both when
        the file does not exist and when every line is malformed.
    """
    log_path = _resolve_path(path)
    if not log_path.exists():
        return []
    out: list[dict] = []
    with open(log_path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                LOG.warning(
                    "candidates.jsonl: skipping malformed JSON on line %d: %s",
                    lineno,
                    exc,
                )
                continue
            if not isinstance(obj, dict):
                LOG.warning(
                    "candidates.jsonl: skipping non-object entry on line %d "
                    "(got %s)",
                    lineno,
                    type(obj).__name__,
                )
                continue
            if repo is not None and obj.get("repo") != repo:
                continue
            out.append(obj)
    return out


def find_by_issue(
    issue_number: int,
    repo: str,
    *,
    path: Path | str | None = None,
) -> list[dict]:
    """Return every entry for ``(repo, issue_number)`` in insertion order."""
    return [
        e
        for e in read_all(repo=repo, path=path)
        if e.get("issue_number") == issue_number
    ]


def latest_decision(
    issue_number: int,
    repo: str,
    *,
    path: Path | str | None = None,
) -> dict | None:
    """Return the most recent decision for ``(repo, issue_number)``.

    Sort key is the entry's ``timestamp`` field. ISO-8601 strings sort
    lexicographically in chronological order so a string sort is correct
    for any compliant timestamp produced by :func:`append`.

    Returns:
        The latest dict, or None if no decisions exist for the issue.
    """
    rows = find_by_issue(issue_number, repo, path=path)
    if not rows:
        return None
    rows.sort(key=lambda r: r.get("timestamp", ""))
    return rows[-1]


def new_decision_id() -> str:
    """Helper: return a fresh UUID4 string for use as ``decision_id``.

    Provided so callers (Story 3 triage actions) do not have to pull in
    ``uuid`` directly and so a future swap to UUID7 (time-ordered) is a
    single-file change.
    """
    return str(uuid.uuid4())
