"""test_release_rollback.py -- Tests for scripts/release_rollback.py (#716, #725).

Coverage matrix per #716 acceptance criteria + #725 acceptance criteria:

- compute_threshold: < 5 min (0), 5-30 min (max(N, 10)), 30+ min (None),
  --force-strict-0 short-circuit, --allow-data-loss short-circuit
- _release_age_seconds: ISO-8601 with Z, with explicit offset, malformed,
  missing -> 0 fallback
- _sum_downloads: aggregates across assets, ignores non-int values
- double_read_downloads: two-read agreement, race detection (count grew),
  first-read failure, second-read failure
- detect_state: released (gh exists), tag-pushed-no-release, local-only,
  absent, error (gh probe failed)
- run_rollback: each detected state branch + dry-run + escape-hatch overrides
  + 30-min refusal + race-condition refusal
- main: invalid version exits 2, --help exits 0, --allow-low-downloads
  negative exits 2

#725 coverage: resolve_release_prep_sha (rev-parse happy path, grep fallback,
both-fail refusal); git_revert_release_commit (success, conflict + abort +
manual-recovery hint); git_push_base (no --force / --force-with-lease in
argv); each unwind branch resolves SHA BEFORE deleting tag and uses the
resolved SHA (not HEAD~1) as the revert target; no force-push remains
anywhere in the new pipeline; intervening-commit scenario asserts the
resolved SHA is the revert target (not whatever HEAD~1 happens to be).

Refs #716, #725, #74.
"""

from __future__ import annotations

import datetime as _dt
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    if "release" not in sys.modules:
        spec_r = importlib.util.spec_from_file_location(
            "release", scripts_dir / "release.py"
        )
        assert spec_r is not None and spec_r.loader is not None
        mod_r = importlib.util.module_from_spec(spec_r)
        sys.modules["release"] = mod_r
        spec_r.loader.exec_module(mod_r)
    spec = importlib.util.spec_from_file_location(
        "release_rollback",
        scripts_dir / "release_rollback.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release_rollback"] = module
    spec.loader.exec_module(module)
    return module


release_rollback = _load_module()


def _config(**overrides):
    defaults = {
        "version": "0.21.0",
        "repo": "deftai/directive",
        "base_branch": "master",
        "project_root": Path("."),
        "dry_run": False,
        "allow_low_downloads": 0,
        "allow_data_loss": False,
        "force_strict_0": False,
        "skip_sleep": True,
    }
    defaults.update(overrides)
    return release_rollback.RollbackConfig(**defaults)


# ---------------------------------------------------------------------------
# compute_threshold
# ---------------------------------------------------------------------------


class TestComputeThreshold:
    def test_under_five_minutes_strict_zero(self):
        threshold, reason = release_rollback.compute_threshold(
            60, allow_low_downloads=0, allow_data_loss=False, force_strict_0=False
        )
        assert threshold == 0
        assert "< 5 min" in reason

    def test_five_to_thirty_default_ten(self):
        threshold, _ = release_rollback.compute_threshold(
            10 * 60,
            allow_low_downloads=0,
            allow_data_loss=False,
            force_strict_0=False,
        )
        assert threshold == 10

    def test_five_to_thirty_with_low_downloads_override_takes_max(self):
        threshold, _ = release_rollback.compute_threshold(
            10 * 60,
            allow_low_downloads=20,
            allow_data_loss=False,
            force_strict_0=False,
        )
        assert threshold == 20

    def test_five_to_thirty_with_low_downloads_below_default_keeps_default(self):
        threshold, _ = release_rollback.compute_threshold(
            10 * 60,
            allow_low_downloads=5,
            allow_data_loss=False,
            force_strict_0=False,
        )
        assert threshold == 10

    def test_over_thirty_refuses_without_data_loss_flag(self):
        threshold, reason = release_rollback.compute_threshold(
            45 * 60,
            allow_low_downloads=999,
            allow_data_loss=False,
            force_strict_0=False,
        )
        assert threshold is None
        assert "30 min" in reason

    def test_over_thirty_with_data_loss_flag_accepts_any(self):
        threshold, reason = release_rollback.compute_threshold(
            45 * 60,
            allow_low_downloads=0,
            allow_data_loss=True,
            force_strict_0=False,
        )
        assert threshold is not None
        assert threshold > 1_000_000  # effectively infinite
        assert "allow-data-loss" in reason

    def test_force_strict_zero_short_circuits_old_release(self):
        threshold, reason = release_rollback.compute_threshold(
            45 * 60,
            allow_low_downloads=0,
            allow_data_loss=False,
            force_strict_0=True,
        )
        assert threshold == 0
        assert "force-strict-0" in reason

    def test_force_strict_zero_overrides_data_loss(self):
        threshold, _ = release_rollback.compute_threshold(
            10 * 60,
            allow_low_downloads=999,
            allow_data_loss=True,
            force_strict_0=True,
        )
        assert threshold == 0


