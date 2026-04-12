"""
test_task_scripts.py -- Subprocess-based unit tests for v0.17.0 task scripts.

Covers scripts/toolchain-check.py, scripts/verify-stubs.py,
scripts/validate-links.py, and task CLI commands change:init and commit:lint.

Spec task: t3.3.4 (#293)

Author: Scott Adams (msadams) -- 2026-04-12
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()

# go-task CLI is not installed in CI (GitHub Actions ubuntu-latest)
_has_task = shutil.which("task") is not None
requires_task = pytest.mark.skipif(
    not _has_task, reason="go-task CLI not available"
)

_has_all_tools = all(shutil.which(t) for t in ("go", "uv", "task", "git", "gh"))
requires_all_tools = pytest.mark.skipif(
    not _has_all_tools, reason="full toolchain (go, uv, task, git, gh) not available"
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def run_script(
    script_name: str, cwd: Path | None = None, env: dict | None = None
) -> subprocess.CompletedProcess:
    """Run a Python script under scripts/ and return the CompletedProcess."""
    script = REPO_ROOT / "scripts" / script_name
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(
        [sys.executable, str(script)],
        capture_output=True,
        text=True,
        cwd=str(cwd or REPO_ROOT),
        env=merged_env,
        timeout=30,
    )



# ===========================================================================
# toolchain-check.py
# ===========================================================================

class TestToolchainCheck:
    """Tests for scripts/toolchain-check.py."""

    @requires_all_tools
    def test_happy_path_all_tools_present(self):
        """All required tools (go, uv, task, git, gh) are available in dev env."""
        result = run_script("toolchain-check.py")
        assert result.returncode == 0
        assert "All required tools available" in result.stdout

    def test_missing_tool_exits_nonzero(self, tmp_path):
        """When a tool is missing from PATH, script exits non-zero."""
        # Create an empty PATH dir so no tool can be found
        empty_bin = tmp_path / "empty_bin"
        empty_bin.mkdir()
        env = {"PATH": str(empty_bin), "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
        result = run_script("toolchain-check.py", env=env)
        assert result.returncode == 1
        assert "Missing tools:" in result.stdout

    def test_missing_tool_reports_name(self, tmp_path):
        """Missing tool name appears in the 'NOT FOUND' output."""
        empty_bin = tmp_path / "empty_bin"
        empty_bin.mkdir()
        env = {"PATH": str(empty_bin), "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
        result = run_script("toolchain-check.py", env=env)
        assert "NOT FOUND" in result.stdout

    def test_timeout_parameter_present_in_source(self):
        """Script source contains a timeout= parameter for subprocess calls."""
        script = REPO_ROOT / "scripts" / "toolchain-check.py"
        source = script.read_text("utf-8")
        assert "timeout=" in source


# ===========================================================================
# verify-stubs.py
# ===========================================================================

class TestVerifyStubs:
    """Tests for scripts/verify-stubs.py."""

    def test_clean_source_exits_zero(self, tmp_path):
        """Directory with no stub patterns exits 0."""
        (tmp_path / "clean.py").write_text("def hello():\n    return 42\n", encoding="utf-8")
        result = run_script("verify-stubs.py", cwd=tmp_path)
        assert result.returncode == 0
        assert "No stub patterns found" in result.stdout

    def test_todo_detected_exits_nonzero(self, tmp_path):
        """TODO keyword in a .py file is flagged."""
        (tmp_path / "bad.py").write_text("# TODO: fix this\n", encoding="utf-8")
        result = run_script("verify-stubs.py", cwd=tmp_path)
        assert result.returncode == 1
        assert "TODO" in result.stdout

    def test_fixme_detected(self, tmp_path):
        """FIXME keyword in a .py file is flagged."""
        (tmp_path / "issue.py").write_text("x = 1  # FIXME later\n", encoding="utf-8")
        result = run_script("verify-stubs.py", cwd=tmp_path)
        assert result.returncode == 1
        assert "FIXME" in result.stdout

    def test_hack_detected(self, tmp_path):
        """HACK keyword in a .go file is flagged."""
        (tmp_path / "hack.go").write_text("// HACK: workaround\npackage main\n", encoding="utf-8")
        result = run_script("verify-stubs.py", cwd=tmp_path)
        assert result.returncode == 1
        assert "HACK" in result.stdout

    def test_excluded_dirs_not_flagged(self, tmp_path):
        """Files in excluded dirs (tests/, vendor/, .git/) are not scanned."""
        for d in ("tests", "vendor", ".git"):
            subdir = tmp_path / d
            subdir.mkdir()
            (subdir / "stub.py").write_text("# TODO: excluded\n", encoding="utf-8")
        result = run_script("verify-stubs.py", cwd=tmp_path)
        assert result.returncode == 0

    def test_encoding_edge_case(self, tmp_path):
        """Files with non-UTF-8 bytes are handled gracefully (errors='replace')."""
        bad_file = tmp_path / "binary.py"
        bad_file.write_bytes(b"# \xff\xfe hello\ndef ok():\n    return 1\n")
        result = run_script("verify-stubs.py", cwd=tmp_path)
        # Should not crash; clean file should exit 0
        assert result.returncode == 0

    def test_bare_pass_detected(self, tmp_path):
        """Bare 'pass' after a colon-ending line is flagged as a stub."""
        (tmp_path / "stub_fn.py").write_text(
            "def placeholder():\n    pass\n", encoding="utf-8"
        )
        result = run_script("verify-stubs.py", cwd=tmp_path)
        assert result.returncode == 1
        assert "bare pass" in result.stdout


# ===========================================================================
# validate-links.py
# ===========================================================================

class TestValidateLinks:
    """Tests for scripts/validate-links.py."""

    def test_all_valid_links_exits_zero(self, tmp_path):
        """All internal links resolve -> exit 0."""
        (tmp_path / "README.md").write_text(
            "See [guide](guide.md) for details.\n", encoding="utf-8"
        )
        (tmp_path / "guide.md").write_text("# Guide\n", encoding="utf-8")
        result = run_script("validate-links.py", cwd=tmp_path)
        assert result.returncode == 0
        assert "All internal markdown links valid" in result.stdout

    def test_broken_internal_link_strict(self, tmp_path):
        """Broken internal link in strict mode exits non-zero."""
        (tmp_path / "README.md").write_text(
            "See [missing](nonexistent.md) here.\n", encoding="utf-8"
        )
        result = run_script(
            "validate-links.py", cwd=tmp_path, env={"LINK_CHECK_STRICT": "1"}
        )
        assert result.returncode == 1
        assert "broken internal link" in result.stdout.lower()

    def test_broken_internal_link_warning_mode(self, tmp_path):
        """Broken internal link in default (warning) mode exits 0."""
        (tmp_path / "README.md").write_text(
            "See [missing](nonexistent.md) here.\n", encoding="utf-8"
        )
        # Explicitly clear LINK_CHECK_STRICT to avoid inheriting it from the runner env
        result = run_script("validate-links.py", cwd=tmp_path, env={"LINK_CHECK_STRICT": ""})
        assert result.returncode == 0
        assert "warnings" in result.stdout.lower()

    def test_external_url_skipped(self, tmp_path):
        """External URLs (https://) are not checked."""
        (tmp_path / "README.md").write_text(
            "See [Google](https://google.com) and [anchor](#section).\n",
            encoding="utf-8",
        )
        result = run_script("validate-links.py", cwd=tmp_path)
        assert result.returncode == 0

    def test_archive_exclusion(self, tmp_path):
        """Files in history/archive/ are excluded from scanning."""
        archive = tmp_path / "history" / "archive"
        archive.mkdir(parents=True)
        (archive / "old.md").write_text(
            "See [gone](deleted.md).\n", encoding="utf-8"
        )
        result = run_script(
            "validate-links.py", cwd=tmp_path, env={"LINK_CHECK_STRICT": "1"}
        )
        assert result.returncode == 0

    def test_strict_flag_argv(self, tmp_path):
        """--strict flag via argv triggers non-zero exit on broken links."""
        (tmp_path / "doc.md").write_text(
            "See [nope](nope.md).\n", encoding="utf-8"
        )
        script = REPO_ROOT / "scripts" / "validate-links.py"
        result = subprocess.run(
            [sys.executable, str(script), "--strict"],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            timeout=30,
        )
        assert result.returncode == 1
        assert "errors" in result.stdout.lower()


# ===========================================================================
# change:init via task CLI
# ===========================================================================

@requires_task
class TestChangeInit:
    """Tests for tasks/change.yml change:init task."""

    def test_correct_directory_structure(self, tmp_path):
        """change:init creates proposal.md, design.md, tasks.vbrief.json, specs/."""
        # Set up minimal Taskfile that includes change.yml
        taskfile = (
            "version: '3'\n"
            "includes:\n"
            "  change:\n"
            f"    taskfile: {REPO_ROOT / 'tasks' / 'change.yml'}\n"
        )
        (tmp_path / "Taskfile.yml").write_text(taskfile, encoding="utf-8")
        (tmp_path / "history" / "changes").mkdir(parents=True)

        result = subprocess.run(
            ["task", "change:change:init", "--", "test-feature"],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            timeout=30,
        )
        assert result.returncode == 0, f"Unexpected failure: {result.stderr}"
        base = tmp_path / "history" / "changes" / "test-feature"
        assert base.is_dir()
        assert (base / "proposal.md").is_file()
        assert (base / "design.md").is_file()
        assert (base / "tasks.vbrief.json").is_file()
        assert (base / "specs").is_dir()

        # Verify vBRIEF structure
        vbrief = json.loads((base / "tasks.vbrief.json").read_text("utf-8"))
        assert vbrief["vBRIEFInfo"]["version"] == "0.5"
        assert vbrief["plan"]["title"] == "test-feature"

    def test_path_traversal_rejected(self, tmp_path):
        """Names with path traversal characters are rejected."""
        taskfile = (
            "version: '3'\n"
            "includes:\n"
            "  change:\n"
            f"    taskfile: {REPO_ROOT / 'tasks' / 'change.yml'}\n"
        )
        (tmp_path / "Taskfile.yml").write_text(taskfile, encoding="utf-8")
        (tmp_path / "history" / "changes").mkdir(parents=True)

        result = subprocess.run(
            ["task", "change:change:init", "--", "../escape"],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            timeout=30,
        )
        assert result.returncode != 0

    def test_empty_name_rejected(self, tmp_path):
        """Empty name prints usage and exits non-zero."""
        taskfile = (
            "version: '3'\n"
            "includes:\n"
            "  change:\n"
            f"    taskfile: {REPO_ROOT / 'tasks' / 'change.yml'}\n"
        )
        (tmp_path / "Taskfile.yml").write_text(taskfile, encoding="utf-8")
        (tmp_path / "history" / "changes").mkdir(parents=True)

        result = subprocess.run(
            ["task", "change:change:init"],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            timeout=30,
        )
        assert result.returncode != 0

    def test_duplicate_handling(self, tmp_path):
        """Creating a change with an existing name fails."""
        taskfile = (
            "version: '3'\n"
            "includes:\n"
            "  change:\n"
            f"    taskfile: {REPO_ROOT / 'tasks' / 'change.yml'}\n"
        )
        (tmp_path / "Taskfile.yml").write_text(taskfile, encoding="utf-8")
        (tmp_path / "history" / "changes" / "dupe").mkdir(parents=True)

        result = subprocess.run(
            ["task", "change:change:init", "--", "dupe"],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            timeout=30,
        )
        assert result.returncode != 0
        combined = result.stdout + result.stderr
        assert "already exists" in combined.lower()


# ===========================================================================
# commit:lint via task CLI
# ===========================================================================

@requires_task
class TestCommitLint:
    """Tests for tasks/commit.yml commit:lint task."""

    def _setup_repo(self, tmp_path: Path, message: str) -> None:
        """Create a git repo with one commit using the given message."""
        subprocess.run(["git", "init"], cwd=str(tmp_path), capture_output=True, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=str(tmp_path), capture_output=True, check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=str(tmp_path), capture_output=True, check=True,
        )
        (tmp_path / "f.txt").write_text("x", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=str(tmp_path), capture_output=True, check=True)
        subprocess.run(
            ["git", "commit", "-m", message],
            cwd=str(tmp_path), capture_output=True, check=True,
        )

    def _run_commit_lint(self, tmp_path: Path) -> subprocess.CompletedProcess:
        """Run commit:lint task in a temp directory."""
        taskfile = (
            "version: '3'\n"
            "includes:\n"
            "  commit:\n"
            f"    taskfile: {REPO_ROOT / 'tasks' / 'commit.yml'}\n"
        )
        (tmp_path / "Taskfile.yml").write_text(taskfile, encoding="utf-8")
        return subprocess.run(
            ["task", "commit:commit:lint"],
            capture_output=True,
            text=True,
            cwd=str(tmp_path),
            timeout=30,
        )

    def test_valid_conventional_commit_passes(self, tmp_path):
        """A valid conventional commit message passes lint."""
        self._setup_repo(tmp_path, "feat(auth): add login endpoint")
        result = self._run_commit_lint(tmp_path)
        assert result.returncode == 0

    def test_missing_type_fails(self, tmp_path):
        """Commit message without a type prefix fails lint."""
        self._setup_repo(tmp_path, "add login endpoint")
        result = self._run_commit_lint(tmp_path)
        assert result.returncode != 0

    def test_breaking_change_format_supported(self, tmp_path):
        """Breaking change indicator (!) is accepted."""
        self._setup_repo(tmp_path, "feat(api)!: remove deprecated endpoint")
        result = self._run_commit_lint(tmp_path)
        assert result.returncode == 0

    def test_all_valid_types_accepted(self, tmp_path):
        """All conventional commit types are accepted."""
        valid_types = (
            "feat", "fix", "docs", "chore", "refactor",
            "test", "style", "perf", "ci", "build", "revert",
        )
        for ctype in valid_types:
            self._setup_repo(tmp_path, f"{ctype}: valid message")
            result = self._run_commit_lint(tmp_path)
            assert result.returncode == 0, (
                f"Type '{ctype}' should pass but got rc={result.returncode}"
            )
            # Reset for next iteration
            (tmp_path / "f.txt").write_text(ctype, encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=str(tmp_path), capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", f"{ctype}: valid message"],
                cwd=str(tmp_path), capture_output=True,
            )
