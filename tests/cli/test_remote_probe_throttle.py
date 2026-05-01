"""tests/cli/test_remote_probe_throttle.py -- Throttle cadence tests for #801.

Covers:
- Read of missing throttle file returns {}
- Read of malformed JSON returns {} (best-effort)
- Round-trip: write state -> read state matches
- 24h probe cadence: skipped at 23h59m, fires at 24h+1m
- 24h notification cadence: same tag within 24h is skipped
- Per-tag re-notification: a fresh tag fires immediately even within 24h
- Per-session dedup: second invocation in the same process is a no-op
- DEFT_FORCE_REMOTE_PROBE bypasses the throttle

Story: #801 (periodic-remote-version-probe)
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stub_probe(deft_run_module, monkeypatch, status: str, remote_tag: str = "v99.0.0"):
    """Replace ``_run_remote_probe`` with a canned status so the throttle
    helper does not shell out to git during the cadence tests.
    """
    payload = {
        "status": status,
        "current": deft_run_module.VERSION,
        "upstream_url": "https://example/deft.git",
    }
    if status == "behind":
        payload["remote"] = remote_tag
    monkeypatch.setattr(
        deft_run_module,
        "_run_remote_probe",
        lambda project_root: payload,
    )


def _freeze_now(deft_run_module, monkeypatch, when: datetime):
    """Pin `_now_utc` to a fixed timestamp."""
    monkeypatch.setattr(deft_run_module, "_now_utc", lambda: when)


def _enable_real_helper(deft_run_module, monkeypatch):
    """Restore the real `_maybe_emit_remote_drift_warning` (the autouse
    fixture in tests/cli/conftest.py replaces it with a no-op).

    The autouse fixture stashes the original on the module under
    ``_real_maybe_emit_remote_drift_warning`` before patching; this helper
    just monkeypatches the active attribute back to that captured value
    so the test exercise the real cadence / warn / event-emission path.
    """
    real_fn = deft_run_module._real_maybe_emit_remote_drift_warning
    monkeypatch.setattr(
        deft_run_module,
        "_maybe_emit_remote_drift_warning",
        real_fn,
    )


# ---------------------------------------------------------------------------
# State file round-trip
# ---------------------------------------------------------------------------


class TestStateFileIO:
    """`_read_remote_probe_state` / `_write_remote_probe_state` are best-effort."""

    def test_read_missing_file_returns_empty(self, tmp_path, deft_run_module):
        assert deft_run_module._read_remote_probe_state(tmp_path) == {}

    def test_read_malformed_json_returns_empty(self, tmp_path, deft_run_module):
        path = tmp_path / "vbrief" / ".deft-remote-probe.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("not valid json {{{", encoding="utf-8")
        assert deft_run_module._read_remote_probe_state(tmp_path) == {}

    def test_read_non_object_json_returns_empty(self, tmp_path, deft_run_module):
        """A JSON list (non-object) is rejected; throttle expects a dict."""
        path = tmp_path / "vbrief" / ".deft-remote-probe.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("[1, 2, 3]", encoding="utf-8")
        assert deft_run_module._read_remote_probe_state(tmp_path) == {}

    def test_round_trip(self, tmp_path, deft_run_module):
        state = {
            "last_probed_at": "2026-05-01T00:00:00Z",
            "last_seen_remote": "v0.23.1",
            "last_notified_at": "2026-05-01T00:00:00Z",
            "last_notified_tag": "v0.23.1",
        }
        deft_run_module._write_remote_probe_state(tmp_path, state)
        path = tmp_path / "vbrief" / ".deft-remote-probe.json"
        assert path.is_file()
        loaded = deft_run_module._read_remote_probe_state(tmp_path)
        assert loaded == state


# ---------------------------------------------------------------------------
# Cadence
# ---------------------------------------------------------------------------


class TestCadence:
    """The 24h probe and 24h notification floors are honored."""

    def test_fresh_state_fires_probe_and_writes_state(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _enable_real_helper(deft_run_module, monkeypatch)
        _stub_probe(deft_run_module, monkeypatch, "ok")
        _freeze_now(
            deft_run_module,
            monkeypatch,
            datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC),
        )

        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)

        state = deft_run_module._read_remote_probe_state(tmp_path)
        assert "last_probed_at" in state

    def test_probe_skipped_within_24h(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _enable_real_helper(deft_run_module, monkeypatch)
        # Pre-seed state with last_probed_at 23h59m ago.
        now = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
        recent = now - timedelta(hours=23, minutes=59)
        deft_run_module._write_remote_probe_state(
            tmp_path,
            {"last_probed_at": recent.strftime("%Y-%m-%dT%H:%M:%SZ")},
        )

        probe_calls = {"count": 0}

        def _spy_probe(project_root):
            probe_calls["count"] += 1
            return {"status": "ok", "current": deft_run_module.VERSION}

        monkeypatch.setattr(deft_run_module, "_run_remote_probe", _spy_probe)
        _freeze_now(deft_run_module, monkeypatch, now)

        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)

        assert probe_calls["count"] == 0, "Probe must be skipped within 24h cadence"

    def test_probe_fires_after_24h(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _enable_real_helper(deft_run_module, monkeypatch)
        now = datetime(2026, 5, 2, 12, 1, 0, tzinfo=UTC)
        old = now - timedelta(hours=24, minutes=1)
        deft_run_module._write_remote_probe_state(
            tmp_path,
            {"last_probed_at": old.strftime("%Y-%m-%dT%H:%M:%SZ")},
        )

        probe_calls = {"count": 0}

        def _spy_probe(project_root):
            probe_calls["count"] += 1
            return {"status": "ok", "current": deft_run_module.VERSION}

        monkeypatch.setattr(deft_run_module, "_run_remote_probe", _spy_probe)
        _freeze_now(deft_run_module, monkeypatch, now)

        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)

        assert probe_calls["count"] == 1, "Probe must fire after 24h cadence"

    def test_force_bypasses_throttle(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _enable_real_helper(deft_run_module, monkeypatch)
        now = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
        recent = now - timedelta(minutes=1)
        deft_run_module._write_remote_probe_state(
            tmp_path,
            {"last_probed_at": recent.strftime("%Y-%m-%dT%H:%M:%SZ")},
        )

        probe_calls = {"count": 0}

        def _spy_probe(project_root):
            probe_calls["count"] += 1
            return {"status": "ok", "current": deft_run_module.VERSION}

        monkeypatch.setattr(deft_run_module, "_run_remote_probe", _spy_probe)
        _freeze_now(deft_run_module, monkeypatch, now)
        monkeypatch.setenv("DEFT_FORCE_REMOTE_PROBE", "1")

        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)

        assert probe_calls["count"] == 1, (
            "DEFT_FORCE_REMOTE_PROBE=1 must bypass the throttle"
        )


# ---------------------------------------------------------------------------
# Per-tag re-notification + per-session dedup
# ---------------------------------------------------------------------------


class TestNotificationCadence:
    """Notifications respect 24h floor for the same tag; new tags re-notify immediately."""

    def test_same_tag_within_24h_skips_notification(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        # Greptile P2 (PR #811): seed last_probed_at to >24h ago so the probe
        # cadence check passes and we ACTUALLY reach the per-tag notification
        # cadence guard. Setting last_probed_at within 24h would short-circuit
        # at the probe-floor check and never exercise the same_tag_within_floor
        # branch this test claims to cover.
        _enable_real_helper(deft_run_module, monkeypatch)
        now = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
        recent = now - timedelta(hours=12)  # within 24h notify floor
        old = now - timedelta(hours=25)  # past 24h probe floor
        deft_run_module._write_remote_probe_state(
            tmp_path,
            {
                "last_probed_at": old.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last_notified_at": recent.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last_notified_tag": "v99.0.0",
            },
        )
        _stub_probe(deft_run_module, monkeypatch, "behind", remote_tag="v99.0.0")
        _freeze_now(deft_run_module, monkeypatch, now)

        # Per-session dedup must not pre-empt the cadence assertion.
        monkeypatch.setattr(deft_run_module, "_PROBE_NOTIFIED_THIS_SESSION", False)

        # No DEFT_FORCE_REMOTE_PROBE -- the same-tag-within-24h notification
        # cadence guard is what should suppress the banner here, not the
        # probe-floor check.
        monkeypatch.delenv("DEFT_FORCE_REMOTE_PROBE", raising=False)
        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)
        captured = capsys.readouterr()
        combined = captured.out + captured.err

        # No warn line should appear -- same tag dismissed within 24h.
        assert "Upstream directive" not in combined

    def test_new_tag_re_notifies_immediately(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        _enable_real_helper(deft_run_module, monkeypatch)
        now = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
        recent = now - timedelta(hours=12)
        deft_run_module._write_remote_probe_state(
            tmp_path,
            {
                "last_probed_at": (now - timedelta(hours=25)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last_notified_at": recent.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last_notified_tag": "v99.0.0",
            },
        )
        # New tag higher than the previously-notified one.
        _stub_probe(deft_run_module, monkeypatch, "behind", remote_tag="v99.1.0")
        _freeze_now(deft_run_module, monkeypatch, now)
        monkeypatch.setattr(deft_run_module, "_PROBE_NOTIFIED_THIS_SESSION", False)

        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)
        captured = capsys.readouterr()
        combined = captured.out + captured.err

        assert "v99.1.0" in combined
        assert "Upstream directive" in combined

    def test_per_session_dedup_blocks_second_call(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        _enable_real_helper(deft_run_module, monkeypatch)
        now = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)
        _freeze_now(deft_run_module, monkeypatch, now)
        _stub_probe(deft_run_module, monkeypatch, "behind", remote_tag="v99.0.0")
        # Set the dedup flag manually as if a prior call in the same process
        # already emitted the banner.
        monkeypatch.setattr(deft_run_module, "_PROBE_NOTIFIED_THIS_SESSION", True)

        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)
        captured = capsys.readouterr()
        combined = captured.out + captured.err

        # The dedup short-circuit returns before the probe even runs,
        # so no warn line is emitted.
        assert "Upstream directive" not in combined


# ---------------------------------------------------------------------------
# Failure-mode safety
# ---------------------------------------------------------------------------


class TestSafety:
    """The helper never raises -- it swallows every failure mode."""

    def test_helper_does_not_raise_on_internal_error(
        self, tmp_path, deft_run_module, monkeypatch
    ):
        _enable_real_helper(deft_run_module, monkeypatch)

        def _boom(project_root):
            raise RuntimeError("unexpected internal error")

        monkeypatch.setattr(deft_run_module, "_run_remote_probe", _boom)
        _freeze_now(
            deft_run_module,
            monkeypatch,
            datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC),
        )
        monkeypatch.setattr(deft_run_module, "_PROBE_NOTIFIED_THIS_SESSION", False)

        # Must not raise.
        deft_run_module._maybe_emit_remote_drift_warning(tmp_path)


# ---------------------------------------------------------------------------
# ISO timestamp parser
# ---------------------------------------------------------------------------


class TestIsoParser:
    """`_parse_iso_utc` accepts the formats `_now_utc_iso` emits and returns None on garbage."""

    def test_round_trip(self, deft_run_module):
        ts = "2026-05-01T12:34:56Z"
        parsed = deft_run_module._parse_iso_utc(ts)
        assert parsed is not None
        assert parsed.tzinfo is not None

    def test_offset_form(self, deft_run_module):
        parsed = deft_run_module._parse_iso_utc("2026-05-01T12:34:56+00:00")
        assert parsed is not None
        assert parsed.tzinfo is not None

    def test_empty_returns_none(self, deft_run_module):
        assert deft_run_module._parse_iso_utc("") is None

    def test_garbage_returns_none(self, deft_run_module):
        assert deft_run_module._parse_iso_utc("not-a-timestamp") is None