# ---------------------------------------------------------------------------
# _release_age_seconds
# ---------------------------------------------------------------------------


class TestReleaseAgeSeconds:
    def test_iso_with_trailing_z(self):
        now = _dt.datetime(2026, 4, 28, 19, 0, 0, tzinfo=_dt.UTC)
        payload = {"createdAt": "2026-04-28T18:50:00Z"}
        age = release_rollback._release_age_seconds(payload, now=now)
        assert age == 600

    def test_iso_with_explicit_offset(self):
        now = _dt.datetime(2026, 4, 28, 19, 0, 0, tzinfo=_dt.UTC)
        payload = {"createdAt": "2026-04-28T18:30:00+00:00"}
        age = release_rollback._release_age_seconds(payload, now=now)
        assert age == 1800

    def test_falls_back_to_published_at_if_created_missing(self):
        now = _dt.datetime(2026, 4, 28, 19, 0, 0, tzinfo=_dt.UTC)
        payload = {"publishedAt": "2026-04-28T18:55:00Z"}
        age = release_rollback._release_age_seconds(payload, now=now)
        assert age == 300

    def test_missing_returns_zero(self):
        assert release_rollback._release_age_seconds({}) == 0

    def test_malformed_returns_zero(self):
        assert (
            release_rollback._release_age_seconds({"createdAt": "not-a-date"})
            == 0
        )


# ---------------------------------------------------------------------------
# _sum_downloads
# ---------------------------------------------------------------------------


class TestSumDownloads:
    def test_aggregates_across_assets(self):
        payload = {
            "assets": [
                {"downloadCount": 3},
                {"downloadCount": 7},
                {"downloadCount": 0},
            ]
        }
        assert release_rollback._sum_downloads(payload) == 10

    def test_ignores_non_int_values(self):
        payload = {
            "assets": [
                {"downloadCount": 3},
                {"downloadCount": None},
                {"downloadCount": "abc"},
                {"downloadCount": 5},
            ]
        }
        assert release_rollback._sum_downloads(payload) == 8

    def test_empty_assets(self):
        assert release_rollback._sum_downloads({"assets": []}) == 0
        assert release_rollback._sum_downloads({}) == 0


# ---------------------------------------------------------------------------
# double_read_downloads
# ---------------------------------------------------------------------------


class TestDoubleReadDownloads:
    def test_two_reads_agree(self, monkeypatch):
        sequence = iter(
            [
                (True, {"assets": [{"downloadCount": 3}]}, ""),
                (True, {"assets": [{"downloadCount": 3}]}, ""),
            ]
        )

        monkeypatch.setattr(
            release_rollback,
            "_gh_release_view_json",
            lambda version, repo: next(sequence),
        )
        ok, c1, c2, reason = release_rollback.double_read_downloads(
            "0.21.0", "deftai/directive", sleep_seconds=0
        )
        assert ok is True
        assert c1 == 3
        assert c2 == 3
        assert reason == ""

    def test_race_detected_when_count_grows(self, monkeypatch):
        sequence = iter(
            [
                (True, {"assets": [{"downloadCount": 3}]}, ""),
                (True, {"assets": [{"downloadCount": 5}]}, ""),
            ]
        )

        monkeypatch.setattr(
            release_rollback,
            "_gh_release_view_json",
            lambda version, repo: next(sequence),
        )
        ok, c1, c2, reason = release_rollback.double_read_downloads(
            "0.21.0", "deftai/directive", sleep_seconds=0
        )
        assert ok is False
        assert c1 == 3
        assert c2 == 5
        assert "grew between reads" in reason

    def test_first_read_failure(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "_gh_release_view_json",
            lambda version, repo: (False, None, "auth required"),
        )
        ok, _, _, reason = release_rollback.double_read_downloads(
            "0.21.0", "deftai/directive", sleep_seconds=0
        )
        assert ok is False
        assert "first read failed" in reason

    def test_second_read_failure(self, monkeypatch):
        sequence = iter(
            [
                (True, {"assets": [{"downloadCount": 3}]}, ""),
                (False, None, "503"),
            ]
        )

        monkeypatch.setattr(
            release_rollback,
            "_gh_release_view_json",
            lambda version, repo: next(sequence),
        )
        ok, _, _, reason = release_rollback.double_read_downloads(
            "0.21.0", "deftai/directive", sleep_seconds=0
        )
        assert ok is False
        assert "second read failed" in reason


