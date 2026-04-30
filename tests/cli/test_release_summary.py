"""test_release_summary.py -- release CHANGELOG `--summary` blockquote tests.

Split from tests/cli/test_release.py to keep that file under the
1000-line MUST limit (AGENTS.md). Covers the optional ``--summary TEXT``
flag added to ``scripts/release.py`` per the release-narrative-gap scope
vBRIEF (``vbrief/proposed/2026-04-29-release-summary-blockquote.vbrief.json``).

Coverage:
- ``promote_changelog`` accepts ``summary=...`` and injects a Markdown
  blockquote between the new ``## [<version>] - <date>`` heading and the
  first sub-section.
- ``summary=None`` / ``summary=""`` preserves byte-for-byte
  pre-existing behaviour (regression guard).
- Inline Markdown (``**bold**``, ``[link](url)``) is preserved verbatim.
- Embedded newlines raise ``ValueError`` (single-line slot).
- ``--summary`` argparse flag wires through to ``ReleaseConfig.summary``
  via ``main(...)``.
- ``run_pipeline`` Step 4 dry-run preview reflects the supplied summary
  (truncated to ~60 chars) so operators can validate the wording during
  Phase 2 before any file is written.

Refs release-narrative-gap, #74 (release pipeline parent), #716 (Phase 8
Slack template surface this feature feeds), #727 (orchestrator
role-separation -- the canonical poller-prompt template this PR's review
cycle uses).
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


# Mirror the SAMPLE_CHANGELOG fixture from tests/cli/test_release.py so
# the assertions are anchored against the same shape the existing
# TestPromoteChangelog battery exercises (regression coupling).
SAMPLE_CHANGELOG = """\
 Changelog

All notable changes to the project.

## [Unreleased]

### Added
- New release automation (#74)

### Changed
- Refactored module X

### Fixed
- Bug Y

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
        "skip_release": True,
        "allow_dirty": False,
    }
    defaults.update(overrides)
    return release.ReleaseConfig(**defaults)


# ---------------------------------------------------------------------------
# promote_changelog -- summary kwarg
# ---------------------------------------------------------------------------


