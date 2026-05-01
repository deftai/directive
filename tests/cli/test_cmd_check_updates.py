"""tests/cli/test_cmd_check_updates.py -- Tests for #801 cmd_check_updates.

Covers:
- DEFT_NO_NETWORK=1 short-circuits before any subprocess call (SKIPPED, exit 0)
- BEHIND when remote tag is higher than VERSION (exit 1, "BEHIND upstream=...")
- OK when remote tag matches VERSION (exit 0, "OK upstream=...")
- BEHIND with multiple tags picks the highest semver
- NO-UPSTREAM when origin lookup fails (exit 0)
- ERROR on subprocess timeout (exit 0, "ERROR ... error=timeout")
- NO-TAGS when ls-remote returns no semver tags (exit 0)
- Malformed tags are skipped (parser returns None, no crash)
- --json emits structured payload with status / current / remote / upstream_url
- DEFT_REMOTE_PROBE_TIMEOUT env var is honored

Story: #801 (periodic-remote-version-probe)
"""

from __future__ import annotations

import json
import subprocess

import pytest

# ---------------------------------------------------------------------------
# Helpers: stub subprocess.run for the two distinct calls cmd_check_updates
# makes against `git`. The first is `git remote get-url origin` (resolving the
# upstream URL); the second is `git ls-remote --tags --refs <upstream>`.
# ---------------------------------------------------------------------------


class _CompletedMock:
    """Stand-in for subprocess.CompletedProcess that satisfies the probe."""

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _make_subprocess_run(remote_url: str | None, tag_lines: list[str] | None,
                          timeout_on_lsremote: bool = False,
                          os_error_on_lsremote: bool = False):
    """Return a fake subprocess.run that handles both probe calls.

    ``remote_url`` -- value to return for `git remote get-url origin`; None
                       to simulate a non-zero exit (no remote).
    ``tag_lines`` -- pre-formatted ls-remote stdout lines (each like
                       ``<sha>\\trefs/tags/<tag>``); None to simulate
                       non-zero exit (the helper returns []).
    ``timeout_on_lsremote`` / ``os_error_on_lsremote`` -- raise the failure
                       mode the corresponding branch of ``_run_remote_probe``
                       categorises as ``error``.
    """

    def _fake_run(cmd, *args, **kwargs):  # noqa: ANN001
        if "remote" in cmd and "get-url" in cmd:
            if remote_url is None:
                return _CompletedMock(returncode=128, stdout="", stderr="no remote")
            return _CompletedMock(returncode=0, stdout=remote_url + "\n")
        if "ls-remote" in cmd:
            if timeout_on_lsremote:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout", 5))
            if os_error_on_lsremote:
                raise FileNotFoundError("git binary missing")
            if tag_lines is None:
                return _CompletedMock(returncode=128, stdout="", stderr="repo not found")
            return _CompletedMock(returncode=0, stdout="\n".join(tag_lines) + "\n")
        # Pass-through for any other invocation (e.g. _resolve_version's
        # `git describe`); the test environment's real git handles those.
        return _CompletedMock(returncode=128, stdout="", stderr="unhandled command")

    return _fake_run


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