# ---------------------------------------------------------------------------
# detect_state
# ---------------------------------------------------------------------------


class TestDetectState:
    def test_released_state(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "gh_release_exists",
            lambda v, r: ("exists", {"isDraft": False, "assets": []}, ""),
        )
        state, payload, _ = release_rollback.detect_state(_config())
        assert state == "released"
        assert payload is not None

    def test_tag_pushed_no_release(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "gh_release_exists",
            lambda v, r: ("not-found", None, "release not found"),
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_local", lambda root, v: True
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_origin", lambda root, v: True
        )
        state, payload, _ = release_rollback.detect_state(_config())
        assert state == "tag-pushed-no-release"
        assert payload is None

    def test_local_only(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "gh_release_exists",
            lambda v, r: ("not-found", None, "release not found"),
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_local", lambda root, v: True
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_origin", lambda root, v: False
        )
        state, payload, _ = release_rollback.detect_state(_config())
        assert state == "local-only"
        assert payload is None

    def test_absent(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "gh_release_exists",
            lambda v, r: ("not-found", None, "release not found"),
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_local", lambda root, v: False
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_origin", lambda root, v: False
        )
        state, payload, _ = release_rollback.detect_state(_config())
        assert state == "absent"

    def test_error_state(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "gh_release_exists",
            lambda v, r: ("error", None, "auth required"),
        )
        state, payload, reason = release_rollback.detect_state(_config())
        assert state == "error"
        assert "auth required" in reason


# ---------------------------------------------------------------------------
# run_rollback (state branches + escape hatches)
# ---------------------------------------------------------------------------


class TestRunRollback:
    def test_dry_run_absent_no_op(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_rollback,
            "detect_state",
            lambda config: ("absent", None, ""),
        )
        rc = release_rollback.run_rollback(_config(dry_run=True))
        assert rc == release_rollback.EXIT_OK
        captured = capsys.readouterr()
        assert "DRYRUN" in captured.err

    def test_absent_state_no_op(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_rollback,
            "detect_state",
            lambda config: ("absent", None, ""),
        )
        rc = release_rollback.run_rollback(_config())
        assert rc == release_rollback.EXIT_OK
        captured = capsys.readouterr()
        assert "NOOP" in captured.err

    def test_error_state_exits_violation(self, monkeypatch, capsys):
        monkeypatch.setattr(
            release_rollback,
            "detect_state",
            lambda config: ("error", None, "gh probe failed"),
        )
        rc = release_rollback.run_rollback(_config())
        assert rc == release_rollback.EXIT_VIOLATION

    def test_local_only_invokes_local_unwind(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "detect_state",
            lambda config: ("local-only", None, ""),
        )
        called = {}

        def fake_unwind(config):
            called["local"] = True
            return release_rollback.EXIT_OK

        monkeypatch.setattr(release_rollback, "_unwind_local", fake_unwind)
        rc = release_rollback.run_rollback(_config())
        assert rc == release_rollback.EXIT_OK
        assert called["local"] is True

    def test_tag_pushed_invokes_tag_pushed_unwind(self, monkeypatch):
        monkeypatch.setattr(
            release_rollback,
            "detect_state",
            lambda config: ("tag-pushed-no-release", None, ""),
        )
        called = {}

        def fake_unwind(config):
            called["tag"] = True
            return release_rollback.EXIT_OK

        monkeypatch.setattr(
            release_rollback, "_unwind_tag_pushed_no_release", fake_unwind
        )
        rc = release_rollback.run_rollback(_config())
        assert rc == release_rollback.EXIT_OK
        assert called["tag"] is True

    def test_released_invokes_released_unwind(self, monkeypatch):
        payload = {"assets": [], "createdAt": "2026-04-28T19:00:00Z"}
        monkeypatch.setattr(
            release_rollback,
            "detect_state",
            lambda config: ("released", payload, ""),
        )
        called = {}

        def fake_unwind(config, payload_arg):
            called["payload"] = payload_arg
            return release_rollback.EXIT_OK

        monkeypatch.setattr(release_rollback, "_unwind_released", fake_unwind)
        rc = release_rollback.run_rollback(_config())
        assert rc == release_rollback.EXIT_OK
        assert called["payload"] is payload


