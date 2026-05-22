"""Tests for scripts/ritual_sentinel.py (#1269).

Coverage:

* :func:`ritual_sentinel.read` -- fresh clone, corrupt JSON,
  schema-version mismatch, missing required fields, missing
  ``deftVersion`` (optional), unparseable timestamp.
* :func:`ritual_sentinel.write` -- timestamp UTC + ``Z`` suffix,
  atomic-write semantics (no partial file on failure path).
* :func:`ritual_sentinel.compute_resume_signal` -- fresh-clone
  silence, within-2h restart silence, >= 2h with active vBRIEF
  -> nudge string, vBRIEF promoted to ``completed/`` -> silence,
  ``lastActiveVbrief`` path missing on disk -> silence, missing
  ``deftVersion`` still emits the nudge.
* CLI :mod:`scripts._session_start_hook` -- happy-path write +
  precondition exit codes.

All scenarios trace back to the GitHub issue #1269 acceptance
criteria. The tests are pure-stdlib (no external network calls)
and operate against ``tmp_path`` sandboxes so they remain
parallel-safe under pytest-xdist.
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

ritual_sentinel = importlib.import_module("ritual_sentinel")
_session_start_hook = importlib.import_module("_session_start_hook")


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _make_active_vbrief(project_root: Path, name: str = "2026-05-13-foo.vbrief.json") -> str:
    """Create a minimal active vBRIEF file and return its POSIX relpath."""
    active_dir = project_root / "vbrief" / "active"
    active_dir.mkdir(parents=True, exist_ok=True)
    vbrief = active_dir / name
    vbrief.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"title": "test", "status": "running", "items": []},
            }
        ),
        encoding="utf-8",
    )
    return f"vbrief/active/{name}"


def _write_sentinel_payload(project_root: Path, payload: Any) -> Path:
    sentinel_dir = project_root / ".deft"
    sentinel_dir.mkdir(parents=True, exist_ok=True)
    target = sentinel_dir / "last-session.json"
    target.write_text(
        payload if isinstance(payload, str) else json.dumps(payload),
        encoding="utf-8",
    )
    return target


# ---------------------------------------------------------------------------
# read() -- failure-mode discipline
# ---------------------------------------------------------------------------


def test_read_missing_sentinel_returns_none(tmp_path: Path) -> None:
    # Fresh-clone scenario: no .deft/ directory at all.
    assert ritual_sentinel.read(tmp_path) is None


def test_read_empty_deft_dir_returns_none(tmp_path: Path) -> None:
    (tmp_path / ".deft").mkdir()
    assert ritual_sentinel.read(tmp_path) is None


def test_read_corrupt_json_returns_none(tmp_path: Path) -> None:
    _write_sentinel_payload(tmp_path, "{not json")
    assert ritual_sentinel.read(tmp_path) is None


def test_read_non_dict_payload_returns_none(tmp_path: Path) -> None:
    _write_sentinel_payload(tmp_path, [1, 2, 3])
    assert ritual_sentinel.read(tmp_path) is None


def test_read_schema_version_mismatch_returns_none(tmp_path: Path) -> None:
    _write_sentinel_payload(
        tmp_path,
        {
            "schemaVersion": 99,
            "deftVersion": "0.32.1",
            "timestamp": "2026-05-22T10:00:00Z",
            "lastActiveVbrief": "vbrief/active/foo.vbrief.json",
            "lastBranch": "feat/foo",
        },
    )
    assert ritual_sentinel.read(tmp_path) is None


def test_read_missing_required_field_returns_none(tmp_path: Path) -> None:
    _write_sentinel_payload(
        tmp_path,
        {
            "schemaVersion": 1,
            "deftVersion": "0.32.1",
            # missing timestamp
            "lastActiveVbrief": "vbrief/active/foo.vbrief.json",
            "lastBranch": "feat/foo",
        },
    )
    assert ritual_sentinel.read(tmp_path) is None


def test_read_unparseable_timestamp_returns_none(tmp_path: Path) -> None:
    _write_sentinel_payload(
        tmp_path,
        {
            "schemaVersion": 1,
            "deftVersion": "0.32.1",
            "timestamp": "not a real date",
            "lastActiveVbrief": "vbrief/active/foo.vbrief.json",
            "lastBranch": "feat/foo",
        },
    )
    assert ritual_sentinel.read(tmp_path) is None


def test_read_missing_deft_version_still_parses(tmp_path: Path) -> None:
    _write_sentinel_payload(
        tmp_path,
        {
            "schemaVersion": 1,
            # deftVersion intentionally omitted -- optional per #1269 AC
            "timestamp": "2026-05-22T10:00:00Z",
            "lastActiveVbrief": "vbrief/active/foo.vbrief.json",
            "lastBranch": "feat/foo",
        },
    )
    sentinel = ritual_sentinel.read(tmp_path)
    assert sentinel is not None
    assert sentinel.deft_version == ""
    assert sentinel.last_active_vbrief == "vbrief/active/foo.vbrief.json"


def test_read_round_trips_write(tmp_path: Path) -> None:
    now = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief="vbrief/active/foo.vbrief.json",
        last_branch="feat/foo",
        now=now,
    )
    sentinel = ritual_sentinel.read(tmp_path)
    assert sentinel is not None
    assert sentinel.schema_version == 1
    assert sentinel.deft_version == "0.32.1"
    assert sentinel.timestamp == now
    assert sentinel.last_active_vbrief == "vbrief/active/foo.vbrief.json"
    assert sentinel.last_branch == "feat/foo"


# ---------------------------------------------------------------------------
# write() -- on-disk shape + atomicity
# ---------------------------------------------------------------------------


def test_write_emits_utc_z_suffix(tmp_path: Path) -> None:
    now = datetime(2026, 5, 22, 16, 48, 35, tzinfo=UTC)
    sentinel_path = ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief="vbrief/active/foo.vbrief.json",
        last_branch="feat/foo",
        now=now,
    )
    payload = json.loads(sentinel_path.read_text(encoding="utf-8"))
    assert payload["timestamp"] == "2026-05-22T16:48:35Z"
    assert payload["schemaVersion"] == 1
    assert payload["lastActiveVbrief"] == "vbrief/active/foo.vbrief.json"


def test_write_normalises_naive_now_to_utc(tmp_path: Path) -> None:
    naive = datetime(2026, 5, 22, 16, 48, 35)
    sentinel_path = ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief="vbrief/active/foo.vbrief.json",
        last_branch="feat/foo",
        now=naive,
    )
    payload = json.loads(sentinel_path.read_text(encoding="utf-8"))
    assert payload["timestamp"].endswith("Z")


def test_write_replaces_existing_sentinel(tmp_path: Path) -> None:
    first = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.0",
        last_active_vbrief="vbrief/active/old.vbrief.json",
        last_branch="feat/old",
        now=first,
    )
    second = datetime(2026, 5, 22, 18, 30, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief="vbrief/active/new.vbrief.json",
        last_branch="feat/new",
        now=second,
    )
    sentinel = ritual_sentinel.read(tmp_path)
    assert sentinel is not None
    assert sentinel.deft_version == "0.32.1"
    assert sentinel.last_branch == "feat/new"
    assert sentinel.timestamp == second


def test_write_atomic_no_partial_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When os.replace raises, the temp file must be cleaned up.

    Verifies the documented atomicity guarantee: a crashed writer never
    leaves a ``.last-session.*.json.tmp`` partial file lingering in
    ``.deft/`` AND never replaces a previously-good sentinel with a
    half-written one.
    """
    # Seed a known-good prior sentinel so we can also verify it survives
    # the failed second write.
    prior_now = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.0",
        last_active_vbrief="vbrief/active/prior.vbrief.json",
        last_branch="feat/prior",
        now=prior_now,
    )
    prior_payload = json.loads(
        (tmp_path / ".deft" / "last-session.json").read_text(encoding="utf-8")
    )

    real_replace = ritual_sentinel.os.replace

    def boom(src: str, dst: str) -> None:
        del src, dst
        raise OSError("simulated replace failure")

    monkeypatch.setattr(ritual_sentinel.os, "replace", boom)
    with pytest.raises(OSError, match="simulated replace failure"):
        ritual_sentinel.write(
            tmp_path,
            deft_version="0.32.1",
            last_active_vbrief="vbrief/active/new.vbrief.json",
            last_branch="feat/new",
            now=datetime(2026, 5, 22, 18, 0, 0, tzinfo=UTC),
        )
    # Restore os.replace so subsequent reads work normally.
    monkeypatch.setattr(ritual_sentinel.os, "replace", real_replace)

    # The prior sentinel must still be the canonical content.
    actual = json.loads(
        (tmp_path / ".deft" / "last-session.json").read_text(encoding="utf-8")
    )
    assert actual == prior_payload

    # No leftover tmp files.
    leftovers = list((tmp_path / ".deft").glob(".last-session.*.json.tmp"))
    assert leftovers == [], f"unexpected partial files: {leftovers}"


