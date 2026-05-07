"""test_reconcile_issues_direct.py -- Direct-import tests for
scripts/reconcile_issues.py.

Covers branches that the subprocess-based tests/cli/test_reconcile_issues.py
cannot easily exercise:
- ``fetch_open_issues`` error paths (FileNotFoundError, TimeoutExpired,
  non-zero exit code, JSON parse failure, fetch-limit warning).
- ``detect_repo`` success (SSH + HTTPS remotes) and failure paths.
- ``main()`` CLI: missing vbrief-dir, repo-detection failure, JSON and
  markdown output branches, no_open_issue formatting.

Raises scripts/reconcile_issues.py coverage from ~64% toward ~95% to
give the >=85% TOTAL gate headroom for the RC3 Wave 1 PRs (#507-#510).

Part of RC3 prep chore referenced by #506.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_reconcile_issues():
    """Load scripts/reconcile_issues.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "reconcile_issues_direct",
        scripts_dir / "reconcile_issues.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reconcile = _load_reconcile_issues()


# ---------------------------------------------------------------------------
# fetch_open_issues
# ---------------------------------------------------------------------------


class TestFetchOpenIssues:
    def test_gh_not_found_returns_none(self, monkeypatch, capsys):
        def fake_run(*_a, **_k):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(reconcile.subprocess, "run", fake_run)
        assert reconcile.fetch_open_issues("o/r") is None
        assert "gh CLI not found" in capsys.readouterr().err

    def test_gh_timeout_returns_none(self, monkeypatch, capsys):
        def fake_run(*_a, **_k):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=60)

        monkeypatch.setattr(reconcile.subprocess, "run", fake_run)
        assert reconcile.fetch_open_issues("o/r") is None
        assert "timed out" in capsys.readouterr().err

    def test_nonzero_exit_returns_none(self, monkeypatch, capsys):
        class R:
            returncode = 1
            stdout = ""
            stderr = "bad creds"

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.fetch_open_issues("o/r") is None
        assert "gh CLI failed" in capsys.readouterr().err

    def test_invalid_json_returns_none(self, monkeypatch, capsys):
        class R:
            returncode = 0
            stdout = "{not json"
            stderr = ""

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.fetch_open_issues("o/r") is None
        assert "failed to parse" in capsys.readouterr().err

    def test_happy_path(self, monkeypatch):
        payload = [{"number": 1, "title": "T"}]

        class R:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.fetch_open_issues("o/r") == payload

    def test_limit_warning_printed_when_at_cap(self, monkeypatch, capsys):
        """When the issue list returned meets/exceeds ISSUE_FETCH_LIMIT, a
        stderr warning is emitted."""
        # Temporarily reduce the limit so the test does not need 200 items.
        monkeypatch.setattr(reconcile, "ISSUE_FETCH_LIMIT", 2)
        payload = [
            {"number": 1, "title": "A"},
            {"number": 2, "title": "B"},
        ]

        class R:
            returncode = 0
            stdout = json.dumps(payload)
            stderr = ""

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        result = reconcile.fetch_open_issues("o/r")
        assert result == payload
        assert "Warning" in capsys.readouterr().err

    def test_issue_fetch_limit_floor(self):
        """Regression guard (#764): ISSUE_FETCH_LIMIT must stay >=
        DEFAULT_MAX_OPEN_ISSUES so `task issue:ingest --all` does not
        silently truncate on repos with hundreds of open issues. The
        deftai/directive repo crossed 200 open issues during the
        2026-04-30 refinement cycle, which exposed that the prior 200
        cap was lower than the documented `DEFAULT_MAX_OPEN_ISSUES`
        ceiling. Pinning the floor to DEFAULT_MAX_OPEN_ISSUES couples
        the two safety values so neither can drift below the other in
        a future refactor.
        """
        assert (
            reconcile.ISSUE_FETCH_LIMIT >= reconcile.DEFAULT_MAX_OPEN_ISSUES
        ), (
            "ISSUE_FETCH_LIMIT silently regressed below "
            "DEFAULT_MAX_OPEN_ISSUES; bulk ingest will truncate."
        )


# ---------------------------------------------------------------------------
# detect_repo
# ---------------------------------------------------------------------------


class TestDetectRepo:
    def test_git_not_found(self, monkeypatch):
        def fake_run(*_a, **_k):
            raise FileNotFoundError("git")

        monkeypatch.setattr(reconcile.subprocess, "run", fake_run)
        assert reconcile.detect_repo() is None

    def test_git_timeout(self, monkeypatch):
        def fake_run(*_a, **_k):
            raise subprocess.TimeoutExpired(cmd="git", timeout=10)

        monkeypatch.setattr(reconcile.subprocess, "run", fake_run)
        assert reconcile.detect_repo() is None

    def test_non_zero_returncode(self, monkeypatch):
        class R:
            returncode = 1
            stdout = ""
            stderr = "no remote"

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.detect_repo() is None

    def test_https_remote_parsed(self, monkeypatch):
        class R:
            returncode = 0
            stdout = "https://github.com/octo/cat.git\n"
            stderr = ""

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.detect_repo() == "octo/cat"

    def test_ssh_remote_parsed(self, monkeypatch):
        class R:
            returncode = 0
            stdout = "git@github.com:octo/cat.git\n"
            stderr = ""

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.detect_repo() == "octo/cat"

    def test_unknown_remote_returns_none(self, monkeypatch):
        class R:
            returncode = 0
            stdout = "gitlab.example.com:owner/repo.git\n"
            stderr = ""

        monkeypatch.setattr(
            reconcile.subprocess, "run", lambda *a, **k: R()
        )
        assert reconcile.detect_repo() is None


