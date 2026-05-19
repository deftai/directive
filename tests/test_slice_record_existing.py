"""Tests for scripts/slice_record_existing.py (#1147 / N7 of #1119).

Covers the acceptance criteria from issue #1147:

* happy path -- writes a well-formed entry with default actor
  ``manual:operator`` and default wave 1
* ``--dry-run`` -- prints proposed entry to stdout, no write
* idempotency -- same umbrella + child set is a no-op (informational stderr)
* ``--force`` -- writes a second record even when one exists
* missing umbrella -- non-zero exit, no write
* missing child -- non-zero exit, no write
* ``--wave-N`` assignment -- single wave and multi-wave shapes
* ``slice:list`` -- enumerates recorded slices with actor distinction

The N5 ``scm.call`` shim is monkey-patched to a deterministic stub so
the tests do not depend on a live GitHub remote or the host's ``gh``
authentication.
"""

from __future__ import annotations

import importlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

slice_record_existing = importlib.import_module("slice_record_existing")
slice_record = importlib.import_module("slice_record")
scm = importlib.import_module("scm")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_consumer_root(tmp_path: Path) -> Path:
    """Create a minimal consumer-project layout (vbrief/ + .git/)."""
    (tmp_path / "vbrief").mkdir()
    (tmp_path / "vbrief" / ".eval").mkdir()
    (tmp_path / ".git").mkdir()  # _project_context sentinel
    return tmp_path


def _slices_path(root: Path) -> Path:
    return root / "vbrief" / ".eval" / "slices.jsonl"


def _fake_call_factory(*, existing: set[int]):
    """Return a stand-in for ``scm.call`` that pretends only ``existing`` issues exist."""

    def _fake_call(source: str, verb: str, args, **kwargs):  # noqa: ANN001
        assert source == "github-issue"
        assert verb == "issue"
        # args[0] is the gh sub-verb ("view"); args[1] is the issue number.
        assert args[0] == "view"
        try:
            n = int(args[1])
        except (IndexError, ValueError):
            return subprocess.CompletedProcess(
                args=list(args),
                returncode=1,
                stdout="",
                stderr="bad args",
            )
        if n in existing:
            return subprocess.CompletedProcess(
                args=list(args),
                returncode=0,
                stdout=json.dumps({"number": n, "url": f"https://example.com/{n}"}),
                stderr="",
            )
        return subprocess.CompletedProcess(
            args=list(args),
            returncode=1,
            stdout="",
            stderr=f"GraphQL: Could not resolve to an Issue with the number of {n}.",
        )

    return _fake_call


def _run(argv: list[str]) -> int:
    """Run ``slice_record_existing.main`` with no implicit defaults."""
    return slice_record_existing.main(argv)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_record_existing_writes_valid_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1119, 1121, 1122, 1123}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1119",
            "--children=1121,1122,1123",
            "--repo=deftai/directive",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    records = slice_record.read_all(path=_slices_path(root))
    assert len(records) == 1
    record = records[0]
    assert record["umbrella"] == 1119
    assert record["actor"] == "manual:operator"
    assert record["expected_close_signal"] == "all-children-merged"
    assert {c["n"] for c in record["children"]} == {1121, 1122, 1123}
    # Default wave assignment is 1.
    assert all(c["wave"] == 1 for c in record["children"])
    assert all(c["role"] == "manual" for c in record["children"])


# ---------------------------------------------------------------------------
# Dry-run
# ---------------------------------------------------------------------------


def test_dry_run_prints_preview_without_writing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={42, 100, 101}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=42",
            "--children=100,101",
            "--repo=owner/repo",
            "--dry-run",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    captured = capsys.readouterr()
    # The script emits the proposed entry to stdout as pretty-printed JSON
    # (indent=2, multi-line) and the DRY-RUN summary to stderr.
    payload = json.loads(captured.out)
    assert payload["umbrella"] == 42
    assert payload["slice_id"] == "<dry-run>"
    assert "DRY-RUN" in captured.err
    # File NOT written.
    assert not _slices_path(root).exists()


# ---------------------------------------------------------------------------
# Idempotency + --force
# ---------------------------------------------------------------------------


def test_idempotent_repeat_is_a_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2, 3}))
    common = [
        "record-existing",
        "--umbrella=1",
        "--children=2,3",
        "--repo=owner/repo",
        f"--project-root={root}",
    ]
    assert _run(common) == 0
    capsys.readouterr()  # discard first-run output
    assert _run(common) == 0
    captured = capsys.readouterr()
    assert "already has a matching record" in captured.err
    records = slice_record.read_all(path=_slices_path(root))
    assert len(records) == 1  # second invocation did NOT append


def test_force_writes_second_record_for_same_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2, 3}))
    common = [
        "record-existing",
        "--umbrella=1",
        "--children=2,3",
        "--repo=owner/repo",
        f"--project-root={root}",
    ]
    assert _run(common) == 0
    assert _run([*common, "--force"]) == 0
    records = slice_record.read_all(path=_slices_path(root))
    assert len(records) == 2
    assert records[0]["slice_id"] != records[1]["slice_id"]


# ---------------------------------------------------------------------------
# Validation failures
# ---------------------------------------------------------------------------


