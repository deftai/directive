"""test_release_upgrade_banner.py -- maintainer-mode upgrade-banner tests (#1413).

Split from tests/cli/test_release.py to keep that file under the
1000-line MUST limit (AGENTS.md). Covers the ``_prepend_upgrade_banner``
helper added to ``scripts/release.py`` (#1413), which leads maintainer-mode
(``deftai/directive``) GitHub release notes with a standard
"Upgrading from an older version?" banner sourced from the editable
``.github/release-notes/upgrade-banner.md`` template.

Coverage:
- Banner IS prepended when ``repo == deftai/directive`` and the template
  exists, joined to the notes by exactly one blank line.
- Banner is NOT prepended for a consumer-mode repo (e.g.
  ``someorg/their-app``), even when a template is present.
- A missing template degrades gracefully (returns notes unchanged, no
  exception); an unreadable / empty template does too.
- CRLF templates are normalised to LF so the banner never injects
  mixed line endings into the release body.
- The real committed template at the repo root is picked up and carries
  the canonical ``deft-install --yes --upgrade --repo-root . --json``
  command.
- Integration: ``run_pipeline`` Step 12 hands banner-led notes to
  ``create_github_release`` for the maintainer repo and unmodified notes
  for a consumer repo.

The banner is GitHub-release-body-only -- it is NEVER written into
CHANGELOG.md.

Refs #1413 (upgrade-guidance banner), #1411 (full upgrade guidance issue),
#74 (release pipeline parent), #716 (default-draft hardening).
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

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


BANNER_TEXT = (
    "## Upgrading from an older version?\n"
    "\n"
    "Run the canonical upgrade command:\n"
    "\n"
    "```bash\n"
    "deft-install --yes --upgrade --repo-root . --json\n"
    "```\n"
)

NOTES = "### Added\n- A user-facing feature (#9999)\n"


def _write_banner(project_root: Path, text: str = BANNER_TEXT) -> Path:
    """Materialise a banner template under <project_root>/.github/release-notes/."""
    banner_path = project_root / release._UPGRADE_BANNER_RELPATH
    banner_path.parent.mkdir(parents=True, exist_ok=True)
    banner_path.write_text(text, encoding="utf-8", newline="")
    return banner_path


# ---------------------------------------------------------------------------
# _prepend_upgrade_banner -- pure helper
# ---------------------------------------------------------------------------


class TestPrependUpgradeBanner:
    """#1413: banner prepend semantics (maintainer-only, graceful)."""

    def test_banner_prepended_for_maintainer_repo(self, tmp_path):
        """repo == deftai/directive + template present -> banner leads notes."""
        _write_banner(tmp_path)
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, tmp_path
        )
        assert out != NOTES
        assert out.startswith("## Upgrading from an older version?")
        # The original notes survive verbatim, after the banner.
        assert out.endswith(NOTES)
        # The canonical command rides through unchanged.
        assert "deft-install --yes --upgrade --repo-root . --json" in out

    def test_banner_joined_by_single_blank_line(self, tmp_path):
        """Banner + notes are separated by exactly one blank line."""
        _write_banner(tmp_path)
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, tmp_path
        )
        # Trailing template whitespace is trimmed, then joined with \n\n.
        assert out == f"{BANNER_TEXT.strip()}\n\n{NOTES}"

    def test_not_prepended_for_consumer_repo(self, tmp_path):
        """Consumer-mode repo -> notes returned unchanged even with a template."""
        _write_banner(tmp_path)
        out = release._prepend_upgrade_banner(
            NOTES, "someorg/their-app", tmp_path
        )
        assert out == NOTES
        assert "Upgrading from an older version?" not in out

    def test_missing_template_degrades_gracefully(self, tmp_path):
        """No template on disk -> notes unchanged, no exception raised."""
        # tmp_path has no .github/release-notes/upgrade-banner.md.
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, tmp_path
        )
        assert out == NOTES

    def test_template_is_a_directory_degrades_gracefully(self, tmp_path):
        """An unreadable template (path is a directory) -> notes unchanged."""
        banner_path = tmp_path / release._UPGRADE_BANNER_RELPATH
        banner_path.mkdir(parents=True, exist_ok=True)  # not a file
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, tmp_path
        )
        assert out == NOTES

    def test_empty_template_degrades_gracefully(self, tmp_path):
        """A whitespace-only template -> notes unchanged (nothing to prepend)."""
        _write_banner(tmp_path, text="   \n\n  \n")
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, tmp_path
        )
        assert out == NOTES

    def test_crlf_template_normalised_to_lf(self, tmp_path):
        """A CRLF-saved template must not inject \\r into the release body."""
        _write_banner(tmp_path, text=BANNER_TEXT.replace("\n", "\r\n"))
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, tmp_path
        )
        assert "\r" not in out
        assert out == f"{BANNER_TEXT.strip()}\n\n{NOTES}"

    def test_real_committed_template_is_picked_up(self):
        """The real repo-root template exists and carries the canonical command."""
        out = release._prepend_upgrade_banner(
            NOTES, release.DEFAULT_REPO, REPO_ROOT
        )
        assert out.startswith("## Upgrading from an older version?")
        assert "deft-install --yes --upgrade --repo-root . --json" in out
        # The full-guidance pointer to #1411 rides through.
        assert "issues/1411" in out


