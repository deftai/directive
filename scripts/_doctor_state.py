"""scripts/_doctor_state.py -- doctor throttle state read/write (#1308).

Schema for ``vbrief/.eval/doctor-state.json``::

    {
      "last_run_at":        "2026-05-22T13:00:00Z",  # UTC ISO-8601, seconds
      "last_exit_code":     0,
      "last_finding_count": 0,
      "last_error_count":   0
    }

Count semantics (#1316): ``last_finding_count`` is the count of findings
that *mattered* -- it EXCLUDES ``severity == "skip"`` findings. A skip
(e.g. doctor's AGENTS.md-freshness check reporting "no managed-section
markers (likely maintainer repo)") carries neither error nor warning
weight, so it must not inflate the persisted tally. The caller
(``scripts/doctor.py::_persist_doctor_state``) is responsible for
filtering skips before calling :func:`write_state`. This keeps the
throttle-skip status line correct: ``_render_doctor_status_line``
derives the warning tally as ``last_finding_count - last_error_count``,
and a counted skip would over-report warnings by one on a dirty
throttle-skip.

Throttle rules:

* 24h after a clean previous run (``last_error_count == 0``).
* 4h after a dirty previous run (``last_error_count > 0``).
* Warnings alone count toward the 24h window so stable-warning installs
  (consumer without ``node`` who does not need it, etc.) are not
  perpetually re-probed.
* Corrupt state file (malformed JSON / missing keys / bad types) is
  treated as no-state -- the caller runs a full check.

The default state-file path is ``<project_root>/vbrief/.eval/doctor-state.json``.
Tests and other callers MAY set the ``DEFT_DOCTOR_STATE_PATH`` environment
variable to redirect the path -- this is the seam ``tests/cli/test_doctor_throttle.py``
uses to isolate per-test state without touching the live framework
checkout's state file.

Pure stdlib. Best-effort: read / write helpers NEVER raise; they
silently degrade to the no-state path so the doctor itself never breaks
because of a state-file bug.

Story: #1308 -- consolidated ``run doctor`` + ``task doctor`` throttle.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

STATE_FILENAME = "doctor-state.json"
STATE_PARENT = Path("vbrief") / ".eval"

CLEAN_WINDOW_HOURS = 24
DIRTY_WINDOW_HOURS = 4

_ENV_STATE_PATH = "DEFT_DOCTOR_STATE_PATH"


@dataclass(frozen=True)
class DoctorState:
    """Parsed doctor-state.json payload (UTC-aware)."""

    last_run_at: datetime
    last_exit_code: int
    last_finding_count: int
    last_error_count: int


@dataclass(frozen=True)
class ThrottleDecision:
    """Result of :func:`decide_throttle`.

    ``skip`` is True when the throttle window has not yet expired AND the
    caller has not bypassed the gate (``--full``). ``dirty`` distinguishes
    the clean (``last_error_count == 0``) and dirty (``last_error_count > 0``)
    branches so the CLI emits the right status line and exit code.

    When ``state`` is ``None`` (first run / corrupt state file), ``skip``
    is False and every numeric field is 0; ``last_run_at`` and
    ``next_eligible_at`` are ``None``.
    """

    skip: bool
    dirty: bool
    last_run_at: datetime | None
    last_exit_code: int
    last_finding_count: int
    last_error_count: int
    next_eligible_at: datetime | None
    age_hours: float


def state_path(project_root: Path) -> Path:
    """Return the doctor-state.json path for ``project_root``.

    Honors the ``DEFT_DOCTOR_STATE_PATH`` env override so callers (tests,
    cron jobs, multi-project setups) can redirect the state file without
    monkeypatching this module.
    """
    override = os.environ.get(_ENV_STATE_PATH, "").strip()
    if override:
        return Path(override).expanduser()
    return project_root / STATE_PARENT / STATE_FILENAME


def _parse_iso(ts: object) -> datetime | None:
    """Parse an ISO-8601 timestamp; return None on any malformed input.

    Mirrors ``run::_parse_iso_utc`` so the doctor's throttle parser stays
    in lockstep with the remote-probe throttle parser without importing
    ``run`` (which has heavy import-time side effects).
    """
    if not isinstance(ts, str) or not ts:
        return None
    candidate = ts.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def read_state(project_root: Path) -> DoctorState | None:
    """Best-effort read of doctor-state.json.

    Returns the parsed :class:`DoctorState` on a well-formed file, or
    ``None`` on any failure mode (missing file, malformed JSON, missing
    keys, bad value types). Per the #1308 contract, corrupt state is
    indistinguishable from no-state -- both routes converge on \"run the
    full check\".
    """
    path = state_path(project_root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    last_run_at = _parse_iso(data.get("last_run_at"))
    if last_run_at is None:
        return None
    try:
        last_exit_code = int(data.get("last_exit_code", 0))
        last_finding_count = int(data.get("last_finding_count", 0))
        last_error_count = int(data.get("last_error_count", 0))
    except (TypeError, ValueError):
        return None
    return DoctorState(
        last_run_at=last_run_at,
        last_exit_code=last_exit_code,
        last_finding_count=last_finding_count,
        last_error_count=last_error_count,
    )


def write_state(
    project_root: Path,
    *,
    exit_code: int,
    finding_count: int,
    error_count: int,
    now: datetime | None = None,
) -> Path | None:
    """Best-effort write of doctor-state.json.

    Returns the persisted path on success, ``None`` on any OSError
    (read-only filesystem, permission denied, missing parent dir we
    cannot create, ...). Never raises -- a state-file write failure
    MUST NOT break the doctor.

    ``now`` is exposed so tests can pin the timestamp without
    monkeypatching ``datetime.now``.
    """
    when = now if now is not None else _now_utc()
    payload = {
        "last_run_at": _format_utc_iso(when),
        "last_exit_code": int(exit_code),
        "last_finding_count": int(finding_count),
        "last_error_count": int(error_count),
    }
    path = state_path(project_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError:
        return None
    return path


def decide_throttle(
    state: DoctorState | None,
    *,
    now: datetime | None = None,
) -> ThrottleDecision:
    """Compute whether the doctor's full check should be skipped.

    Pure -- no I/O. The caller resolves the state via :func:`read_state`
    and feeds it in so tests can build synthetic states without
    touching the filesystem.

    Window rules (per the #1308 spec):

    * Clean previous (``last_error_count == 0``) -> 24h window.
    * Dirty previous (``last_error_count > 0``)  -> 4h window.

    ``now < state.last_run_at + window`` => skip. ``--full`` bypass is
    the caller's responsibility -- this helper makes the rule decision
    on the state alone so it stays deterministic and unit-testable.
    """
    when = now if now is not None else _now_utc()
    if state is None:
        return ThrottleDecision(
            skip=False,
            dirty=False,
            last_run_at=None,
            last_exit_code=0,
            last_finding_count=0,
            last_error_count=0,
            next_eligible_at=None,
            age_hours=0.0,
        )
    is_dirty = state.last_error_count > 0
    window_hours = DIRTY_WINDOW_HOURS if is_dirty else CLEAN_WINDOW_HOURS
    eligible_at = state.last_run_at + timedelta(hours=window_hours)
    age = when - state.last_run_at
    age_hours = age.total_seconds() / 3600.0
    skip = when < eligible_at
    return ThrottleDecision(
        skip=skip,
        dirty=is_dirty,
        last_run_at=state.last_run_at,
        last_exit_code=state.last_exit_code,
        last_finding_count=state.last_finding_count,
        last_error_count=state.last_error_count,
        next_eligible_at=eligible_at,
        age_hours=age_hours,
    )


def _now_utc() -> datetime:
    """UTC-aware ``datetime.now`` (split out so tests can monkeypatch)."""
    return datetime.now(UTC)


def _format_utc_iso(when: datetime) -> str:
    """Format a UTC datetime as ``YYYY-MM-DDTHH:MM:SSZ``."""
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


__all__ = [
    "CLEAN_WINDOW_HOURS",
    "DIRTY_WINDOW_HOURS",
    "DoctorState",
    "STATE_FILENAME",
    "STATE_PARENT",
    "ThrottleDecision",
    "decide_throttle",
    "read_state",
    "state_path",
    "write_state",
]