_INTERVENING_COMMIT_SHA = "94d1aa5deadbeef0000000000000000000aaaaa1"  # fake HEAD
_RELEASE_PREP_SHA = "6573335cafef00d000000000000000000000bbbb"        # release-prep target


def _patch_resolve_to(monkeypatch, sha):
    monkeypatch.setattr(
        release_rollback,
        "resolve_release_prep_sha",
        lambda root, version: (sha, "") if sha else ("", "resolution failed"),
    )


class TestUnwindLocal:
    def test_happy_path(self, monkeypatch, capsys):
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "git_delete_local_tag",
            lambda root, v: (True, f"deleted local tag v{v}"),
        )
        captured_revert = {}

        def fake_revert(root, sha):
            captured_revert["sha"] = sha
            return True, f"reverted {sha[:12]}"

        monkeypatch.setattr(
            release_rollback, "git_revert_release_commit", fake_revert
        )
        rc = release_rollback._unwind_local(_config())
        assert rc == release_rollback.EXIT_OK
        # #725 acceptance: revert targets the RESOLVED release-prep SHA,
        # NOT HEAD~1.
        assert captured_revert["sha"] == _RELEASE_PREP_SHA

    def test_tag_delete_failure(self, monkeypatch):
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "git_delete_local_tag",
            lambda root, v: (False, "boom"),
        )
        rc = release_rollback._unwind_local(_config())
        assert rc == release_rollback.EXIT_VIOLATION

    def test_revert_failure_refuses_cleanly(self, monkeypatch, capsys):
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "git_delete_local_tag",
            lambda root, v: (True, "ok"),
        )
        monkeypatch.setattr(
            release_rollback,
            "git_revert_release_commit",
            lambda root, sha: (
                False,
                f"git revert {sha[:12]} conflicted: merge conflict in CHANGELOG.md. "
                f"Manual recovery: re-run `git revert {sha} --no-edit`, ...",
            ),
        )
        rc = release_rollback._unwind_local(_config())
        assert rc == release_rollback.EXIT_VIOLATION
        captured = capsys.readouterr()
        # Manual recovery hint is surfaced via the emit on conflict.
        assert "Manual recovery" in captured.err

    def test_resolve_failure_short_circuits(self, monkeypatch):
        _patch_resolve_to(monkeypatch, "")

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "unwind MUST NOT proceed when resolve_release_prep_sha fails"
            )

        monkeypatch.setattr(release_rollback, "git_delete_local_tag", boom)
        monkeypatch.setattr(
            release_rollback, "git_revert_release_commit", boom
        )
        rc = release_rollback._unwind_local(_config())
        assert rc == release_rollback.EXIT_VIOLATION

    def test_resolve_runs_before_tag_delete_intervening_commit(self, monkeypatch):
        """#725 regression: with an intervening commit, unwind targets the
        resolved release-prep SHA -- NOT whatever HEAD~1 happens to be.
        """
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        order: list[str] = []
        captured = {}

        def fake_delete(root, v):
            order.append("delete-tag")
            return True, f"deleted v{v}"

        def fake_revert(root, sha):
            order.append("revert")
            captured["sha"] = sha
            return True, f"reverted {sha[:12]}"

        monkeypatch.setattr(
            release_rollback, "git_delete_local_tag", fake_delete
        )
        monkeypatch.setattr(
            release_rollback, "git_revert_release_commit", fake_revert
        )
        rc = release_rollback._unwind_local(_config())
        assert rc == release_rollback.EXIT_OK
        # Revert targets the resolved release-prep SHA, NOT the
        # intervening HEAD~1 (which would have been _INTERVENING_COMMIT_SHA's
        # parent in a real repo).
        assert captured["sha"] == _RELEASE_PREP_SHA
        assert captured["sha"] != _INTERVENING_COMMIT_SHA
        # Resolve runs before delete (so rev-parse can use the tag), and
        # delete runs before revert (so the tag does not orphan-point at
        # the original release commit).
        assert order == ["delete-tag", "revert"]