def test_missing_umbrella_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={2, 3}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 1
    captured = capsys.readouterr()
    assert "issue #1" in captured.err
    assert not _slices_path(root).exists()


def test_missing_child_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2}))  # 3 missing
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 1
    captured = capsys.readouterr()
    assert "issue #3" in captured.err


def test_skip_validation_allows_unknown_issues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``--skip-validation`` bypasses the scm.call probe entirely."""
    root = _make_consumer_root(tmp_path)
    # No scm.call patch: an actual invocation would fail. The flag must
    # short-circuit the probe so the test passes without one.
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3",
            "--repo=owner/repo",
            "--skip-validation",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    assert _slices_path(root).exists()


# ---------------------------------------------------------------------------
# Wave assignment
# ---------------------------------------------------------------------------


def test_single_wave_assignment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2, 3, 4}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3,4",
            "--wave-2=3,4",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    record = slice_record.read_all(path=_slices_path(root))[0]
    by_n = {c["n"]: c["wave"] for c in record["children"]}
    assert by_n == {2: 1, 3: 2, 4: 2}


def test_multi_wave_assignment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing=set(range(1, 11))))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3,4,5,6,7",
            "--wave-1=2,3",
            "--wave-2=4,5",
            "--wave-3=6,7",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    record = slice_record.read_all(path=_slices_path(root))[0]
    waves = {c["n"]: c["wave"] for c in record["children"]}
    assert waves == {2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3}


def test_wave_member_not_in_children_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2, 3}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3",
            "--wave-2=999",  # not in --children
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 2
    captured = capsys.readouterr()
    assert "--wave-2" in captured.err and "999" in captured.err


def test_cross_wave_collision_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2, 3}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,3",
            "--wave-1=2",
            "--wave-2=2",  # same child in two waves
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 2
    captured = capsys.readouterr()
    assert "two wave" in captured.err.lower() or "both" in captured.err.lower()


# ---------------------------------------------------------------------------
# Notes + custom sliced-at
# ---------------------------------------------------------------------------


def test_custom_actor_and_notes_persist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2",
            "--actor=manual:carol",
            "--notes=backfill after N7 landed",
            "--sliced-at=2026-05-14T17:00:00Z",
            "--expected-close-signal=wave-1-merged",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    record = slice_record.read_all(path=_slices_path(root))[0]
    assert record["actor"] == "manual:carol"
    assert record["notes"] == "backfill after N7 landed"
    assert record["sliced_at"] == "2026-05-14T17:00:00Z"
    assert record["expected_close_signal"] == "wave-1-merged"


# ---------------------------------------------------------------------------
# slice:list
# ---------------------------------------------------------------------------


def test_slice_list_distinguishes_actors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    root = _make_consumer_root(tmp_path)
    # Seed via direct write_slice -- two records, different actors.
    slice_record.write_slice(
        umbrella=10,
        umbrella_url="https://github.com/owner/repo/issues/10",
        actor="skill:gh-slice",
        children=[
            {"n": 11, "url": "u", "wave": 1, "role": "feature"},
        ],
        path=_slices_path(root),
    )
    slice_record.write_slice(
        umbrella=20,
        umbrella_url="https://github.com/owner/repo/issues/20",
        actor="manual:operator",
        children=[
            {"n": 21, "url": "u", "wave": 1, "role": "manual"},
        ],
        path=_slices_path(root),
    )
    rc = _run(["list", f"--project-root={root}"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "umbrella=#10" in out
    assert "umbrella=#20" in out
    assert "skill:gh-slice" in out
    assert "manual:operator" in out


def test_slice_list_empty_emits_friendly_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    rc = _run(["list", f"--project-root={root}"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "no records found" in out


def test_slice_list_json_output(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _make_consumer_root(tmp_path)
    slice_record.write_slice(
        umbrella=10,
        umbrella_url="https://github.com/owner/repo/issues/10",
        actor="manual:operator",
        children=[{"n": 11, "url": "u", "wave": 1, "role": "manual"}],
        path=_slices_path(root),
    )
    rc = _run(["list", "--json", f"--project-root={root}"])
    assert rc == 0
    out = capsys.readouterr().out.strip()
    parsed = json.loads(out)
    assert isinstance(parsed, list) and len(parsed) == 1
    assert parsed[0]["umbrella"] == 10


# ---------------------------------------------------------------------------
# Argv quirks
# ---------------------------------------------------------------------------


def test_default_subcommand_is_record_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Invoking with no sub-command implicitly selects `record-existing`."""
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2}))
    rc = _run(
        [
            "--umbrella=1",
            "--children=2",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 0
    assert _slices_path(root).exists()


def test_umbrella_in_children_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=1,2",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 2
    captured = capsys.readouterr()
    assert "cannot also appear" in captured.err


def test_duplicate_child_aborts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _make_consumer_root(tmp_path)
    monkeypatch.setattr(scm, "call", _fake_call_factory(existing={1, 2}))
    rc = _run(
        [
            "record-existing",
            "--umbrella=1",
            "--children=2,2",
            "--repo=owner/repo",
            f"--project-root={root}",
        ]
    )
    assert rc == 2
    captured = capsys.readouterr()
    assert "duplicate" in captured.err.lower()