# ---------------------------------------------------------------------------
# compute_resume_signal() -- gating predicates
# ---------------------------------------------------------------------------


def test_compute_resume_signal_fresh_clone_returns_none(tmp_path: Path) -> None:
    # No sentinel + no active vBRIEF.
    assert (
        ritual_sentinel.compute_resume_signal(
            None, datetime(2026, 5, 22, tzinfo=UTC), tmp_path
        )
        is None
    )


def test_compute_resume_signal_within_two_hours_silent(tmp_path: Path) -> None:
    vbrief_rel = _make_active_vbrief(tmp_path)
    last_session = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief=vbrief_rel,
        last_branch="feat/foo",
        now=last_session,
    )
    sentinel = ritual_sentinel.read(tmp_path)
    # 1h59m elapsed -- under the 2h gate, should stay silent.
    now = last_session + timedelta(hours=1, minutes=59)
    assert ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path) is None


def test_compute_resume_signal_active_brief_after_two_hours_fires(
    tmp_path: Path,
) -> None:
    vbrief_rel = _make_active_vbrief(tmp_path, name="2026-05-13-bar.vbrief.json")
    last_session = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief=vbrief_rel,
        last_branch="feat/bar",
        now=last_session,
    )
    sentinel = ritual_sentinel.read(tmp_path)
    now = last_session + timedelta(hours=8)
    signal = ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path)
    assert signal is not None
    assert "[deft] Last session:" in signal
    assert vbrief_rel in signal
    assert "(branch: feat/bar)" in signal
    assert "8h ago" in signal
    assert f"task vbrief:show {vbrief_rel}" in signal