# ---------------------------------------------------------------------------
# Pipeline wiring -- Step 12 hands banner-led notes to create_github_release
# ---------------------------------------------------------------------------


SAMPLE_CHANGELOG = """\
 Changelog

All notable changes to the project.

## [Unreleased]

### Added
- New release automation (#74)

## [0.20.2] - 2026-04-24

### Added
- Prior change

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
"""


@pytest.fixture
def temp_project(tmp_path: Path) -> Path:
    """Synthetic project with a clean git tree + the SAMPLE_CHANGELOG."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "CHANGELOG.md").write_text(SAMPLE_CHANGELOG, encoding="utf-8")
    subprocess.run(
        ["git", "init", "-q", "-b", "master", str(project)], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(project), "config", "user.name", "Tester"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "add", "CHANGELOG.md"], check=True
    )
    subprocess.run(
        ["git", "-C", str(project), "commit", "-q", "-m", "init"], check=True
    )
    return project


def _make_config(project: Path, **overrides):
    defaults = {
        "version": "0.21.0",
        "repo": "deftai/directive",
        "base_branch": "master",
        "project_root": project,
        "dry_run": False,
        "skip_tag": True,
        "skip_release": False,
        # The wiring tests write the banner template into the project tree
        # after the fixture's initial commit, so the tree is intentionally
        # dirty -- these tests exercise Step 12 note assembly, not the
        # Step 1 dirty-tree guard.
        "allow_dirty": True,
        "allow_vbrief_drift": True,
    }
    defaults.update(overrides)
    return release.ReleaseConfig(**defaults)


def _stub_pipeline(monkeypatch):
    """Stub the side-effecting pipeline steps preceding Step 12."""
    monkeypatch.setattr(
        release, "check_tag_available", lambda *_a, **_kw: (True, "stub")
    )
    monkeypatch.setattr(release, "run_ci", lambda *_a, **_kw: (True, "stub"))
    monkeypatch.setattr(
        release, "refresh_roadmap", lambda *_a, **_kw: (True, "stub")
    )
    monkeypatch.setattr(release, "run_build", lambda *_a, **_kw: (True, "stub"))
    monkeypatch.setattr(
        release, "commit_release_artifacts", lambda *_a, **_kw: (True, "stub")
    )
    monkeypatch.setattr(release, "create_tag", lambda *_a, **_kw: (True, "stub"))
    monkeypatch.setattr(
        release, "push_release", lambda *_a, **_kw: (True, "stub")
    )
    monkeypatch.setattr(
        release, "verify_release_draft", lambda *_a, **_kw: (True, "stub")
    )


class TestPipelineBannerWiring:
    def test_maintainer_pipeline_passes_banner_led_notes(
        self, temp_project, monkeypatch
    ):
        """Step 12 for deftai/directive hands create_github_release banner-led notes."""
        _write_banner(temp_project)
        _stub_pipeline(monkeypatch)
        captured: dict = {}

        def fake_create(project_root, version, repo, notes, *, draft=True):
            captured["notes"] = notes
            return True, "created GitHub release v0.21.0 (draft)"

        monkeypatch.setattr(release, "create_github_release", fake_create)
        config = _make_config(temp_project, repo="deftai/directive")
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        notes = captured["notes"]
        assert notes.startswith("## Upgrading from an older version?")
        # The promoted CHANGELOG body still follows the banner.
        assert "New release automation (#74)" in notes
        # And the banner is NOT written back into CHANGELOG.md.
        changelog = (temp_project / "CHANGELOG.md").read_text(encoding="utf-8")
        assert "Upgrading from an older version?" not in changelog

    def test_consumer_pipeline_passes_unmodified_notes(
        self, temp_project, monkeypatch
    ):
        """Step 12 for a consumer repo hands create_github_release plain notes."""
        _write_banner(temp_project)
        _stub_pipeline(monkeypatch)
        captured: dict = {}

        def fake_create(project_root, version, repo, notes, *, draft=True):
            captured["notes"] = notes
            return True, "created GitHub release v0.21.0 (draft)"

        monkeypatch.setattr(release, "create_github_release", fake_create)
        config = _make_config(temp_project, repo="someorg/their-app")
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        notes = captured["notes"]
        assert "Upgrading from an older version?" not in notes
        assert "New release automation (#74)" in notes
