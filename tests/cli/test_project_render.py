"""
test_project_render.py -- Subprocess-based unit tests for project_render.py.

Covers PROJECT-DEFINITION.vbrief.json regeneration from lifecycle folders:
- Skeleton creation when no PROJECT-DEFINITION exists
- Items registry update from all 5 lifecycle folders
- Timestamp freshness (vBRIEFInfo.updated)
- Staleness flagging for narratives
- Deterministic output (same input -> same output)
- Graceful handling of missing/empty lifecycle folders
- Malformed vBRIEF file handling

Story: #323 (RFC #309, D14)
"""

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()


def run_project_render(
    vbrief_dir: str, cwd: Path | None = None
) -> subprocess.CompletedProcess:
    """Run project_render.py with the given vbrief directory."""
    script = REPO_ROOT / "scripts" / "project_render.py"
    return subprocess.run(
        [sys.executable, str(script), vbrief_dir],
        capture_output=True,
        text=True,
        cwd=str(cwd or REPO_ROOT),
        env={**os.environ, "PYTHONUTF8": "1"},
        timeout=30,
    )


def make_vbrief(title: str, status: str, references: list | None = None) -> dict:
    """Create a minimal valid vBRIEF JSON structure."""
    plan: dict = {"title": title, "status": status, "items": []}
    if references:
        plan["references"] = references
    return {"vBRIEFInfo": {"version": "0.5"}, "plan": plan}