class TestPromoteChangelogSummary:
    """release-narrative-gap: --summary blockquote injection."""

    def test_promote_changelog_with_summary(self):
        """Promoted section contains `\\n\\n> Test summary\\n` between heading and ### Added."""
        out = release.promote_changelog(
            SAMPLE_CHANGELOG,
            "0.21.0",
            "deftai/directive",
            "2026-04-28",
            summary="Test summary",
        )
        # Sanity: heading exists.
        assert "## [0.21.0] - 2026-04-28" in out
        # The blockquote MUST appear between the new version heading and
        # the first ### sub-section, sandwiched by blank lines.
        version_idx = out.index("## [0.21.0] - 2026-04-28")
        added_idx = out.index("### Added", version_idx)
        section = out[version_idx:added_idx]
        # Heading line, blank line, blockquote line, blank line, then ### Added.
        # Anchor on the canonical bytes per the scope vBRIEF Test narrative.
        assert "\n\n> Test summary\n" in section, (
            f"expected '\\n\\n> Test summary\\n' between heading and ### Added; "
            f"observed section: {section!r}"
        )

    def test_promote_changelog_without_summary(self):
        """Regression: backward-compat unchanged when summary omitted.

        The promoted section MUST NOT contain a `> ` blockquote line --
        the pre-existing implementation's exact bytes are preserved.
        ``_UNRELEASED_RE`` consumes one of the two ``\\n`` following
        ``## [Unreleased]``, so the existing behaviour places the new
        version heading immediately above ``### Added`` separated by a
        single ``\\n`` (NOT a blank line). This is admittedly less
        Markdown-pretty than a blank-line separation but it is the
        long-standing shape; this PR MUST NOT alter it for the
        no-summary path. A future cosmetic fix can land separately.
        """
        out = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28"
        )
        version_idx = out.index("## [0.21.0] - 2026-04-28")
        # Anchor on the EXACT prior-art bytes -- single newline between
        # heading and the first sub-section.
        suffix = out[version_idx:version_idx + len("## [0.21.0] - 2026-04-28") + 20]
        assert suffix.startswith("## [0.21.0] - 2026-04-28\n### Added"), (
            f"backward-compat regression: expected '## [0.21.0] - 2026-04-28\\n### Added' "
            f"prefix (matches pre-existing behaviour); observed: {suffix!r}"
        )
        # No `> ` blockquote line anywhere in the new version section.
        added_idx = out.index("### Added", version_idx)
        section = out[version_idx:added_idx]
        assert "\n> " not in section, (
            f"summary=None must NOT inject a blockquote; observed: {section!r}"
        )

    def test_promote_changelog_summary_with_markdown(self):
        """Inline Markdown (`**bold**` / `[link](url)`) is preserved verbatim."""
        summary = "Adds **dark mode** and [CSV export](https://example.com/csv)."
        out = release.promote_changelog(
            SAMPLE_CHANGELOG,
            "0.21.0",
            "deftai/directive",
            "2026-04-28",
            summary=summary,
        )
        # The Markdown is preserved without escaping.
        assert f"> {summary}" in out
        assert "**dark mode**" in out
        assert "[CSV export](https://example.com/csv)" in out

    def test_promote_changelog_summary_empty_string(self):
        """summary='' behaves identically to summary=None (no blockquote)."""
        with_none = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28", summary=None
        )
        with_empty = release.promote_changelog(
            SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28", summary=""
        )
        assert with_empty == with_none, (
            "summary='' must produce byte-identical output to summary=None"
        )
        # And neither contains a blockquote line.
        assert "\n> " not in with_empty.split("## [0.21.0]", 1)[1].split("## [0.20.2]", 1)[0]

    def test_promote_changelog_summary_with_newline(self):
        """Embedded newline in summary raises ValueError (single-line slot)."""
        with pytest.raises(ValueError) as exc:
            release.promote_changelog(
                SAMPLE_CHANGELOG,
                "0.21.0",
                "deftai/directive",
                "2026-04-28",
                summary="line one\nline two",
            )
        assert "single-line" in str(exc.value)
        # Carriage returns are also rejected (paranoid Windows-paste guard).
        with pytest.raises(ValueError):
            release.promote_changelog(
                SAMPLE_CHANGELOG,
                "0.21.0",
                "deftai/directive",
                "2026-04-28",
                summary="line one\r\nline two",
            )

    def test_promote_changelog_summary_with_backslash_group_reference(self):
        """P1 (#730 Greptile): summary containing ``\\1`` MUST NOT raise re.error.

        Python's ``re`` module interprets ``\\1``-``\\9`` and
        ``\\g<name>`` in the ``repl`` argument to ``re.sub``/``re.subn``
        as group backreferences. Since ``_UNRELEASED_RE`` has no capture
        groups, a literal-string repl containing ``\\1`` would raise
        ``re.error: invalid group reference 1`` -- an uncaught exception
        that bypasses the ValueError newline guard. The lambda repl in
        ``promote_changelog`` returns the value verbatim and skips all
        backslash interpretation. This test pins the fix.
        """
        # Three high-risk patterns that all trigger re.error under a
        # literal-string repl:
        # 1. Bare \1 -- group 1 backreference.
        # 2. \g<name> -- named group reference.
        # 3. \9 -- bare numeric backreference.
        for risky in (
            "See \\1 for details",
            "See \\g<title> for details",
            "See \\9 for details",
        ):
            out = release.promote_changelog(
                SAMPLE_CHANGELOG,
                "0.21.0",
                "deftai/directive",
                "2026-04-28",
                summary=risky,
            )
            # The summary is preserved verbatim in the output (proves the
            # backslash sequence was NOT interpreted as a group reference).
            assert f"> {risky}" in out, (
                f"P1 regression: backslash-bearing summary {risky!r} did not "
                f"survive verbatim in the promoted CHANGELOG body"
            )


