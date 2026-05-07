"""test_taskfile_zip_parity.py -- Regression guard for #736.

Asserts that ``tasks/core.yml`` no longer uses the pre-#736 platform-split
archive shape:

- linux/darwin: ``tar -czf dist/deft-{{.VERSION}}.tar.gz --exclude=...``
- windows: ``Compress-Archive -Path . -DestinationPath dist\\deft-...zip -Force``

The fix replaces that duplicated structure with a single cross-platform
Python helper dispatch:

    uv run python "{{.DEFT_ROOT}}/scripts/build_dist.py" --version "{{.VERSION}}"

This module intentionally uses stdlib-only text parsing (regex + line
scanning) rather than PyYAML so it runs on every lane without introducing
an extra test dependency. The workflow mirrors sibling guard-rail tests
such as ``tests/content/test_release_workflow.py`` and
``tests/content/test_taskfile_caching.py``.

Refs #736.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CORE_YML = REPO_ROOT / "tasks" / "core.yml"

_TASK_HEADER = re.compile(r"^  ([A-Za-z_][\w:-]*)\s*:\s*(?:#.*)?$")


def _core_text() -> str:
    text = CORE_YML.read_text(encoding="utf-8")
    assert text.strip(), f"{CORE_YML} is empty"
    return text


def _task_block(task_name: str) -> str:
    """Return the raw YAML block for ``task_name`` under top-level tasks:.

    The block runs from the task header line up to (but not including) the
    next sibling task header at the same indentation. End-of-file closes
    the last block.
    """
    lines = _core_text().splitlines()
    in_tasks = False
    start: int | None = None
    for idx, line in enumerate(lines):
        if line == "tasks:":
            in_tasks = True
            continue
        if in_tasks and line and not line.startswith(" "):
            break
        if not in_tasks:
            continue
        match = _TASK_HEADER.match(line)
        if match is None:
            continue
        name = match.group(1)
        if start is None and name == task_name:
            start = idx
            continue
        if start is not None:
            return "\n".join(lines[start:idx])
    assert start is not None, f"tasks/core.yml::{task_name} is missing"
    return "\n".join(lines[start:])


def _strip_comments(block: str) -> str:
    """Return ``block`` with whole-line YAML comments removed.

    Comments inside this repo's taskfiles are always whole-line (``    # ...``);
    this lets the regression-guard scan focus on actual command shape rather
    than explanatory prose that intentionally references the OLD shape we are
    guarding against.
    """
    out: list[str] = []
    for line in block.splitlines():
        if line.lstrip().startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


def _cmd_entry_lines(block: str) -> list[str]:
    """Return command-entry lines (``      - ...``) under a cmds: block.

    Comments and blank lines are excluded. Caching-key entries (``sources:``
    / ``generates:``) are also excluded; only actual list items count.
    """
    in_cmds = False
    entries: list[str] = []
    for line in block.splitlines():
        if line.startswith("    cmds:"):
            in_cmds = True
            continue
        if in_cmds and line.startswith("  ") and not line.startswith("      "):
            break
        if in_cmds and line.startswith("      - "):
            entries.append(line)
    return entries


class TestBuildTaskCrossPlatform:
    def test_build_has_no_platform_split(self):
        block = _task_block("build")
        assert "platforms:" not in block, (
            "tasks/core.yml::build regressed to platform-split shape (#736). "
            "Expected a single cross-platform helper dispatch.\n"
            f"build block:\n{block}"
        )

    def test_build_dispatches_python_helper(self):
        block = _task_block("build")
        assert "scripts/build_dist.py" in block, (
            "tasks/core.yml::build no longer dispatches scripts/build_dist.py, "
            "which breaks the #736 cross-platform parity contract.\n"
            f"build block:\n{block}"
        )

    def test_build_has_single_command_entry(self):
        block = _task_block("build")
        entries = _cmd_entry_lines(block)
        assert len(entries) == 1, (
            "tasks/core.yml::build should have exactly one cmds entry after "
            "the #736 simplification.\n"
            f"entries: {entries}\nblock:\n{block}"
        )

    def test_build_no_longer_uses_tar_or_compress_archive(self):
        block = _task_block("build")
        lowered = _strip_comments(block).lower()
        assert "compress-archive" not in lowered, (
            "Windows-specific Compress-Archive resurfaced in build task.\n"
            f"build block:\n{block}"
        )
        assert "tar -czf" not in lowered, (
            "POSIX-specific tar archive command resurfaced in build task.\n"
            f"build block:\n{block}"
        )


class TestCleanTaskCrossPlatform:
    def test_clean_has_no_platform_split(self):
        block = _task_block("clean")
        assert "platforms:" not in block, (
            "tasks/core.yml::clean regressed to platform-split shape. "
            "Expected a single cross-platform command.\n"
            f"clean block:\n{block}"
        )

    def test_clean_has_single_command_entry(self):
        block = _task_block("clean")
        entries = _cmd_entry_lines(block)
        assert len(entries) == 1, (
            "tasks/core.yml::clean should have exactly one cmds entry after "
            "the #736 simplification.\n"
            f"entries: {entries}\nblock:\n{block}"
        )

    def test_clean_no_longer_uses_powershell_or_rm_rf(self):
        block = _task_block("clean")
        lowered = _strip_comments(block).lower()
        assert "powershell" not in lowered, (
            "Windows-only PowerShell cleanup resurfaced in clean task.\n"
            f"clean block:\n{block}"
        )
        assert "rm -rf" not in lowered, (
            "POSIX-only rm -rf resurfaced in clean task.\n"
            f"clean block:\n{block}"
        )