def write_vbrief(path: Path, title: str, status: str, **kwargs) -> None:
    """Write a vBRIEF JSON file to the given path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = make_vbrief(title, status, **kwargs)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def read_project_def(vbrief_dir: Path) -> dict:
    """Read and parse PROJECT-DEFINITION.vbrief.json."""
    path = vbrief_dir / "PROJECT-DEFINITION.vbrief.json"
    return json.loads(path.read_text(encoding="utf-8"))


# ===========================================================================
# Skeleton creation
# ===========================================================================


class TestSkeletonCreation:
    """Tests for creating PROJECT-DEFINITION.vbrief.json from scratch."""

    def test_creates_skeleton_when_no_project_def_exists(self, tmp_path):
        """Creates a valid skeleton when no PROJECT-DEFINITION exists."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "created" in result.stdout
        assert (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").exists()

    def test_skeleton_has_valid_vbrief_structure(self, tmp_path):
        """Skeleton has required vBRIEF v0.5 structure."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)

        assert data["vBRIEFInfo"]["version"] == "0.5"
        assert data["plan"]["title"] == "PROJECT-DEFINITION"
        assert data["plan"]["status"] == "running"
        assert "narratives" in data["plan"]
        assert "items" in data["plan"]

    def test_skeleton_has_empty_narratives(self, tmp_path):
        """Skeleton narratives are present but empty strings."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        narratives = data["plan"]["narratives"]

        # "tech stack" (lowercase, space-separated) is required so
        # `task project:render` skeletons pass `task vbrief:validate` (#405).
        for key in ("Overview", "tech stack", "Architecture", "RisksAndUnknowns", "Configuration"):
            assert key in narratives
            assert narratives[key] == ""

    def test_skeleton_has_timestamps(self, tmp_path):
        """Skeleton has created and updated timestamps."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        info = data["vBRIEFInfo"]

        assert "created" in info
        assert "updated" in info
        assert info["created"] == info["updated"]

    def test_creates_vbrief_dir_if_missing(self, tmp_path):
        """Creates vbrief/ directory if it does not exist."""
        vbrief_dir = tmp_path / "vbrief"
        # Do NOT create the directory

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert vbrief_dir.exists()
        assert (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").exists()


# ===========================================================================
# Lifecycle folder scanning
# ===========================================================================


class TestLifecycleScan:
    """Tests for scanning all 5 lifecycle folders."""

    def test_scans_all_five_folders(self, tmp_path):
        """Items from all 5 lifecycle folders appear in the registry."""
        vbrief_dir = tmp_path / "vbrief"
        folders = ["proposed", "pending", "active", "completed", "cancelled"]
        for folder in folders:
            write_vbrief(
                vbrief_dir / folder / f"2026-04-13-test-{folder}.vbrief.json",
                title=f"Test {folder}",
                status=folder if folder in ("completed", "cancelled") else "running",
            )

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "5 scope items" in result.stdout

        data = read_project_def(vbrief_dir)
        items = data["plan"]["items"]
        assert len(items) == 5

        found_folders = {i["metadata"]["lifecycle_folder"] for i in items}
        assert found_folders == set(folders)

    def test_extracts_title_and_status_from_vbrief(self, tmp_path):
        """Items carry the correct title and status from the vBRIEF file."""
        vbrief_dir = tmp_path / "vbrief"
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-oauth.vbrief.json",
            title="Implement OAuth flow",
            status="running",
        )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        item = data["plan"]["items"][0]

        assert item["title"] == "Implement OAuth flow"
        assert item["status"] == "running"
        assert item["metadata"]["source_path"] == "active/2026-04-13-oauth.vbrief.json"

    def test_extracts_references(self, tmp_path):
        """Items include references from the source vBRIEF when present."""
        vbrief_dir = tmp_path / "vbrief"
        refs = [
            {"type": "github-issue", "url": "https://github.com/org/repo/issues/42", "id": "#42"}
        ]
        write_vbrief(
            vbrief_dir / "pending" / "2026-04-13-fix-bug.vbrief.json",
            title="Fix critical bug",
            status="pending",
            references=refs,
        )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        item = data["plan"]["items"][0]

        assert "references" in item["metadata"]
        assert item["metadata"]["references"][0]["id"] == "#42"

    def test_multiple_items_per_folder_sorted(self, tmp_path):
        """Multiple items in one folder are sorted alphabetically by filename."""
        vbrief_dir = tmp_path / "vbrief"
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-z-last.vbrief.json",
            title="Z Last",
            status="running",
        )
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-a-first.vbrief.json",
            title="A First",
            status="running",
        )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        items = data["plan"]["items"]

        assert len(items) == 2
        assert items[0]["title"] == "A First"
        assert items[1]["title"] == "Z Last"


# ===========================================================================
# Missing/empty folders
# ===========================================================================


class TestGracefulHandling:
    """Tests for graceful handling of missing/empty lifecycle folders."""

    def test_missing_lifecycle_folders(self, tmp_path):
        """No lifecycle folders exist -> zero items, no error."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "0 scope items" in result.stdout

    def test_empty_lifecycle_folders(self, tmp_path):
        """All lifecycle folders exist but are empty -> zero items."""
        vbrief_dir = tmp_path / "vbrief"
        for folder in ("proposed", "pending", "active", "completed", "cancelled"):
            (vbrief_dir / folder).mkdir(parents=True)

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "0 scope items" in result.stdout

    def test_partial_lifecycle_folders(self, tmp_path):
        """Only some lifecycle folders exist -> scans available ones."""
        vbrief_dir = tmp_path / "vbrief"
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-task.vbrief.json",
            title="Active task",
            status="running",
        )
        # Only active/ exists, others don't

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "1 scope items" in result.stdout

    def test_malformed_vbrief_file(self, tmp_path):
        """Malformed JSON in a vBRIEF file is handled gracefully."""
        vbrief_dir = tmp_path / "vbrief"
        bad_dir = vbrief_dir / "active"
        bad_dir.mkdir(parents=True)
        (bad_dir / "2026-04-13-broken.vbrief.json").write_text(
            "{invalid json", encoding="utf-8"
        )

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "1 scope items" in result.stdout

        data = read_project_def(vbrief_dir)
        item = data["plan"]["items"][0]
        assert "[unreadable]" in item["title"]
        assert "error" in item["metadata"]


# ===========================================================================
# Update existing PROJECT-DEFINITION
# ===========================================================================


