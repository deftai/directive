"""test_issue_ingest_direct.py -- Direct-import tests for scripts/issue_ingest.py.

Complements tests/cli/test_issue_ingest.py (subprocess-style CLI coverage) by
exercising internal helper functions and error branches that subprocess tests
cannot easily reach (subprocess failures, timeouts, argparse edge cases, bulk
output formatting, repo URL resolution).

These tests raise coverage of scripts/issue_ingest.py from ~76% toward ~95% so
the TOTAL coverage gate (>=85% per pyproject.toml) has headroom for the RC3
Wave 1 PRs (#507-#510).

Part of RC3 prep chore referenced by #506.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_issue_ingest():
    """Load scripts/issue_ingest.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "issue_ingest_direct",
        scripts_dir / "issue_ingest.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issue_ingest = _load_issue_ingest()


# ---------------------------------------------------------------------------
# _resolve_repo_url
# ---------------------------------------------------------------------------


class TestResolveRepoUrl:
    """Exercise all branches of _resolve_repo_url."""

    def test_empty_repo_returns_empty(self):
        assert issue_ingest._resolve_repo_url("") == ""

    def test_http_url_returned_stripped(self):
        assert (
            issue_ingest._resolve_repo_url("https://github.com/owner/repo/")
            == "https://github.com/owner/repo"
        )

    def test_http_url_without_trailing_slash_preserved(self):
        assert (
            issue_ingest._resolve_repo_url("http://example.com/path")
            == "http://example.com/path"
        )

    def test_owner_repo_pair_becomes_https(self):
        assert (
            issue_ingest._resolve_repo_url("octo/cat")
            == "https://github.com/octo/cat"
        )

    def test_malformed_repo_returns_empty(self):
        """Triple slash breaks OWNER/REPO regex and is not an http URL."""
        assert issue_ingest._resolve_repo_url("a/b/c") == ""

    def test_bare_string_returns_empty(self):
        assert issue_ingest._resolve_repo_url("just-a-word") == ""


# ---------------------------------------------------------------------------
# _fetch_single_issue error branches
# ---------------------------------------------------------------------------


class TestFetchSingleIssue:
    """Exercise subprocess failure modes not covered by the CLI tests."""

    def test_gh_not_found_returns_none(self, monkeypatch, capsys):
        def fake_run(*_args, **_kwargs):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(issue_ingest.subprocess, "run", fake_run)
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        err = capsys.readouterr().err
        assert "gh CLI not found" in err

    def test_gh_timeout_returns_none(self, monkeypatch, capsys):
        def fake_run(*_args, **_kwargs):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=30)

        monkeypatch.setattr(issue_ingest.subprocess, "run", fake_run)
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        assert "timed out" in capsys.readouterr().err

    def test_gh_nonzero_returncode_returns_none(self, monkeypatch, capsys):
        class FakeResult:
            returncode = 1
            stdout = ""
            stderr = "HTTP 404"

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        assert "gh CLI failed" in capsys.readouterr().err

    def test_invalid_json_returns_none(self, monkeypatch, capsys):
        class FakeResult:
            returncode = 0
            stdout = "{not json"
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        assert issue_ingest._fetch_single_issue("o/r", 1) is None
        assert "failed to parse" in capsys.readouterr().err

    def test_html_url_normalised_to_url(self, monkeypatch):
        """gh api returns ``html_url``; _fetch_single_issue should copy it to url."""
        payload = {"number": 5, "title": "X", "html_url": "https://x/1"}

        class FakeResult:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        issue = issue_ingest._fetch_single_issue("o/r", 5)
        assert issue is not None
        assert issue["url"] == "https://x/1"

    def test_gh_api_shape_prefers_html_url_over_rest_api_url(self, monkeypatch):
        """#639 follow-up (Greptile P1): real ``gh api`` responses always
        carry BOTH ``url`` (REST API URL) AND ``html_url`` (browser URL).
        ``_fetch_single_issue`` MUST prefer ``html_url`` so the canonical
        ``uri`` field ends up as the browser URL required by
        ``conventions/references.md``.
        """
        payload = {
            "number": 7,
            "title": "Y",
            "url": "https://api.github.com/repos/o/r/issues/7",
            "html_url": "https://github.com/o/r/issues/7",
        }

        class FakeResult:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        issue = issue_ingest._fetch_single_issue("o/r", 7)
        assert issue is not None
        # Browser URL wins over REST API URL.
        assert issue["url"] == "https://github.com/o/r/issues/7"

    def test_empty_html_url_does_not_clobber_url(self, monkeypatch):
        """Defensive: an explicitly-empty ``html_url`` must not overwrite an
        otherwise-usable ``url`` field.
        """
        payload = {
            "number": 8,
            "title": "Z",
            "url": "https://github.com/o/r/issues/8",
            "html_url": "",
        }

        class FakeResult:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            issue_ingest.subprocess, "run", lambda *a, **k: FakeResult()
        )
        issue = issue_ingest._fetch_single_issue("o/r", 8)
        assert issue is not None
        assert issue["url"] == "https://github.com/o/r/issues/8"