class TestUnwindTagPushedNoRelease:
    def _patch_happy_path(self, monkeypatch, captured_push):
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "git_delete_remote_tag",
            lambda root, v: (True, f"deleted remote tag v{v}"),
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_local", lambda root, v: True
        )
        monkeypatch.setattr(
            release_rollback,
            "git_delete_local_tag",
            lambda root, v: (True, f"deleted local tag v{v}"),
        )
        monkeypatch.setattr(
            release_rollback,
            "git_revert_release_commit",
            lambda root, sha: (True, f"reverted {sha[:12]}"),
        )

        def fake_push(root, base):
            captured_push["base"] = base
            return True, f"pushed {base}"

        monkeypatch.setattr(release_rollback, "git_push_base", fake_push)

    def test_happy_path(self, monkeypatch, capsys):
        captured = {}
        self._patch_happy_path(monkeypatch, captured)
        rc = release_rollback._unwind_tag_pushed_no_release(_config())
        assert rc == release_rollback.EXIT_OK
        assert captured["base"] == "master"

    def test_remote_delete_failure(self, monkeypatch):
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "git_delete_remote_tag",
            lambda root, v: (False, "non-fast-forward"),
        )
        rc = release_rollback._unwind_tag_pushed_no_release(_config())
        assert rc == release_rollback.EXIT_VIOLATION

    def test_resolve_failure_short_circuits(self, monkeypatch):
        _patch_resolve_to(monkeypatch, "")

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "tag-pushed unwind MUST NOT proceed when resolve fails"
            )

        monkeypatch.setattr(release_rollback, "git_delete_remote_tag", boom)
        monkeypatch.setattr(release_rollback, "git_push_base", boom)
        rc = release_rollback._unwind_tag_pushed_no_release(_config())
        assert rc == release_rollback.EXIT_VIOLATION

    def test_revert_conflict_aborts_pipeline(self, monkeypatch, capsys):
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "git_delete_remote_tag",
            lambda root, v: (True, "ok"),
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_local", lambda root, v: False
        )
        monkeypatch.setattr(
            release_rollback,
            "git_revert_release_commit",
            lambda root, sha: (
                False,
                f"git revert {sha[:12]} conflicted: ... Manual recovery: ...",
            ),
        )

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError(
                "push MUST NOT run when revert conflicts"
            )

        monkeypatch.setattr(release_rollback, "git_push_base", boom)
        rc = release_rollback._unwind_tag_pushed_no_release(_config())
        assert rc == release_rollback.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "Manual recovery" in captured.err