class TestUpdateExisting:
    """Tests for updating an existing PROJECT-DEFINITION.vbrief.json."""

    def test_updates_items_registry(self, tmp_path):
        """Running again with new items updates the registry."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        # First run: skeleton with no items
        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        assert len(data["plan"]["items"]) == 0

        # Add a scope file
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-new-scope.vbrief.json",
            title="New scope",
            status="running",
        )

        # Second run: items updated
        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "updated" in result.stdout

        data = read_project_def(vbrief_dir)
        assert len(data["plan"]["items"]) == 1

    def test_preserves_existing_narratives(self, tmp_path):
        """Update does not overwrite existing narrative content."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        # Create a PROJECT-DEFINITION with custom narratives
        existing = {
            "vBRIEFInfo": {"version": "0.5", "created": "2026-01-01T00:00:00Z"},
            "plan": {
                "title": "PROJECT-DEFINITION",
                "status": "running",
                "narratives": {
                    "Overview": "This is a custom overview.",
                    "TechStack": "Python, Go, Rust",
                },
                "items": [],
                "metadata": {"staleness_flags": []},
            },
        }
        (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(existing, indent=2), encoding="utf-8"
        )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)

        assert data["plan"]["narratives"]["Overview"] == "This is a custom overview."
        assert data["plan"]["narratives"]["TechStack"] == "Python, Go, Rust"

    def test_updates_timestamp(self, tmp_path):
        """vBRIEFInfo.updated is refreshed on each run."""
        vbrief_dir = tmp_path / "vbrief"
        vbrief_dir.mkdir()

        existing = {
            "vBRIEFInfo": {
                "version": "0.5",
                "created": "2026-01-01T00:00:00Z",
                "updated": "2026-01-01T00:00:00Z",
            },
            "plan": {
                "title": "PROJECT-DEFINITION",
                "status": "running",
                "narratives": {},
                "items": [],
                "metadata": {"staleness_flags": []},
            },
        }
        (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(existing, indent=2), encoding="utf-8"
        )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)

        # Updated should be more recent than the old value
        assert data["vBRIEFInfo"]["updated"] != "2026-01-01T00:00:00Z"
        # Created should be preserved
        assert data["vBRIEFInfo"]["created"] == "2026-01-01T00:00:00Z"


# ===========================================================================
# Staleness flagging
# ===========================================================================


class TestStalenessFlags:
    """Tests for narrative staleness flagging based on completed scopes."""

    def test_flags_narrative_matching_completed_scope(self, tmp_path):
        """Narrative flagged when its key matches a completed scope title."""
        vbrief_dir = tmp_path / "vbrief"

        # Create existing PROJECT-DEFINITION with narratives
        existing = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "PROJECT-DEFINITION",
                "status": "running",
                "narratives": {"TechStack": "Python and Go"},
                "items": [],
                "metadata": {"staleness_flags": []},
            },
        }
        vbrief_dir.mkdir()
        (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(existing, indent=2), encoding="utf-8"
        )

        # Add completed scope with matching topic
        write_vbrief(
            vbrief_dir / "completed" / "2026-04-13-migrate-stack.vbrief.json",
            title="Migrate tech stack to Rust",
            status="completed",
        )

        result = run_project_render(str(vbrief_dir))
        assert result.returncode == 0
        assert "staleness flag" in result.stdout

        data = read_project_def(vbrief_dir)
        flags = data["plan"]["metadata"]["staleness_flags"]
        assert len(flags) >= 1
        assert any("TechStack" in f for f in flags)

    def test_no_flags_when_no_completed_scopes(self, tmp_path):
        """No staleness flags when no completed scopes exist."""
        vbrief_dir = tmp_path / "vbrief"

        existing = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "PROJECT-DEFINITION",
                "status": "running",
                "narratives": {"TechStack": "Python"},
                "items": [],
                "metadata": {"staleness_flags": []},
            },
        }
        vbrief_dir.mkdir()
        (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(existing, indent=2), encoding="utf-8"
        )

        # Only active scope, no completed
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-wip.vbrief.json",
            title="Work in progress",
            status="running",
        )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        flags = data["plan"]["metadata"]["staleness_flags"]
        assert len(flags) == 0

    def test_general_flag_for_many_completed(self, tmp_path):
        """General review flag when >=3 completed scopes but no keyword match."""
        vbrief_dir = tmp_path / "vbrief"

        existing = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "PROJECT-DEFINITION",
                "status": "running",
                "narratives": {"Overview": "A project overview"},
                "items": [],
                "metadata": {"staleness_flags": []},
            },
        }
        vbrief_dir.mkdir()
        (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(existing, indent=2), encoding="utf-8"
        )

        # Add 3 completed scopes with titles that don't match narrative keys
        for i in range(3):
            write_vbrief(
                vbrief_dir / "completed" / f"2026-04-1{i}-task-{i}.vbrief.json",
                title=f"Completed item number {i}",
                status="completed",
            )

        run_project_render(str(vbrief_dir))
        data = read_project_def(vbrief_dir)
        flags = data["plan"]["metadata"]["staleness_flags"]
        assert len(flags) >= 1
        assert any("review recommended" in f for f in flags)