def test_compute_resume_signal_promoted_to_completed_silent(tmp_path: Path) -> None:
    """vBRIEF moved out of active/ -> work is done -> silent."""
    # Sentinel still references the active path, but the file has been
    # promoted (renamed) to vbrief/completed/.
    completed_rel = "vbrief/completed/2026-05-13-foo.vbrief.json"
    completed_dir = tmp_path / "vbrief" / "completed"
    completed_dir.mkdir(parents=True, exist_ok=True)
    (completed_dir / "2026-05-13-foo.vbrief.json").write_text(
        "{}", encoding="utf-8"
    )
    last_session = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    # The sentinel itself records a "completed/" path which is no longer
    # under the active prefix -- the gating predicate must reject it.
    _write_sentinel_payload(
        tmp_path,
        {
            "schemaVersion": 1,
            "deftVersion": "0.32.1",
            "timestamp": "2026-05-22T10:00:00Z",
            "lastActiveVbrief": completed_rel,
            "lastBranch": "feat/foo",
        },
    )
    sentinel = ritual_sentinel.read(tmp_path)
    now = last_session + timedelta(hours=8)
    assert ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path) is None


def test_compute_resume_signal_path_missing_on_disk_silent(tmp_path: Path) -> None:
    # Sentinel claims an active vBRIEF that does not exist on disk.
    last_session = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief="vbrief/active/branch-switched-away.vbrief.json",
        last_branch="feat/ghost",
        now=last_session,
    )
    sentinel = ritual_sentinel.read(tmp_path)
    now = last_session + timedelta(hours=8)
    assert ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path) is None