class TestUnwindReleased:
    def _payload(self, assets=None, age_minutes=2):
        now = _dt.datetime.now(_dt.UTC)
        created = now - _dt.timedelta(minutes=age_minutes)
        return {
            "assets": assets or [],
            "createdAt": created.isoformat().replace("+00:00", "Z"),
            "url": "https://example.com/r",
        }

    def _patch_unwind_helpers(self, monkeypatch, *, captured_revert=None,
                              captured_push=None):
        """Patch all post-guard helpers needed for a successful released-state
        unwind; capture the SHA passed to revert and the base passed to push.
        """
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "gh_release_delete",
            lambda v, r: (True, f"deleted v{v}"),
        )
        monkeypatch.setattr(
            release_rollback, "git_tag_exists_local", lambda root, v: False
        )

        def fake_revert(root, sha):
            if captured_revert is not None:
                captured_revert["sha"] = sha
            return True, f"reverted {sha[:12]}"

        monkeypatch.setattr(
            release_rollback, "git_revert_release_commit", fake_revert
        )

        def fake_push(root, base):
            if captured_push is not None:
                captured_push["base"] = base
            return True, f"pushed {base}"

        monkeypatch.setattr(release_rollback, "git_push_base", fake_push)

    def test_happy_path_under_5_min_zero_downloads(self, monkeypatch):
        payload = self._payload(assets=[{"downloadCount": 0}], age_minutes=2)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 0, 0, ""),
        )
        captured_revert = {}
        captured_push = {}
        self._patch_unwind_helpers(
            monkeypatch,
            captured_revert=captured_revert,
            captured_push=captured_push,
        )
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_OK
        # #725 acceptance: revert targets the resolved release-prep SHA, NOT
        # HEAD~1; push targets the configured base branch (no force).
        assert captured_revert["sha"] == _RELEASE_PREP_SHA
        assert captured_push["base"] == "master"

    def test_under_5_min_with_one_download_refuses(self, monkeypatch, capsys):
        payload = self._payload(assets=[{"downloadCount": 1}], age_minutes=2)
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 1, 1, ""),
        )

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("must not delete release when guard refuses")

        monkeypatch.setattr(release_rollback, "gh_release_delete", boom)
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_VIOLATION
        captured = capsys.readouterr()
        assert "Guard refusal" in captured.err

    def test_5_to_30_min_with_5_downloads_under_default_threshold(
        self, monkeypatch
    ):
        payload = self._payload(assets=[{"downloadCount": 5}], age_minutes=10)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 5, 5, ""),
        )
        self._patch_unwind_helpers(monkeypatch)
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_OK

    def test_5_to_30_min_with_15_downloads_above_default_refuses(
        self, monkeypatch
    ):
        payload = self._payload(assets=[{"downloadCount": 15}], age_minutes=10)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 15, 15, ""),
        )
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_VIOLATION

    def test_5_to_30_min_with_15_and_allow_low_downloads_20_passes(
        self, monkeypatch
    ):
        payload = self._payload(assets=[{"downloadCount": 15}], age_minutes=10)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 15, 15, ""),
        )
        self._patch_unwind_helpers(monkeypatch)
        rc = release_rollback._unwind_released(
            _config(allow_low_downloads=20), payload
        )
        assert rc == release_rollback.EXIT_OK

    def test_over_30_min_refuses_without_data_loss(self, monkeypatch):
        payload = self._payload(assets=[{"downloadCount": 0}], age_minutes=45)

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("guard MUST refuse before reading downloads")

        monkeypatch.setattr(release_rollback, "double_read_downloads", boom)
        monkeypatch.setattr(release_rollback, "gh_release_delete", boom)
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_VIOLATION

    def test_over_30_min_with_allow_data_loss_passes(self, monkeypatch):
        payload = self._payload(
            assets=[{"downloadCount": 100}], age_minutes=45
        )
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 100, 100, ""),
        )
        self._patch_unwind_helpers(monkeypatch)
        rc = release_rollback._unwind_released(
            _config(allow_data_loss=True), payload
        )
        assert rc == release_rollback.EXIT_OK

    def test_force_strict_0_overrides_30_min_window(self, monkeypatch):
        # Old release with 0 downloads + --force-strict-0 -> guard threshold=0,
        # downloads=0 -> proceed.
        payload = self._payload(assets=[{"downloadCount": 0}], age_minutes=45)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (True, 0, 0, ""),
        )
        self._patch_unwind_helpers(monkeypatch)
        rc = release_rollback._unwind_released(
            _config(force_strict_0=True), payload
        )
        assert rc == release_rollback.EXIT_OK

    def test_race_detected_in_double_read_refuses(self, monkeypatch):
        payload = self._payload(assets=[{"downloadCount": 0}], age_minutes=2)
        _patch_resolve_to(monkeypatch, _RELEASE_PREP_SHA)
        monkeypatch.setattr(
            release_rollback,
            "double_read_downloads",
            lambda v, r, sleep_seconds=0: (
                False,
                0,
                1,
                "download_count grew between reads (0 -> 1); ...",
            ),
        )

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("MUST NOT delete release when race detected")

        monkeypatch.setattr(release_rollback, "gh_release_delete", boom)
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_VIOLATION

    def test_dry_run_does_not_invoke_side_effects(self, monkeypatch, capsys):
        payload = self._payload(assets=[{"downloadCount": 0}], age_minutes=2)

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("dry-run MUST NOT invoke side-effecting helpers")

        monkeypatch.setattr(release_rollback, "double_read_downloads", boom)
        monkeypatch.setattr(release_rollback, "gh_release_delete", boom)
        monkeypatch.setattr(
            release_rollback, "git_revert_release_commit", boom
        )
        monkeypatch.setattr(release_rollback, "git_push_base", boom)
        rc = release_rollback._unwind_released(_config(dry_run=True), payload)
        assert rc == release_rollback.EXIT_OK
        captured = capsys.readouterr()
        assert "DRYRUN" in captured.err

    def test_resolve_failure_short_circuits_before_release_delete(
        self, monkeypatch
    ):
        """#725: when resolve fails the release MUST NOT be deleted (we'd be
        committed to an unwind we cannot complete).
        """
        payload = self._payload(assets=[{"downloadCount": 0}], age_minutes=2)
        _patch_resolve_to(monkeypatch, "")

        def boom(*_a, **_kw):  # pragma: no cover
            raise AssertionError("unwind MUST NOT proceed when resolve fails")

        monkeypatch.setattr(release_rollback, "gh_release_delete", boom)
        monkeypatch.setattr(release_rollback, "double_read_downloads", boom)
        rc = release_rollback._unwind_released(_config(), payload)
        assert rc == release_rollback.EXIT_VIOLATION


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
#
# Note: tests for the #725 helpers (resolve_release_prep_sha,
# git_revert_release_commit, git_push_base) and the module-level
# no-force-push invariant live in tests/cli/test_release_rollback_725.py
# to keep this file under the 1000-line limit per AGENTS.md.