# ===========================================================================
# Determinism
# ===========================================================================


class TestDeterminism:
    """Tests for deterministic output (same input -> same output)."""

    def test_same_input_produces_same_items(self, tmp_path):
        """Running twice with unchanged folders produces identical items."""
        vbrief_dir = tmp_path / "vbrief"
        for folder in ("proposed", "active", "completed"):
            write_vbrief(
                vbrief_dir / folder / f"2026-04-13-scope-{folder}.vbrief.json",
                title=f"Scope in {folder}",
                status="completed" if folder == "completed" else "running",
            )

        run_project_render(str(vbrief_dir))
        data1 = read_project_def(vbrief_dir)
        items1 = data1["plan"]["items"]

        # Remove timestamp for comparison (timestamps change between runs)
        run_project_render(str(vbrief_dir))
        data2 = read_project_def(vbrief_dir)
        items2 = data2["plan"]["items"]

        assert items1 == items2

    def test_staleness_flags_are_deterministic(self, tmp_path):
        """Staleness flags are identical for the same folder state."""
        vbrief_dir = tmp_path / "vbrief"

        existing = {
            "vBRIEFInfo": {"version": "0.5"},
            "plan": {
                "title": "PROJECT-DEFINITION",
                "status": "running",
                "narratives": {"TechStack": "Python", "Architecture": "Monolith"},
                "items": [],
                "metadata": {"staleness_flags": []},
            },
        }
        vbrief_dir.mkdir()
        (vbrief_dir / "PROJECT-DEFINITION.vbrief.json").write_text(
            json.dumps(existing, indent=2), encoding="utf-8"
        )

        write_vbrief(
            vbrief_dir / "completed" / "2026-04-13-new-arch.vbrief.json",
            title="Migrate architecture to microservices",
            status="completed",
        )

        run_project_render(str(vbrief_dir))
        flags1 = read_project_def(vbrief_dir)["plan"]["metadata"]["staleness_flags"]

        run_project_render(str(vbrief_dir))
        flags2 = read_project_def(vbrief_dir)["plan"]["metadata"]["staleness_flags"]

        assert flags1 == flags2


# ===========================================================================
# CLI usage
# ===========================================================================


class TestCLI:
    """Tests for CLI argument handling."""

    def test_too_many_args_exits_2(self):
        """Too many CLI arguments exits with code 2."""
        script = REPO_ROOT / "scripts" / "project_render.py"
        result = subprocess.run(
            [sys.executable, str(script), "arg1", "arg2"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 2
        assert "Usage" in result.stderr

    def test_report_shows_item_count(self, tmp_path):
        """Output reports the number of scope items found."""
        vbrief_dir = tmp_path / "vbrief"
        write_vbrief(
            vbrief_dir / "active" / "2026-04-13-a.vbrief.json",
            title="Task A",
            status="running",
        )
        write_vbrief(
            vbrief_dir / "pending" / "2026-04-13-b.vbrief.json",
            title="Task B",
            status="pending",
        )

        result = run_project_render(str(vbrief_dir))
        assert "2 scope items" in result.stdout
