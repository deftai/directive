"""test_issue_ingest.py -- Tests for scripts/issue_ingest.py.

Covers:
- Single-issue happy path (fetches via gh api, writes scope vBRIEF with
  origin provenance reference)
- Duplicate detection (exit 1 + existing path in message)
- Bulk mode summary (created / duplicate / dry-run counts)
- --dry-run writes no files
- gh API error (exit 2)

Uses in-process module loading via ``importlib.util`` and monkeypatches
``subprocess.run`` / ``fetch_open_issues`` rather than hitting the real
GitHub API.

Story: #454 (task issue:ingest).
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def _load_issue_ingest():
    """Load scripts/issue_ingest.py in-process via importlib.util."""
    scripts_dir = REPO_ROOT / "scripts"
    # Ensure sibling modules (_vbrief_build, reconcile_issues) are importable.
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "issue_ingest",
        scripts_dir / "issue_ingest.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


issue_ingest = _load_issue_ingest()


# --- Fixtures ---------------------------------------------------------------


def _issue_dict(number: int, title: str, labels: list[str] | None = None) -> dict:
    return {
        "number": number,
        "title": title,
        "url": f"https://github.com/o/r/issues/{number}",
        "labels": [{"name": name} for name in (labels or [])],
    }


# --- Tests ------------------------------------------------------------------


class TestIngestOneHappyPath:
    """Single-issue mode writes a scope vBRIEF with origin provenance."""

    def test_writes_scope_vbrief_to_proposed(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        issue = _issue_dict(100, "Add widget support", labels=["enhancement"])
        result, path, _msg = issue_ingest.ingest_one(
            issue,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
        )
        assert result == "created"
        assert path.parent.name == "proposed"
        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["plan"]["title"] == "Add widget support"
        assert data["plan"]["status"] == "proposed"
        refs = data["plan"]["references"]
        assert refs[0]["type"] == "github-issue"
        assert refs[0]["id"] == "#100"
        assert refs[0]["url"] == "https://github.com/o/r/issues/100"
        assert "Labels" in data["plan"]["narratives"]

    def test_filename_convention(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        result, path, _ = issue_ingest.ingest_one(
            _issue_dict(42, "Fix login bug"),
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
        )
        assert result == "created"
        # YYYY-MM-DD-<N>-<slug>.vbrief.json
        assert path.name.endswith("-42-fix-login-bug.vbrief.json")

    def test_status_active_maps_to_running_in_active_folder(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        result, path, _ = issue_ingest.ingest_one(
            _issue_dict(7, "Activate"),
            vbrief_dir=vbrief_dir,
            status="active",
            repo_url="",
        )
        assert result == "created"
        assert path.parent.name == "active"
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["plan"]["status"] == "running"


class TestIngestOneDedup:
    """Duplicate detection: a pre-existing vBRIEF with the same github-issue
    reference short-circuits ingestion and the exit code is 1."""

    def _write_existing(self, vbrief_dir: Path, number: int) -> Path:
        folder = vbrief_dir / "pending"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"2026-04-01-{number}-existing.vbrief.json"
        target.write_text(
            json.dumps({
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Pre-existing",
                    "status": "pending",
                    "items": [],
                    "references": [
                        {"type": "github-issue", "id": f"#{number}",
                         "url": f"https://github.com/o/r/issues/{number}"}
                    ],
                },
            }),
            encoding="utf-8",
        )
        return target

    def test_duplicate_detected_and_existing_path_returned(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        existing = self._write_existing(vbrief_dir, 50)
        result, path, msg = issue_ingest.ingest_one(
            _issue_dict(50, "Dup"),
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
        )
        assert result == "duplicate"
        assert path == existing
        assert "already ingested" in msg

    def test_cli_duplicate_exits_1(self, tmp_path, monkeypatch):
        vbrief_dir = tmp_path / "vbrief"
        self._write_existing(vbrief_dir, 77)

        # main() passes ``cwd=project_root`` as a keyword arg to
        # _fetch_single_issue (#538); fake stubs must accept it.
        def fake_fetch(_repo, _number, *, cwd=None):
            return _issue_dict(77, "Dup CLI")

        monkeypatch.setattr(issue_ingest, "_fetch_single_issue", fake_fetch)
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "o/r")

        rc = issue_ingest.main([
            "77", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r",
        ])
        assert rc == 1


class TestBulkMode:
    def test_bulk_summary_counts(self, tmp_path, monkeypatch):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # Pre-create a vBRIEF for issue #2 so it's a duplicate.
        (vbrief_dir / "pending").mkdir()
        (vbrief_dir / "pending" / "2026-04-01-2-existing.vbrief.json").write_text(
            json.dumps({
                "vBRIEFInfo": {"version": "0.5"},
                "plan": {
                    "title": "Existing",
                    "status": "pending",
                    "items": [],
                    "references": [{"type": "github-issue", "id": "#2"}],
                },
            }),
            encoding="utf-8",
        )
        issues = [
            _issue_dict(1, "First"),
            _issue_dict(2, "Second"),
            _issue_dict(3, "Third", labels=["bug"]),
        ]

        summary = issue_ingest.ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
        )
        assert summary["total"] == 3
        assert len(summary["created"]) == 2
        assert len(summary["duplicate"]) == 1
        assert len(summary["dryrun"]) == 0

    def test_bulk_label_filter(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        issues = [
            _issue_dict(10, "One", labels=["enhancement"]),
            _issue_dict(11, "Two", labels=["bug"]),
            _issue_dict(12, "Three", labels=["bug", "p1"]),
        ]
        summary = issue_ingest.ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
            label="bug",
        )
        assert summary["total"] == 2  # filtered to 2
        assert len(summary["created"]) == 2


class TestDryRun:
    def test_dry_run_writes_no_files(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        result, path, msg = issue_ingest.ingest_one(
            _issue_dict(999, "Dry"),
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
            dry_run=True,
        )
        assert result == "dryrun"
        assert "DRY-RUN" in msg
        # Path was computed but file not written
        assert not path.exists()
        # No files created in any lifecycle folder
        assert list(vbrief_dir.rglob("*.vbrief.json")) == []

    def test_bulk_dry_run_summary(self, tmp_path):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        issues = [_issue_dict(i, f"Issue {i}") for i in range(1, 4)]
        summary = issue_ingest.ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status="proposed",
            repo_url="https://github.com/o/r",
            dry_run=True,
        )
        assert summary["total"] == 3
        assert len(summary["dryrun"]) == 3
        assert len(summary["created"]) == 0
        assert list(vbrief_dir.rglob("*.vbrief.json")) == []


class TestGhApiError:
    def test_single_issue_fetch_failure_returns_2(self, tmp_path, monkeypatch):
        """When gh fails, main returns exit code 2."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        class FakeResult:
            returncode = 1
            stdout = ""
            stderr = "HTTP 404: Not Found"

        def fake_run(*args, **kwargs):
            return FakeResult()

        monkeypatch.setattr(subprocess, "run", fake_run)
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "o/r")

        rc = issue_ingest.main([
            "999999", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r",
        ])
        assert rc == 2

    def test_bulk_fetch_failure_returns_2(self, tmp_path, monkeypatch):
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()
        # main() passes ``cwd=project_root`` to fetch_open_issues (#538).
        monkeypatch.setattr(
            issue_ingest,
            "fetch_open_issues",
            lambda _repo, cwd=None: None,
        )
        monkeypatch.setattr(issue_ingest, "detect_repo", lambda: "o/r")

        rc = issue_ingest.main([
            "--all", "--vbrief-dir", str(vbrief_dir), "--repo", "o/r",
        ])
        assert rc == 2


class TestCliHelp:
    def test_help_subprocess(self):
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "issue_ingest.py"), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        assert "Ingest GitHub issues" in result.stdout