class TestDeftNoNetwork:
    """DEFT_NO_NETWORK=1 short-circuits before any subprocess call."""

    def test_no_network_returns_skipped_exit_zero(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setenv("DEFT_NO_NETWORK", "1")
        # Sentinel: if subprocess.run is invoked anything at all, fail loudly.
        called = {"count": 0}

        def _forbidden(*args, **kwargs):
            called["count"] += 1
            raise AssertionError("subprocess.run was called despite DEFT_NO_NETWORK=1")

        monkeypatch.setattr(deft_run_module.subprocess, "run", _forbidden)

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "SKIPPED" in result.stdout
        assert "DEFT_NO_NETWORK" in result.stdout
        assert called["count"] == 0


class TestOkAndBehind:
    """OK / BEHIND status differentiation and exit codes."""

    def test_ok_when_remote_matches_version(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        tag = "v" + deft_run_module.VERSION
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=[f"abc123\trefs/tags/{tag}"],
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "OK upstream=" in result.stdout
        assert tag in result.stdout

    def test_behind_when_remote_higher_than_version(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        # Construct a remote tag guaranteed to be higher than VERSION.
        # _parse_semver_tag treats a missing pre-release as a stable release
        # (sort key axis 1), so bumping major by 100 is always greater.
        major = int(deft_run_module.VERSION.split(".")[0]) + 100
        higher_tag = f"v{major}.0.0"
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=[f"abc123\trefs/tags/{higher_tag}"],
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 1
        assert "BEHIND" in result.stdout
        assert f"upstream={higher_tag}" in result.stdout
        assert f"current=v{deft_run_module.VERSION}" in result.stdout
        assert "commits-behind=unknown" in result.stdout

    def test_behind_picks_highest_semver_among_many(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        major = int(deft_run_module.VERSION.split(".")[0]) + 100
        # Mix of tags including an older minor and a higher minor; the
        # highest semver should win regardless of input ordering.
        tag_lines = [
            f"sha1\trefs/tags/v{major}.0.0",
            f"sha2\trefs/tags/v{major}.2.0",
            f"sha3\trefs/tags/v{major}.1.5",
            f"sha4\trefs/tags/v{major}.2.0-rc.1",  # pre-release loses to stable
            "sha5\trefs/tags/junk-non-semver",  # malformed, skipped
        ]
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=tag_lines,
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 1
        assert f"upstream=v{major}.2.0" in result.stdout
        # The pre-release variant must NOT win against a stable of the same
        # triple.
        assert f"upstream=v{major}.2.0-rc.1" not in result.stdout


class TestEdgeCases:
    """No upstream / timeout / no-tags / detached HEAD."""

    def test_no_upstream_when_origin_lookup_fails(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(remote_url=None, tag_lines=None),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "NO-UPSTREAM" in result.stdout

    def test_timeout_returns_error_status(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=None,
                timeout_on_lsremote=True,
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "ERROR" in result.stdout
        assert "error=timeout" in result.stdout

    def test_no_tags_returned(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=[],
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "NO-TAGS" in result.stdout

    def test_malformed_tags_only_returns_no_tags(
        self, run_command, deft_run_module, monkeypatch
    ):
        """An upstream that returns only junk/non-semver tags is treated as no-tags."""
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=[
                    "sha1\trefs/tags/junk-tag",
                    "sha2\trefs/tags/release-2026Q1",
                ],
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "NO-TAGS" in result.stdout

    def test_git_missing_returns_error(
        self, run_command, deft_run_module, monkeypatch
    ):
        """FileNotFoundError (git binary absent) surfaces as ERROR, not crash."""
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=None,
                os_error_on_lsremote=True,
            ),
        )

        result = run_command("cmd_check_updates", [])

        assert result.return_code == 0
        assert "ERROR" in result.stdout


class TestJsonMode:
    """--json emits a structured payload covering all status axes."""

    def test_json_mode_skipped(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.setenv("DEFT_NO_NETWORK", "1")
        result = run_command("cmd_check_updates", ["--json"])

        assert result.return_code == 0
        payload = json.loads(result.stdout.strip())
        assert payload["status"] == "skipped"
        assert payload["current"] == deft_run_module.VERSION

    def test_json_mode_behind_payload_shape(
        self, run_command, deft_run_module, monkeypatch
    ):
        monkeypatch.delenv("DEFT_NO_NETWORK", raising=False)
        major = int(deft_run_module.VERSION.split(".")[0]) + 100
        higher_tag = f"v{major}.0.0"
        monkeypatch.setattr(
            deft_run_module.subprocess,
            "run",
            _make_subprocess_run(
                remote_url="https://github.com/deftai/directive.git",
                tag_lines=[f"abc123\trefs/tags/{higher_tag}"],
            ),
        )

        result = run_command("cmd_check_updates", ["--json"])

        assert result.return_code == 1
        payload = json.loads(result.stdout.strip())
        assert payload["status"] == "behind"
        assert payload["remote"] == higher_tag
        assert payload["current"] == deft_run_module.VERSION
        assert payload["upstream_url"] == "https://github.com/deftai/directive.git"


class TestEnvVarOverrides:
    """DEFT_REMOTE_PROBE_TIMEOUT is parsed and propagated to subprocess.run."""

    def test_timeout_env_var_overrides_default(
        self, deft_run_module, monkeypatch
    ):
        monkeypatch.setenv("DEFT_REMOTE_PROBE_TIMEOUT", "12.5")
        assert deft_run_module._resolve_probe_timeout() == 12.5

    def test_invalid_timeout_falls_back_to_default(
        self, deft_run_module, monkeypatch
    ):
        monkeypatch.setenv("DEFT_REMOTE_PROBE_TIMEOUT", "not-a-number")
        assert deft_run_module._resolve_probe_timeout() == 5.0

    def test_negative_timeout_falls_back_to_default(
        self, deft_run_module, monkeypatch
    ):
        monkeypatch.setenv("DEFT_REMOTE_PROBE_TIMEOUT", "-3")
        assert deft_run_module._resolve_probe_timeout() == 5.0


class TestSemverParser:
    """_parse_semver_tag and _max_semver_tag pure-function coverage."""

    @pytest.mark.parametrize(
        "tag,expected_first_three",
        [
            ("v1.2.3", (1, 2, 3)),
            ("1.2.3", (1, 2, 3)),
            ("v0.23.0", (0, 23, 0)),
            ("v0.23.0-rc.1", (0, 23, 0)),
        ],
    )
    def test_parse_valid_tags(self, deft_run_module, tag, expected_first_three):
        parsed = deft_run_module._parse_semver_tag(tag)
        assert parsed is not None
        assert parsed[:3] == expected_first_three

    @pytest.mark.parametrize(
        "tag",
        ["", "v", "junk", "1.2", "v1.2.3.4", "release-2026Q1", "1.2.x"],
    )
    def test_parse_invalid_tags_returns_none(self, deft_run_module, tag):
        assert deft_run_module._parse_semver_tag(tag) is None

    def test_max_semver_skips_malformed(self, deft_run_module):
        result = deft_run_module._max_semver_tag(
            ["junk", "v1.0.0", "v2.5.0", "release-2026", "v2.4.9"]
        )
        assert result == "v2.5.0"

    def test_max_semver_empty_list(self, deft_run_module):
        assert deft_run_module._max_semver_tag([]) is None

    def test_stable_outranks_prerelease_same_triple(self, deft_run_module):
        result = deft_run_module._max_semver_tag(["v1.2.3-rc.1", "v1.2.3"])
        assert result == "v1.2.3"


class TestUpgradeGateSkipsCheckUpdates:
    """The gate does not recursively probe when the user runs check-updates."""

    def test_check_updates_in_skip_set(self, deft_run_module):
        assert "check-updates" in deft_run_module._UPGRADE_GATE_SKIP_COMMANDS