class TestMain:
    def test_invalid_version_exits_2(self, capsys):
        rc = release_rollback.main(["not-a-version"])
        assert rc == release_rollback.EXIT_CONFIG_ERROR

    def test_negative_allow_low_downloads_exits_2(self, capsys):
        rc = release_rollback.main(
            ["0.21.0", "--allow-low-downloads", "-1"]
        )
        assert rc == release_rollback.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "must be >= 0" in captured.err

    def test_help_exits_0(self):
        with pytest.raises(SystemExit) as exc:
            release_rollback.main(["--help"])
        assert exc.value.code == 0

    def test_dry_run_via_main(self, monkeypatch, tmp_path):
        captured = {}

        def fake_run_rollback(config):
            captured["config"] = config
            return release_rollback.EXIT_OK

        monkeypatch.setattr(
            release_rollback, "run_rollback", fake_run_rollback
        )
        rc = release_rollback.main(
            [
                "0.21.0",
                "--dry-run",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
                "--allow-low-downloads",
                "5",
                "--allow-data-loss",
            ]
        )
        assert rc == release_rollback.EXIT_OK
        cfg = captured["config"]
        assert cfg.dry_run is True
        assert cfg.allow_low_downloads == 5
        assert cfg.allow_data_loss is True


# ---------------------------------------------------------------------------
# Subprocess smoke
# ---------------------------------------------------------------------------


class TestSubprocessSmoke:
    def test_help_via_subprocess(self):
        if shutil.which("python") is None:
            pytest.skip("python not on PATH")
        result = subprocess.run(
            [
                sys.executable,
                str(REPO_ROOT / "scripts" / "release_rollback.py"),
                "--help",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        assert "release_rollback" in result.stdout
        assert "--allow-low-downloads" in result.stdout
        assert "--allow-data-loss" in result.stdout
        assert "--force-strict-0" in result.stdout