def test_compute_resume_signal_missing_deft_version_still_fires(
    tmp_path: Path,
) -> None:
    """deftVersion is optional per #1269 AC."""
    vbrief_rel = _make_active_vbrief(tmp_path)
    _write_sentinel_payload(
        tmp_path,
        {
            "schemaVersion": 1,
            # deftVersion intentionally omitted
            "timestamp": "2026-05-22T10:00:00Z",
            "lastActiveVbrief": vbrief_rel,
            "lastBranch": "feat/foo",
        },
    )
    sentinel = ritual_sentinel.read(tmp_path)
    assert sentinel is not None
    now = datetime(2026, 5, 22, 18, 0, 0, tzinfo=UTC)
    signal = ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path)
    assert signal is not None
    assert vbrief_rel in signal


def test_compute_resume_signal_corrupt_sentinel_silent(tmp_path: Path) -> None:
    """Corrupt JSON path: read() returns None, compute returns None."""
    _make_active_vbrief(tmp_path)
    _write_sentinel_payload(tmp_path, "{this is not json")
    sentinel = ritual_sentinel.read(tmp_path)
    assert sentinel is None
    now = datetime(2026, 5, 22, 18, 0, 0, tzinfo=UTC)
    assert ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path) is None


def test_compute_resume_signal_naive_now_normalises_to_utc(tmp_path: Path) -> None:
    """Caller may pass a naive ``now``; the function MUST not raise."""
    vbrief_rel = _make_active_vbrief(tmp_path)
    last_session = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief=vbrief_rel,
        last_branch="feat/foo",
        now=last_session,
    )
    sentinel = ritual_sentinel.read(tmp_path)
    naive_now = datetime(2026, 5, 22, 18, 0, 0)
    signal = ritual_sentinel.compute_resume_signal(sentinel, naive_now, tmp_path)
    assert signal is not None
    assert "8h ago" in signal


# ---------------------------------------------------------------------------
# CLI -- _session_start_hook
# ---------------------------------------------------------------------------


def test_session_start_hook_no_write_flag_returns_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.chdir(tmp_path)
    rc = _session_start_hook.main([])
    assert rc == 0
    captured = capsys.readouterr()
    assert "pass --write" in captured.err


def test_session_start_hook_no_active_vbrief_returns_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Provide a fake branch detector so the precondition tested is the
    # missing-vBRIEF one (not branch detection).
    monkeypatch.setattr(
        _session_start_hook, "_detect_branch", lambda _root: "feat/foo"
    )
    rc = _session_start_hook.main(["--write", "--project-root", str(tmp_path)])
    assert rc == 2
    captured = capsys.readouterr()
    assert "no active vBRIEF" in captured.err


def test_session_start_hook_no_branch_returns_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # _detect_branch returns None on detached HEAD outside a git repo or
    # when git is missing; main() MUST return 2 with the canonical
    # diagnostic on stderr (parallel coverage to the missing-vBRIEF case).
    _make_active_vbrief(tmp_path)
    monkeypatch.setattr(_session_start_hook, "_detect_branch", lambda _root: None)
    rc = _session_start_hook.main(["--write", "--project-root", str(tmp_path)])
    assert rc == 2
    captured = capsys.readouterr()
    assert "could not determine current git branch" in captured.err


def test_detect_latest_active_vbrief_skips_unreadable_stat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # When ``stat()`` raises on one candidate (TOCTOU delete, permission
    # denied), the helper MUST skip it rather than crashing.
    good = _make_active_vbrief(tmp_path, name="2026-05-13-good.vbrief.json")
    # Create a second file that will trip stat() via the monkeypatched
    # method below.
    bad_path = tmp_path / "vbrief" / "active" / "2026-05-13-bad.vbrief.json"
    bad_path.write_text("{}", encoding="utf-8")
    real_stat = Path.stat

    def stat_with_selective_failure(self: Path, *args: Any, **kwargs: Any) -> Any:
        if self == bad_path:
            raise PermissionError("simulated stat failure")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat_with_selective_failure)
    result = _session_start_hook._detect_latest_active_vbrief(tmp_path)
    # The good file survives; the bad file is skipped silently.
    assert result == good