# ---------------------------------------------------------------------------
# main() argparse + control-flow branches
# ---------------------------------------------------------------------------


class TestMainCli:
    def test_missing_args_errors(self, tmp_path):
        """Neither issue number nor --all -> argparse error (SystemExit 2)."""
        with pytest.raises(SystemExit) as excinfo:
            issue_ingest.main(["--vbrief-dir", str(tmp_path), "--repo", "o/r"])
        assert excinfo.value.code == 2

    def test_conflicting_args_errors(self, tmp_path):
        """Both issue number and --all -> argparse error."""
        with pytest.raises(SystemExit) as excinfo:
            issue_ingest.main(
                ["5", "--all", "--vbrief-dir", str(tmp_path), "--repo", "o/r"]
            )
        assert excinfo.value.code == 2

    def test_vbrief_dir_created_when_missing(self, tmp_path, monkeypatch):
        """main() creates the vbrief-dir if it does not exist."""
        vbrief_dir = tmp_path / "new_vbrief"
        assert not vbrief_dir.exists()

        monkeypatch.setattr(
            issue_ingest, "_fetch_single_issue",
            lambda _repo, _n, *, cwd=None: {
                "number": 1, "title": "T", "url": "",
            },
        )
        rc = issue_ingest.main(
            ["1", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r"]
        )
        assert rc == 0
        assert vbrief_dir.is_dir()

    def test_no_repo_detected_returns_2(self, tmp_path, monkeypatch, capsys):
        """detect_repo + resolve_project_repo both fail -> exit 2."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        # Stub out BOTH detection paths. resolve_project_repo is called
        # first (#538); without this stub the test running inside the
        # deft worktree would return ``deftai/directive`` and we would
        # never reach the detect_repo fallback.
        monkeypatch.setattr(
            issue_ingest, "resolve_project_repo",
            lambda *_a, **_k: None,
        )
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "")
        rc = issue_ingest.main(["1", "--vbrief-dir", str(vbrief_dir)])
        assert rc == 2
        assert "could not detect repo" in capsys.readouterr().err

    def test_single_issue_success_returns_0(self, tmp_path, monkeypatch, capsys):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        monkeypatch.setattr(
            issue_ingest, "_fetch_single_issue",
            lambda _repo, _n, *, cwd=None: {
                "number": 42, "title": "Do thing",
                "url": "https://github.com/o/r/issues/42",
                "labels": [{"name": "bug"}],
            },
        )
        rc = issue_ingest.main(
            ["42", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r"]
        )
        assert rc == 0
        out = capsys.readouterr().out
        assert "CREATED" in out
        assert list(vbrief_dir.rglob("*.vbrief.json"))

    def test_bulk_mode_prints_summary(self, tmp_path, monkeypatch, capsys):
        """--all branch prints summary + per-entry lines for all three buckets."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        # Pre-seed one duplicate
        (vbrief_dir / "pending").mkdir()
        (vbrief_dir / "pending" / "2026-04-01-2-exists.vbrief.json").write_text(
            json.dumps({
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Exists",
                    "status": "pending",
                    "items": [],
                    "references": [{"type": "github-issue", "id": "#2"}],
                },
            }),
            encoding="utf-8",
        )

        issues = [
            {"number": 1, "title": "New", "url": "", "labels": []},
            {"number": 2, "title": "Dup", "url": "", "labels": []},
        ]
        monkeypatch.setattr(
            issue_ingest, "fetch_open_issues",
            lambda _repo, cwd=None: issues,
        )
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "o/r")

        rc = issue_ingest.main([
            "--all", "--vbrief-dir", str(vbrief_dir),
        ])
        assert rc == 0
        out = capsys.readouterr().out
        assert "bulk summary" in out
        assert "1 created" in out
        assert "1 duplicate" in out
        assert "CREATED" in out
        assert "SKIP" in out

    def test_bulk_mode_dry_run_prints_dryrun_entries(
        self, tmp_path, monkeypatch, capsys
    ):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        issues = [
            {"number": 10, "title": "A", "url": "", "labels": []},
            {"number": 11, "title": "B", "url": "", "labels": []},
        ]
        monkeypatch.setattr(
            issue_ingest, "fetch_open_issues",
            lambda _repo, cwd=None: issues,
        )

        rc = issue_ingest.main([
            "--all", "--dry-run",
            "--vbrief-dir", str(vbrief_dir), "--repo", "o/r",
        ])
        assert rc == 0
        out = capsys.readouterr().out
        assert "2 dry-run" in out
        assert "DRY-RUN" in out
        # No files written because of --dry-run
        assert list(vbrief_dir.rglob("*.vbrief.json")) == []