# ---------------------------------------------------------------------------
# extract_references_from_vbrief -- nested non-dict item branch
# ---------------------------------------------------------------------------


class TestExtractReferences:
    def test_non_dict_items_skipped(self):
        data = {
            "plan": {
                "references": [{"type": "github-issue", "id": "#1"}],
                "items": [
                    "not-a-dict",  # skipped by _walk_items
                    {"references": [{"type": "github-issue", "id": "#2"}]},
                    {"subItems": [None, {"references": [
                        {"type": "github-issue", "id": "#3"}
                    ]}]},
                ],
            }
        }
        refs = reconcile.extract_references_from_vbrief(data)
        ids = {r["id"] for r in refs}
        assert ids == {"#1", "#2", "#3"}


# ---------------------------------------------------------------------------
# format_markdown -- no_open_issue branch + empty sections
# ---------------------------------------------------------------------------


class TestFormatMarkdown:
    def test_renders_no_open_issue_section(self):
        report = {
            "linked": [],
            "unlinked": [],
            "no_open_issue": [
                {
                    "issue_number": 42,
                    "vbrief_files": ["pending/2026-04-01-42-x.vbrief.json"],
                    "note": "Issue is closed",
                }
            ],
            "summary": {
                "total_open_issues": 0,
                "linked_count": 0,
                "unlinked_count": 0,
                "vbriefs_no_open_issue_count": 1,
            },
        }
        md = reconcile.format_markdown(report)
        assert "#42" in md
        assert "pending/2026-04-01-42-x.vbrief.json" in md
        assert "Issue is closed" in md
        # Other sections render "None." when empty
        assert md.count("None.") == 2  # linked + unlinked

    def test_renders_full_report(self):
        report = {
            "linked": [{
                "issue_number": 1, "title": "L",
                "url": "u", "vbrief_files": ["a.json"],
            }],
            "unlinked": [{"issue_number": 2, "title": "U", "url": "u2"}],
            "no_open_issue": [],
            "summary": {
                "total_open_issues": 2,
                "linked_count": 1,
                "unlinked_count": 1,
                "vbriefs_no_open_issue_count": 0,
            },
        }
        md = reconcile.format_markdown(report)
        assert "#1 L" in md
        assert "#2 U" in md


# ---------------------------------------------------------------------------
# main() CLI
# ---------------------------------------------------------------------------


class TestMainCli:
    def test_missing_vbrief_dir_returns_1(
        self, tmp_path, monkeypatch, capsys
    ):
        missing = tmp_path / "does-not-exist"
        monkeypatch.setattr(
            sys, "argv", ["reconcile_issues.py", "--vbrief-dir", str(missing)]
        )
        rc = reconcile.main()
        assert rc == 1
        assert "vbrief directory not found" in capsys.readouterr().err

    def test_repo_detection_fails(self, tmp_path, monkeypatch, capsys):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # Stub BOTH detection paths (#538): resolve_project_repo is
        # consulted first; detect_repo is the CWD-scoped fallback.
        monkeypatch.setattr(
            reconcile, "resolve_project_repo",
            lambda *_a, **_k: None,
        )
        monkeypatch.setattr(reconcile, "detect_repo", lambda: None)
        monkeypatch.setattr(
            sys, "argv",
            ["reconcile_issues.py", "--vbrief-dir", str(vbrief_dir)],
        )
        rc = reconcile.main()
        # Exit 2 matches issue_ingest.py / scope_lifecycle.py for the
        # same usage-style error (Greptile P2 on #562).
        assert rc == 2
        assert "could not detect repo" in capsys.readouterr().err

    def test_fetch_failure_returns_1(self, tmp_path, monkeypatch):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # #754: default path uses fetch_issue_states (inverted lookup).
        monkeypatch.setattr(
            reconcile, "fetch_issue_states",
            lambda _r, _ids, cwd=None: None,
        )
        monkeypatch.setattr(
            sys, "argv",
            [
                "reconcile_issues.py",
                "--vbrief-dir", str(vbrief_dir),
                "--repo", "o/r",
            ],
        )
        rc = reconcile.main()
        assert rc == 1

    def test_markdown_output(self, tmp_path, monkeypatch, capsys):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # #754: empty vbrief dir -> empty issue set -> empty state map.
        monkeypatch.setattr(
            reconcile, "fetch_issue_states",
            lambda _r, _ids, cwd=None: {},
        )
        monkeypatch.setattr(
            sys, "argv",
            [
                "reconcile_issues.py",
                "--vbrief-dir", str(vbrief_dir),
                "--repo", "o/r",
            ],
        )
        rc = reconcile.main()
        assert rc == 0
        assert "# Issue Reconciliation Report" in capsys.readouterr().out

    def test_json_output(self, tmp_path, monkeypatch, capsys):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # #754: default path uses fetch_issue_states (inverted lookup);
        # an empty vbrief tree yields an empty issue set / state map.
        monkeypatch.setattr(
            reconcile, "fetch_issue_states",
            lambda _r, _ids, cwd=None: {},
        )
        monkeypatch.setattr(
            sys, "argv",
            [
                "reconcile_issues.py",
                "--vbrief-dir", str(vbrief_dir),
                "--repo", "o/r",
                "--format", "json",
            ],
        )
        rc = reconcile.main()
        assert rc == 0
        out = capsys.readouterr().out
        parsed = json.loads(out)
        # Inverted-lookup summary shape (#754).
        assert parsed["summary"]["linked_count"] == 0
        assert parsed["summary"]["vbriefs_no_open_issue_count"] == 0
        assert "unlinked" not in parsed