# ---------------------------------------------------------------------------
# argparse / main wiring
# ---------------------------------------------------------------------------


class TestSummaryArgparse:
    """--summary argparse flag wiring through to ReleaseConfig.summary."""

    def test_main_summary_argparse(self, monkeypatch, tmp_path):
        """main([..., '--summary', 'Test']) lands summary='Test' in ReleaseConfig."""
        captured = {}

        def fake_run_pipeline(config):
            captured["summary"] = config.summary
            return release.EXIT_OK

        monkeypatch.setattr(release, "run_pipeline", fake_run_pipeline)
        rc = release.main(
            [
                "0.21.0",
                "--summary",
                "Test summary text",
                "--skip-tag",
                "--skip-release",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release.EXIT_OK
        assert captured["summary"] == "Test summary text"

    def test_default_summary_is_none(self, monkeypatch, tmp_path):
        """Without --summary, ReleaseConfig.summary defaults to None."""
        captured = {}

        def fake_run_pipeline(config):
            captured["summary"] = config.summary
            return release.EXIT_OK

        monkeypatch.setattr(release, "run_pipeline", fake_run_pipeline)
        rc = release.main(
            [
                "0.21.0",
                "--skip-tag",
                "--skip-release",
                "--repo",
                "deftai/directive",
                "--project-root",
                str(tmp_path),
            ]
        )
        assert rc == release.EXIT_OK
        assert captured["summary"] is None


# ---------------------------------------------------------------------------
# Pipeline -- Step 4 summary thread-through (dry-run preview)
# ---------------------------------------------------------------------------


class TestPipelineSummaryThreaded:
    """Step 4 dry-run preview reflects the supplied summary."""

    def test_pipeline_summary_threaded(self, temp_project, capsys):
        """Dry-run Step 4 line surfaces the summary so Phase 2 validation works.

        Operator validation requires the dry-run to actually print the
        wording (truncated to ~60 chars) -- the deterministic preview
        path is the only place an operator can catch a typo before the
        production cut writes the file.
        """
        config = _make_config(
            temp_project,
            dry_run=True,
            skip_tag=True,
            skip_release=True,
            summary="Lands the new --summary blockquote feature for the release pipeline.",
        )
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        captured = capsys.readouterr()
        # Step 4 dry-run line MUST surface a `summary:` token + the
        # supplied wording (truncated). The truncation is lenient -- we
        # assert the leading bytes are present.
        # CHANGELOG promotion is Step 5 after the #734 lifecycle gate
        # was inserted at Step 3 (was Step 4 pre-#734).
        step5_line = next(
            (line for line in captured.err.splitlines() if "[5/12]" in line),
            "",
        )
        assert step5_line, "CHANGELOG step line missing from dry-run output"
        assert "summary:" in step5_line.lower(), (
            "CHANGELOG step dry-run line MUST surface the summary state; "
            f"observed: {step5_line!r}"
        )
        # The leading 30 chars of the wording must be present in the line
        # so operators can verify they didn't mis-type the canonical narrative.
        assert "Lands the new --summary blockquote" in step5_line, (
            "CHANGELOG step dry-run line MUST surface the supplied wording; "
            f"observed: {step5_line!r}"
        )

    def test_pipeline_no_summary_threaded(self, temp_project, capsys):
        """Without summary, CHANGELOG dry-run line announces 'no summary'."""
        config = _make_config(
            temp_project, dry_run=True, skip_tag=True, skip_release=True
        )
        rc = release.run_pipeline(config)
        assert rc == release.EXIT_OK
        captured = capsys.readouterr()
        step5_line = next(
            (line for line in captured.err.splitlines() if "[5/12]" in line),
            "",
        )
        assert step5_line
        assert "no summary" in step5_line.lower(), (
            "CHANGELOG step dry-run line MUST announce missing summary; "
            f"observed: {step5_line!r}"
        )
