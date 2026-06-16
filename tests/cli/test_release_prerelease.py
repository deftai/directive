"""test_release_prerelease.py -- #425 pre-release tag flagging tests.

Split from tests/cli/test_release.py to keep that file under the
1000-line MUST limit (AGENTS.md). Covers the #425 change that flags
SemVer pre-release tags (``-rc.N`` / ``-beta.N`` / ``-alpha.N``) as
GitHub pre-releases automatically so RC cuts no longer require a manual
``gh release edit --prerelease`` after the workflow completes.

Coverage:
- ``is_prerelease_tag`` returns True for ``-rc`` / ``-alpha`` / ``-beta``
  tags (with and without a leading ``v``) and False for stable tags.
- ``create_github_release`` appends ``--prerelease`` to the gh argv when
  ``prerelease=True`` and omits it otherwise; the prerelease state is
  surfaced in the operator-readable reason string.

Refs #425, #716, #74.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "release", scripts_dir / "release.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release"] = module
    spec.loader.exec_module(module)
    return module


release = _load_module()


# ---------------------------------------------------------------------------
# is_prerelease_tag -- pure tag-based decision (#425)
# ---------------------------------------------------------------------------


class TestIsPrereleaseTag:
    @pytest.mark.parametrize(
        "version",
        [
            "v0.20.0-rc.1",
            "0.20.0-rc.1",
            "v1.0.0-alpha.3",
            "1.0.0-alpha.3",
            "v0.20.0-beta.2",
            "0.20.0-beta.7",
        ],
    )
    def test_prerelease_tags_return_true(self, version: str):
        assert release.is_prerelease_tag(version) is True

    @pytest.mark.parametrize(
        "version",
        [
            "v0.20.0",
            "0.20.0",
            "v1.0.0",
            "10.20.30",
        ],
    )
    def test_stable_tags_return_false(self, version: str):
        assert release.is_prerelease_tag(version) is False

    def test_leading_v_is_tolerated(self):
        # The leading ``v`` itself must not be treated as a pre-release
        # marker -- only a ``-`` after the core version counts.
        assert release.is_prerelease_tag("v0.20.0") is False
        assert release.is_prerelease_tag("v0.20.0-rc.1") is True


# ---------------------------------------------------------------------------
# create_github_release -- --prerelease flag plumbing (#425)
# ---------------------------------------------------------------------------


class TestCreateGithubReleasePrerelease:
    def test_prerelease_true_appends_flag(self, monkeypatch, tmp_path):
        captured = {}

        monkeypatch.setattr(release.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.create_github_release(
            tmp_path, "0.20.0-rc.1", "deftai/directive", "", prerelease=True
        )
        assert ok is True
        assert "--prerelease" in captured["cmd"], (
            "#425: gh release create MUST pass --prerelease when "
            f"prerelease=True; observed argv: {captured['cmd']}"
        )
        assert "prerelease" in reason

    def test_prerelease_false_omits_flag(self, monkeypatch, tmp_path):
        captured = {}

        monkeypatch.setattr(release.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.create_github_release(
            tmp_path, "0.20.0", "deftai/directive", "", prerelease=False
        )
        assert ok is True
        assert "--prerelease" not in captured["cmd"], (
            "--prerelease MUST NOT appear in argv when prerelease=False; "
            f"observed: {captured['cmd']}"
        )
        assert "prerelease" not in reason

    def test_default_omits_prerelease_flag(self, monkeypatch, tmp_path):
        # The default (no prerelease kwarg) preserves pre-#425 behaviour:
        # stable releases are never flagged pre-release.
        captured = {}

        monkeypatch.setattr(release.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, _reason = release.create_github_release(
            tmp_path, "0.20.0", "deftai/directive", ""
        )
        assert ok is True
        assert "--prerelease" not in captured["cmd"]

    def test_draft_and_prerelease_both_appear(self, monkeypatch, tmp_path):
        captured = {}

        monkeypatch.setattr(release.shutil, "which", lambda _: "/usr/bin/gh")

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        ok, reason = release.create_github_release(
            tmp_path,
            "0.20.0-rc.1",
            "deftai/directive",
            "",
            draft=True,
            prerelease=True,
        )
        assert ok is True
        assert "--draft" in captured["cmd"]
        assert "--prerelease" in captured["cmd"]
        assert "(draft, prerelease)" in reason