def test_read_unicode_decode_error_returns_none(tmp_path: Path) -> None:
    # Sentinel file contains non-UTF-8 bytes -- read() MUST fail open
    # rather than propagate the UnicodeDecodeError (ValueError subclass).
    sentinel_dir = tmp_path / ".deft"
    sentinel_dir.mkdir(parents=True, exist_ok=True)
    (sentinel_dir / "last-session.json").write_bytes(b"\xff\xfe\x00invalid utf-8")
    assert ritual_sentinel.read(tmp_path) is None


def test_read_is_file_raises_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # When sentinel_file.is_file() raises OSError, read() MUST fail open
    # (return None) rather than propagating the exception.
    sentinel_dir = tmp_path / ".deft"
    sentinel_dir.mkdir(parents=True, exist_ok=True)
    (sentinel_dir / "last-session.json").write_text("{}", encoding="utf-8")

    def boom(self: Path) -> bool:
        raise PermissionError("simulated is_file failure")

    monkeypatch.setattr(Path, "is_file", boom)
    assert ritual_sentinel.read(tmp_path) is None


def test_session_start_hook_resolve_version_failure_returns_two(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # When resolve_version.resolve_version() raises, main() MUST return 2
    # with the canonical diagnostic on stderr (parallel coverage to the
    # no-branch and no-active-vBRIEF precondition cases per Greptile).
    _make_active_vbrief(tmp_path)
    monkeypatch.setattr(
        _session_start_hook, "_detect_branch", lambda _root: "feat/foo"
    )

    def boom() -> str:
        raise RuntimeError("simulated resolve_version failure")

    monkeypatch.setattr(
        _session_start_hook.resolve_version, "resolve_version", boom
    )
    rc = _session_start_hook.main(["--write", "--project-root", str(tmp_path)])
    assert rc == 2
    captured = capsys.readouterr()
    assert "resolve_version failed" in captured.err


def test_compute_resume_signal_is_file_raises_returns_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # When ``vbrief_path.is_file()`` raises OSError, compute_resume_signal
    # MUST fail open (return None) rather than propagating the exception.
    vbrief_rel = _make_active_vbrief(tmp_path)
    last_session = datetime(2026, 5, 22, 10, 0, 0, tzinfo=UTC)
    ritual_sentinel.write(
        tmp_path,
        deft_version="0.32.1",
        last_active_vbrief=vbrief_rel,
        last_branch="feat/foo",
        now=last_session,
    )
    sentinel = ritual_sentinel.read(tmp_path)

    def boom(self: Path) -> bool:
        raise PermissionError("simulated is_file failure")

    monkeypatch.setattr(Path, "is_file", boom)
    now = last_session + timedelta(hours=8)
    assert ritual_sentinel.compute_resume_signal(sentinel, now, tmp_path) is None


def test_session_start_hook_writes_sentinel(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    vbrief_rel = _make_active_vbrief(tmp_path)
    monkeypatch.setattr(
        _session_start_hook, "_detect_branch", lambda _root: "feat/bar"
    )
    monkeypatch.setattr(
        _session_start_hook.resolve_version, "resolve_version", lambda: "0.32.1"
    )
    rc = _session_start_hook.main(["--write", "--project-root", str(tmp_path)])
    captured = capsys.readouterr()
    assert rc == 0, captured.err
    sentinel = ritual_sentinel.read(tmp_path)
    assert sentinel is not None
    assert sentinel.deft_version == "0.32.1"
    assert sentinel.last_branch == "feat/bar"
    assert sentinel.last_active_vbrief == vbrief_rel
