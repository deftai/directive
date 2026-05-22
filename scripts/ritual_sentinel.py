"""ritual_sentinel.py -- session-start ritual sentinel + resume nudge (#1269).

Public surface
--------------

* :func:`read` -- read ``.deft/last-session.json`` from a project root and
  return a :class:`Sentinel` dataclass. Fails open: missing, corrupt,
  or schema-mismatched sentinels return ``None`` without raising. Caller
  treats ``None`` as "fresh session, no resume context".
* :func:`write` -- atomically write a sentinel snapshot at the end of the
  session-start ritual. Uses ``os.replace`` so a crashed writer never
  leaves a partial file on disk; the previous sentinel is preserved
  intact until the new one is fully durable.
* :func:`compute_resume_signal` -- evaluate gating predicates against a
  sentinel snapshot + current time and return the formatted resume-nudge
  line, OR ``None`` when the ritual MUST stay silent. The gating
  predicate is conjunctive: ALL of {sentinel parses, ``lastActiveVbrief``
  is still under ``vbrief/active/``, >= 2h since the recorded timestamp,
  ``lastActiveVbrief`` references a file that exists on disk} must hold.

Sentinel schema (v1)
--------------------

::

    {
      "schemaVersion": 1,
      "deftVersion": "0.32.1",
      "timestamp": "2026-05-22T16:48:35Z",
      "lastActiveVbrief": "vbrief/active/2026-05-13-foo.vbrief.json",
      "lastBranch": "feat/foo-bar"
    }

``deftVersion`` is recorded for forward compatibility with the deferred
``task whats-new --since=<version>`` digest verb (see #1269 non-goals);
the v1 emission logic does NOT consume it, so a sentinel that omits
``deftVersion`` still fires the resume nudge when the remaining gating
predicates hold.

Failure-mode discipline (fail-open, #1269 AC)
---------------------------------------------

* Missing sentinel file -> :func:`read` returns ``None``;
  :func:`compute_resume_signal` returns ``None``.
* Corrupt JSON (decode error) -> ``read`` returns ``None``.
* Schema version mismatch (``schemaVersion != 1``) -> ``read`` returns
  ``None``.
* Missing required fields (``timestamp`` / ``lastActiveVbrief`` /
  ``lastBranch``) -> ``read`` returns ``None``. ``deftVersion`` is
  optional.
* Unparseable timestamp -> ``read`` returns ``None``.
* ``lastActiveVbrief`` no longer under ``vbrief/active/`` (promoted to
  ``completed/`` or ``cancelled/``) -> :func:`compute_resume_signal`
  returns ``None`` even when the sentinel parses.
* ``lastActiveVbrief`` path missing on disk (branch-switched-away or
  filesystem-deleted) -> :func:`compute_resume_signal` returns ``None``.
* < 2h since recorded timestamp -> :func:`compute_resume_signal` returns
  ``None`` (avoid nagging on terminal-restart within an active session).

The module never raises out of :func:`read` or
:func:`compute_resume_signal`; the ritual continues silently in every
adverse case.

Refs #1269.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

LOG = logging.getLogger(__name__)

#: Schema version emitted by :func:`write` and required by :func:`read`.
SCHEMA_VERSION: int = 1

#: Filesystem-relative location of the per-clone sentinel. Never
#: committed -- ``.deft/`` is gitignored.
SENTINEL_RELPATH: tuple[str, str] = (".deft", "last-session.json")

#: Minimum time delta since the recorded ``timestamp`` before the resume
#: nudge fires. Guards against nagging on terminal-restart within an
#: active session. Matches the threshold documented in #1269 AC.
MIN_RESUME_AGE: timedelta = timedelta(hours=2)

#: Path prefix the recorded ``lastActiveVbrief`` MUST still live under
#: for the resume nudge to fire. Promotion to ``vbrief/completed/`` or
#: ``vbrief/cancelled/`` silences the nudge because the work is done.
ACTIVE_VBRIEF_PREFIX: str = "vbrief/active/"


@dataclass(frozen=True)
class Sentinel:
    """Parsed sentinel snapshot.

    Attributes:
        schema_version: Always ``1`` for v1; future writers may bump and
            the reader rejects unknown versions (fail-open -> ``None``).
        deft_version: Framework version captured at write time (e.g.
            ``"0.32.1"``). Optional -- the field is reserved for the
            deferred ``task whats-new`` digest verb and is not consumed
            by the v1 resume-nudge emission logic. Empty string when
            absent from the sentinel.
        timestamp: UTC instant the session-start ritual concluded.
            Carried as a :class:`datetime` (timezone-aware) so callers
            can compute the elapsed delta directly.
        last_active_vbrief: Relative path to the in-flight scope vBRIEF
            the operator was last working on, as recorded by the
            session-start ritual writer. POSIX-style separators.
        last_branch: Git branch the operator was on when the ritual ran.
    """

    schema_version: int
    deft_version: str
    timestamp: datetime
    last_active_vbrief: str
    last_branch: str


def _sentinel_path(project_root: Path) -> Path:
    return project_root.joinpath(*SENTINEL_RELPATH)


def _parse_timestamp(raw: object) -> datetime | None:
    """Parse an ISO-8601 timestamp string into a tz-aware datetime.

    Accepts both ``"...Z"`` (canonical writer output) and
    ``"...+00:00"`` (output of :meth:`datetime.isoformat`). Returns
    ``None`` on any parse failure so the caller can fail open.
    """
    if not isinstance(raw, str) or not raw:
        return None
    # Python <3.11 ``fromisoformat`` does not accept the trailing ``Z``;
    # 3.11+ does, but normalising avoids surprises if a future writer
    # emits a different shape.
    normalised = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalised)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # Treat naive timestamps as UTC (the writer always emits UTC);
        # be permissive on read to remain fail-open.
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def read(project_root: Path) -> Sentinel | None:
    """Read ``.deft/last-session.json`` from ``project_root``.

    Returns ``None`` on missing file, corrupt JSON, schema-version
    mismatch, missing required field, or unparseable timestamp. Never
    raises -- the ritual MUST continue silently on any adverse case.
    """
    sentinel_file = _sentinel_path(project_root)
    try:
        if not sentinel_file.is_file():
            return None
    except OSError as exc:
        # ``.deft/`` parent has restrictive permissions or is otherwise
        # unreadable -- fail open so the documented never-raise contract
        # holds even on a hostile filesystem.
        LOG.debug("ritual_sentinel.read: is_file failed at %s: %s", sentinel_file, exc)
        return None
    try:
        raw_text = sentinel_file.read_text(encoding="utf-8")
    except (OSError, ValueError) as exc:
        # ValueError (UnicodeDecodeError subclass) -- sentinel file
        # contains non-UTF-8 bytes or truncated multi-byte sequence.
        # OSError -- transient filesystem error. Fail open in both.
        LOG.debug("ritual_sentinel.read: read failed at %s: %s", sentinel_file, exc)
        return None
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        LOG.debug("ritual_sentinel.read: JSON decode failed: %s", exc)
        return None
    if not isinstance(payload, dict):
        return None
    schema_version = payload.get("schemaVersion")
    if schema_version != SCHEMA_VERSION:
        LOG.debug(
            "ritual_sentinel.read: schemaVersion mismatch (got %r, want %r)",
            schema_version,
            SCHEMA_VERSION,
        )
        return None
    timestamp = _parse_timestamp(payload.get("timestamp"))
    if timestamp is None:
        return None
    last_active_vbrief = payload.get("lastActiveVbrief")
    if not isinstance(last_active_vbrief, str) or not last_active_vbrief:
        return None
    last_branch = payload.get("lastBranch")
    if not isinstance(last_branch, str) or not last_branch:
        return None
    deft_version_raw = payload.get("deftVersion", "")
    deft_version = deft_version_raw if isinstance(deft_version_raw, str) else ""
    return Sentinel(
        schema_version=schema_version,
        deft_version=deft_version,
        timestamp=timestamp,
        last_active_vbrief=last_active_vbrief,
        last_branch=last_branch,
    )


def write(
    project_root: Path,
    *,
    deft_version: str,
    last_active_vbrief: str,
    last_branch: str,
    now: datetime | None = None,
) -> Path:
    """Atomically write the sentinel for ``project_root``.

    Returns the path written. The write is atomic: a temp file is
    created in the same directory and renamed via :func:`os.replace`,
    so a crashed writer never leaves a partial file -- callers see the
    previous sentinel (or no sentinel) until the rename completes.

    The recorded timestamp is always UTC with a trailing ``Z`` so the
    on-disk shape matches the issue body's example payload. ``now``
    defaults to ``datetime.now(timezone.utc)`` and is exposed for tests
    that want to pin a deterministic instant.
    """
    sentinel_file = _sentinel_path(project_root)
    sentinel_file.parent.mkdir(parents=True, exist_ok=True)
    instant = now if now is not None else datetime.now(UTC)
    instant = instant.replace(tzinfo=UTC) if instant.tzinfo is None else instant.astimezone(UTC)
    # Canonical writer output: trailing ``Z`` (matches the issue body's
    # example) instead of ``+00:00`` so the on-disk shape is stable
    # across Python versions / platforms.
    timestamp_iso = instant.strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "deftVersion": deft_version,
        "timestamp": timestamp_iso,
        "lastActiveVbrief": last_active_vbrief.replace("\\", "/"),
        "lastBranch": last_branch,
    }
    # ``delete=False`` so we can name the temp file and rename it; the
    # caller is responsible for cleanup if the rename never happens
    # (the ``except`` branch below removes the partial file).
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=".last-session.",
        suffix=".json.tmp",
        dir=str(sentinel_file.parent),
    )
    fdopen_succeeded = False
    try:
        fh = os.fdopen(tmp_fd, "w", encoding="utf-8", newline="\n")
        fdopen_succeeded = True
        try:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            # fsync is best-effort; some filesystems (notably tmpfs on
            # CI sandboxes) do not implement it. The atomic rename is
            # the load-bearing durability guarantee.
            with contextlib.suppress(OSError):
                os.fsync(fh.fileno())
        finally:
            fh.close()
        os.replace(tmp_name, sentinel_file)
    except Exception:
        # Roll back the partial temp file so it does not accumulate on
        # repeated failure paths. Best-effort -- if the unlink itself
        # fails we still want to surface the original exception. If
        # os.fdopen never ran, ownership of the raw fd never moved off
        # ``tmp_fd``, so we close it explicitly to avoid an fd leak.
        if not fdopen_succeeded:
            with contextlib.suppress(OSError):
                os.close(tmp_fd)
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise
    return sentinel_file


def compute_resume_signal(
    sentinel: Sentinel | None,
    now: datetime,
    project_root: Path,
) -> str | None:
    """Return the formatted resume-nudge line, or ``None`` when silent.

    Emits the nudge ONLY when ALL of these conditions hold:

    1. ``sentinel`` is not ``None`` (it parsed cleanly).
    2. ``sentinel.last_active_vbrief`` is still under ``vbrief/active/``
       (NOT promoted to ``completed/`` or ``cancelled/``).
    3. ``now - sentinel.timestamp >= MIN_RESUME_AGE`` (>= 2h since the
       last session ended; guards against nagging on terminal restart).
    4. The referenced ``lastActiveVbrief`` file exists under
       ``project_root`` (defensive against branch-switched-away or
       filesystem-deleted cases).

    The format string mirrors the issue body example::

        [deft] Last session: <path> (branch: <branch>), <Nh|Nm> ago.
        Resume? Run `task vbrief:show <path>`.

    For deltas >= 1h the elapsed time is rendered as ``<N>h``; for the
    (rare) edge case of a sentinel that exists but is just under the
    2h gate the function returns ``None`` rather than rendering a
    minute-only line -- the minutes spelling is reserved for future
    surfaces that may lower the gate.
    """
    if sentinel is None:
        return None
    last_active = sentinel.last_active_vbrief.replace("\\", "/")
    if not last_active.startswith(ACTIVE_VBRIEF_PREFIX):
        return None
    # Normalise ``now`` to UTC so the delta is comparable regardless of
    # whether the caller passed a local or UTC instant.
    now_utc = now.replace(tzinfo=UTC) if now.tzinfo is None else now.astimezone(UTC)
    elapsed = now_utc - sentinel.timestamp
    if elapsed < MIN_RESUME_AGE:
        return None
    vbrief_path = project_root / last_active
    try:
        exists_on_disk = vbrief_path.is_file()
    except OSError:
        # Permission denied or transient filesystem error -- fail open
        # so the never-raise contract holds even on a hostile mount.
        return None
    if not exists_on_disk:
        return None
    elapsed_label = _format_elapsed(elapsed)
    return (
        f"[deft] Last session: {last_active} (branch: {sentinel.last_branch}), "
        f"{elapsed_label} ago. Resume? Run `task vbrief:show {last_active}`."
    )


def _format_elapsed(delta: timedelta) -> str:
    """Render a positive :class:`timedelta` as ``<N>h`` or ``<N>m``.

    Hours win over minutes once the delta crosses one hour -- the
    resume nudge gate requires >= 2h so the minute spelling is only
    used by future surfaces that lower the threshold; today it is the
    safe fallback for sub-hour deltas should the caller invoke this
    helper directly.
    """
    total_seconds = int(delta.total_seconds())
    if total_seconds < 3600:
        minutes = max(total_seconds // 60, 1)
        return f"{minutes}m"
    hours = total_seconds // 3600
    return f"{hours}h"


__all__ = [
    "ACTIVE_VBRIEF_PREFIX",
    "MIN_RESUME_AGE",
    "SCHEMA_VERSION",
    "SENTINEL_RELPATH",
    "Sentinel",
    "compute_resume_signal",
    "read",
    "write",
]
