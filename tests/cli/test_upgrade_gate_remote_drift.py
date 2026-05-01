# tests/cli/test_upgrade_gate_remote_drift.py -- gate integration for #801.
#
# Covers:
# - Probe runs in _check_upgrade_gate on the HAPPY path (recorded == VERSION):
#   the warn line + event MUST surface even when no local drift is present.
# - Probe runs on the UNHAPPY path (recorded != VERSION): both the existing
#   recorded-vs-current warn AND the new informational warn appear, in that
#   order. No second prompt.
# - The probe is non-blocking: the gate returns True non-interactively
#   (sys.stdin.isatty() == False) regardless of probe outcome.
# - "framework:remote-drift" is the canonical event name (registered in
#   events/registry.json).
# - An OK probe (no drift) emits no warn line and no event.
#
# Story: #801 (periodic-remote-version-probe)
from __future__ import annotations

import io
import sys
from pathlib import Path


def _force_non_interactive(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)


def _force_interactive(monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True, raising=False)


def _enable_real_helper(deft_run_module, monkeypatch):
    real_fn = deft_run_module._real_maybe_emit_remote_drift_warning
    monkeypatch.setattr(
        deft_run_module, "_maybe_emit_remote_drift_warning", real_fn
    )


def _stub_probe(deft_run_module, monkeypatch, status, remote_tag="v99.0.0"):
    payload = {
        "status": status,
        "current": deft_run_module.VERSION,
        "upstream_url": "https://example/deft.git",
    }
    if status == "behind":
        payload["remote"] = remote_tag
    monkeypatch.setattr(
        deft_run_module, "_run_remote_probe", lambda project_root: payload
    )


def _capture_emitted_events(deft_run_module, monkeypatch):
    captured = []
    monkeypatch.setattr(
        deft_run_module,
        "_emit_event_safe",
        lambda name, payload: captured.append((name, payload)),
    )
    return captured


# ---------------------------------------------------------------------------
# Happy path: probe runs even when the marker matches VERSION
# ---------------------------------------------------------------------------


class TestProbeRunsOnHappyPath:
    def test_behind_emits_warn_and_event_when_marker_matches(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        _force_non_interactive(monkeypatch)
        _enable_real_helper(deft_run_module, monkeypatch)
        _stub_probe(deft_run_module, monkeypatch, "behind", remote_tag="v99.0.0")
        events = _capture_emitted_events(deft_run_module, monkeypatch)

        result = deft_run_module._check_upgrade_gate("project")

        assert result is True
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "Upstream directive" in combined
        assert "v99.0.0" in combined
        # The existing recorded-vs-current warn MUST NOT fire on the happy path.
        assert "Deft has been updated" not in combined
        names = [n for (n, _) in events]
        assert names.count("framework:remote-drift") == 1
        drift_payload = next(p for (n, p) in events if n == "framework:remote-drift")
        assert drift_payload["current_version"] == deft_run_module.VERSION
        assert drift_payload["remote_version"] == "v99.0.0"
        assert "project_root" in drift_payload
        assert "upstream_url" in drift_payload

    def test_ok_emits_no_warn_no_event(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        _force_non_interactive(monkeypatch)
        _enable_real_helper(deft_run_module, monkeypatch)
        _stub_probe(deft_run_module, monkeypatch, "ok")
        events = _capture_emitted_events(deft_run_module, monkeypatch)

        result = deft_run_module._check_upgrade_gate("project")

        assert result is True
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "Upstream directive" not in combined
        names = [n for (n, _) in events]
        assert "framework:remote-drift" not in names


# ---------------------------------------------------------------------------
# Unhappy path: probe + recorded-vs-current both surface
# ---------------------------------------------------------------------------


class TestProbeRunsOnUnhappyPath:
    def test_drift_plus_behind_both_emit(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            "0.1.0\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        _force_non_interactive(monkeypatch)
        _enable_real_helper(deft_run_module, monkeypatch)
        _stub_probe(deft_run_module, monkeypatch, "behind", remote_tag="v99.0.0")
        events = _capture_emitted_events(deft_run_module, monkeypatch)

        result = deft_run_module._check_upgrade_gate("project")

        assert result is True
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "Deft has been updated" in combined
        assert "Upstream directive" in combined
        # Output ordering: recorded-vs-current first, probe-driven warn after.
        idx_local = combined.index("Deft has been updated")
        idx_remote = combined.index("Upstream directive")
        assert idx_local < idx_remote
        names = [n for (n, _) in events]
        assert "version:drift" in names
        assert "framework:remote-drift" in names

    def test_no_second_prompt_on_remote_drift_only(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        # A clean local marker + remote BEHIND must NOT trigger the
        # "Continue anyway?" prompt: remote drift is informational only.
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        _force_interactive(monkeypatch)

        def _forbidden_prompt(*args, **kwargs):
            raise AssertionError(
                "read_yn must NOT be called for remote-drift-only scenarios"
            )

        monkeypatch.setattr(deft_run_module, "read_yn", _forbidden_prompt)
        _enable_real_helper(deft_run_module, monkeypatch)
        _stub_probe(deft_run_module, monkeypatch, "behind", remote_tag="v99.0.0")
        _capture_emitted_events(deft_run_module, monkeypatch)

        result = deft_run_module._check_upgrade_gate("project")
        assert result is True


# ---------------------------------------------------------------------------
# Probe failure modes do not break the gate
# ---------------------------------------------------------------------------


class TestProbeFailureNeverBreaksGate:
    def test_probe_exception_swallowed(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        _force_non_interactive(monkeypatch)

        def _explode(project_root):
            raise RuntimeError("contrived failure inside probe")

        monkeypatch.setattr(
            deft_run_module, "_maybe_emit_remote_drift_warning", _explode
        )

        result = deft_run_module._check_upgrade_gate("project")
        assert result is True


# ---------------------------------------------------------------------------
# Event registry consistency
# ---------------------------------------------------------------------------


def _ensure_scripts_on_path():
    scripts_dir = Path(__file__).resolve().parents[2] / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))


class TestEventRegistry:
    def test_event_name_in_registry(self):
        _ensure_scripts_on_path()
        from _event_detect import (  # type: ignore[import-not-found]
            clear_registry_cache,
            registered_event_names,
        )
        clear_registry_cache()
        assert "framework:remote-drift" in registered_event_names()

    def test_detect_remote_drift_returns_payload_on_behind(self, tmp_path):
        _ensure_scripts_on_path()
        from _event_detect import detect_remote_drift  # type: ignore[import-not-found]

        probe_result = {
            "status": "behind",
            "current": "0.23.0",
            "remote": "v0.23.1",
            "upstream_url": "https://example/deft.git",
        }
        payload = detect_remote_drift(tmp_path, probe_result=probe_result)
        assert payload is not None
        assert payload["current_version"] == "0.23.0"
        assert payload["remote_version"] == "v0.23.1"
        assert payload["upstream_url"] == "https://example/deft.git"
        assert payload["commits_behind"] is None
        assert "project_root" in payload

    def test_detect_remote_drift_returns_none_on_ok(self, tmp_path):
        _ensure_scripts_on_path()
        from _event_detect import detect_remote_drift  # type: ignore[import-not-found]

        assert detect_remote_drift(tmp_path, probe_result={"status": "ok"}) is None
        assert detect_remote_drift(tmp_path, probe_result=None) is None
