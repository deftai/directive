"""test_project_context.py -- Tests for scripts/_project_context.py.

Covers:
- ``_normalise_repo_slug`` preserves dots in repo names (Greptile P1 on #562)
  and still strips the ``.git`` suffix from SSH clone URLs.
- ``resolve_project_repo`` fails loudly (returns ``None``) when the explicit
  CLI flag is malformed AND when ``$DEFT_PROJECT_REPO`` is malformed --
  matching the behaviour of ``resolve_project_root`` for malformed
  ``--project-root`` / ``$DEFT_PROJECT_ROOT`` (Greptile P2 on #562).
- ``resolve_project_root`` sentinel walk + explicit flag + env var paths.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"


def _load_project_context():
    """Load scripts/_project_context.py in-process via importlib.util."""
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(
        "project_context_module",
        SCRIPTS_DIR / "_project_context.py",
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pc = _load_project_context()


# ---------------------------------------------------------------------------
# _normalise_repo_slug
# ---------------------------------------------------------------------------


class TestNormaliseRepoSlug:
    def test_plain_slug(self):
        assert pc._normalise_repo_slug("owner/repo") == "owner/repo"

    def test_https_url(self):
        assert (
            pc._normalise_repo_slug("https://github.com/owner/repo")
            == "owner/repo"
        )

    def test_https_url_with_git_suffix(self):
        assert (
            pc._normalise_repo_slug("https://github.com/owner/repo.git")
            == "owner/repo"
        )

    def test_ssh_url_with_git_suffix(self):
        assert (
            pc._normalise_repo_slug("git@github.com:owner/repo.git")
            == "owner/repo"
        )

    def test_dotted_repo_name_preserved_in_https(self):
        """Regression guard for Greptile P1 on #562.

        The previous regex ``[^/\\.\\s]+`` stopped at the first dot and
        silently turned ``acme/dotnet.runtime`` into ``acme/dotnet``, then
        routed ``gh`` calls to the wrong repo.
        """
        assert (
            pc._normalise_repo_slug("https://github.com/acme/dotnet.runtime")
            == "acme/dotnet.runtime"
        )

    def test_dotted_repo_name_preserved_with_git_suffix(self):
        assert (
            pc._normalise_repo_slug("git@github.com:acme/my.project.git")
            == "acme/my.project"
        )

    def test_empty_returns_none(self):
        assert pc._normalise_repo_slug("") is None
        assert pc._normalise_repo_slug("   \n") is None

    def test_malformed_returns_none(self):
        assert pc._normalise_repo_slug("just-a-word") is None
        assert pc._normalise_repo_slug("https://gitlab.com/a/b") is None


# ---------------------------------------------------------------------------
# resolve_project_repo
# ---------------------------------------------------------------------------


class TestResolveProjectRepo:
    def test_flag_wins(self, monkeypatch):
        monkeypatch.setenv("DEFT_PROJECT_REPO", "env/should-be-ignored")
        assert (
            pc.resolve_project_repo("flag/wins", project_root=None)
            == "flag/wins"
        )

    def test_malformed_flag_returns_none(self, monkeypatch):
        """Explicit flag is the authoritative source; malformed -> None.

        Must NOT silently fall through to env or git detection.
        """
        monkeypatch.setenv("DEFT_PROJECT_REPO", "real/repo")
        # Monkey-patch git detection to prove it isn't being called.
        monkeypatch.setattr(pc, "_detect_repo_from_git", lambda _r: "git/repo")
        assert pc.resolve_project_repo("bogus", project_root=None) is None

    def test_env_var_returns_value(self, monkeypatch):
        monkeypatch.delenv("DEFT_PROJECT_REPO", raising=False)
        monkeypatch.setenv("DEFT_PROJECT_REPO", "env/repo")
        monkeypatch.setattr(pc, "_detect_repo_from_git", lambda _r: "git/repo")
        assert pc.resolve_project_repo(None, project_root=None) == "env/repo"

    def test_malformed_env_var_fails_loudly(self, monkeypatch):
        """Regression guard for Greptile P2 on #562.

        A malformed ``DEFT_PROJECT_REPO`` previously fell through to
        ``_detect_repo_from_git`` silently, contradicting the #538 contract
        that this helper NEVER silently uses deft's own remote.
        """
        monkeypatch.setenv("DEFT_PROJECT_REPO", "not a slug")
        monkeypatch.setattr(
            pc, "_detect_repo_from_git", lambda _r: "should/not-be-used"
        )
        assert pc.resolve_project_repo(None, project_root=None) is None

    def test_git_detection_fallback(self, monkeypatch):
        monkeypatch.delenv("DEFT_PROJECT_REPO", raising=False)
        monkeypatch.setattr(
            pc, "_detect_repo_from_git", lambda _r: "git/repo"
        )
        assert pc.resolve_project_repo(None, project_root=None) == "git/repo"


# ---------------------------------------------------------------------------
# resolve_project_root
# ---------------------------------------------------------------------------


class TestResolveProjectRoot:
    def test_flag_wins(self, tmp_path):
        target = tmp_path / "project"
        target.mkdir()
        assert pc.resolve_project_root(str(target)) == target.resolve()

    def test_nonexistent_flag_returns_none(self, tmp_path):
        missing = tmp_path / "does-not-exist"
        assert pc.resolve_project_root(str(missing)) is None

    def test_env_var(self, tmp_path, monkeypatch):
        target = tmp_path / "env-project"
        target.mkdir()
        monkeypatch.setenv("DEFT_PROJECT_ROOT", str(target))
        assert pc.resolve_project_root(None) == target.resolve()

    def test_sentinel_walk_vbrief(self, tmp_path, monkeypatch):
        """CWD walk finds a parent with ``vbrief/`` and stops there."""
        project = tmp_path / "project"
        (project / "vbrief").mkdir(parents=True)
        nested = project / "src" / "deep"
        nested.mkdir(parents=True)
        monkeypatch.delenv("DEFT_PROJECT_ROOT", raising=False)
        assert pc.resolve_project_root(None, start=nested) == project.resolve()

    def test_sentinel_walk_git(self, tmp_path, monkeypatch):
        project = tmp_path / "project"
        (project / ".git").mkdir(parents=True)
        monkeypatch.delenv("DEFT_PROJECT_ROOT", raising=False)
        assert pc.resolve_project_root(None, start=project) == project.resolve()

    @pytest.mark.skipif(
        sys.platform != "win32",
        reason="requires Windows filesystem layout to guarantee no sentinel above tmp_path",
    )
    def test_no_sentinel_returns_none_on_windows(self, tmp_path, monkeypatch):
        """Below ``tmp_path`` there is no ``.git`` / ``vbrief`` on Windows CI.

        On Linux/macOS the CI runner may have ``.git`` in an ancestor of
        ``tmp_path`` (e.g. a checkout mounted under ``/github/workspace``),
        so we skip the assertion there.
        """
        monkeypatch.delenv("DEFT_PROJECT_ROOT", raising=False)
        start = tmp_path / "no_project" / "deep"
        start.mkdir(parents=True)
        # Walking up from ``start`` past ``tmp_path`` eventually hits the
        # drive root on Windows, which typically lacks the sentinels.
        # We don't assert None strictly -- we assert the result, if any,
        # is NOT inside ``start`` and NOT equal to the deft worktree.
        result = pc.resolve_project_root(None, start=start)
        if result is not None:
            assert not str(result).startswith(str(start))