# ---------------------------------------------------------------------------
# _build_issue_vbrief / _target_filename edge cases
# ---------------------------------------------------------------------------


class TestBuildIssueVbrief:
    def test_issue_without_title_uses_fallback(self):
        vbrief, folder = issue_ingest._build_issue_vbrief(
            {"number": 99, "url": "https://x"}, "pending", ""
        )
        assert vbrief["plan"]["title"] == "Issue #99"
        assert folder == "pending"

    def test_issue_without_url_uses_repo_url_template(self):
        """#639: canonical ``{uri, type, title}`` shape with resolvable URL."""
        vbrief, folder = issue_ingest._build_issue_vbrief(
            {"number": 5, "title": "hi"}, "proposed", "https://github.com/o/r"
        )
        assert vbrief["vBRIEFInfo"]["version"] == "0.6"
        refs = vbrief["plan"]["references"]
        assert refs[0]["uri"] == "https://github.com/o/r/issues/5"
        assert refs[0]["type"] == "x-vbrief/github-issue"
        assert refs[0]["title"] == "Issue #5: hi"
        # Legacy keys MUST NOT leak into canonical output.
        assert "id" not in refs[0]
        assert "url" not in refs[0]
        assert "Ingested from https://github.com/o/r/issues/5" in (
            vbrief["plan"]["narratives"]["Origin"]
        )

    def test_issue_without_url_or_repo_origin_reference_omitted(self):
        """#639: when neither the payload nor ``repo_url`` yields a browser URL,
        no reference is emitted -- ``VBriefReference`` requires ``uri`` and we
        must not forge one. The issue number survives in ``narratives.Origin``.
        """
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 3, "title": "z"}, "proposed", ""
        )
        # references is either absent or empty -- both are honest signals.
        assert vbrief["plan"].get("references", []) == []
        assert vbrief["plan"]["narratives"]["Origin"] == "Ingested from issue #3"
        assert vbrief["vBRIEFInfo"]["version"] == "0.6"

    def test_labels_as_strings_supported(self):
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {"number": 2, "title": "t", "labels": ["bug", "p1"]},
            "proposed", "",
        )
        assert vbrief["plan"]["narratives"]["Labels"] == "bug, p1"

    def test_labels_mixed_skips_malformed(self):
        vbrief, _ = issue_ingest._build_issue_vbrief(
            {
                "number": 4,
                "title": "t",
                "labels": [
                    {"name": "keep"},
                    {"no_name": "drop"},  # dict without name -> skipped
                    "plain",
                    None,  # neither dict nor str -> skipped
                ],
            },
            "proposed", "",
        )
        labels = vbrief["plan"]["narratives"]["Labels"].split(", ")
        assert "keep" in labels
        assert "plain" in labels
        assert "drop" not in labels

    def test_target_filename_uses_slug(self):
        name = issue_ingest._target_filename(10, "Refactor the widget code")
        assert name.endswith("-10-refactor-the-widget-code.vbrief.json")

    def test_target_filename_empty_title_falls_back(self):
        name = issue_ingest._target_filename(11, "")
        assert name.endswith("-11-issue-11.vbrief.json")
