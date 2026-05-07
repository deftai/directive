"""
test_prd_render.py -- Subprocess-based tests for scripts/prd_render.py.

Verifies:
  - PRD.md generation from specification.vbrief.json
  - Narrative key ordering
  - Missing spec file error handling
  - Empty narratives warning
  - Auto-generated banner present
  - Custom --spec and --output paths

Author: agent1 -- 2026-04-13
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPT = _REPO_ROOT / "scripts" / "prd_render.py"


def _run_prd_render(*args: str) -> subprocess.CompletedProcess[str]:
    """Run prd_render.py with the given arguments."""
    return subprocess.run(
        [sys.executable, str(_SCRIPT), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )


def _write_spec(tmp_path: Path, narratives: dict[str, str], title: str = "Test Project") -> Path:
    """Write a minimal specification.vbrief.json to tmp_path."""
    spec = {
        "vBRIEFInfo": {"version": "0.5"},
        "plan": {
            "title": title,
            "status": "draft",
            "narratives": narratives,
            "items": [],
        },
    }
    spec_path = tmp_path / "specification.vbrief.json"
    spec_path.write_text(json.dumps(spec, indent=2), encoding="utf-8")
    return spec_path


# ---------------------------------------------------------------------------
# 1. Basic PRD generation
# ---------------------------------------------------------------------------


def test_prd_render_basic(tmp_path: Path) -> None:
    """prd_render.py produces PRD.md from a valid specification."""
    spec_path = _write_spec(tmp_path, {
        "Overview": "A test project",
        "Architecture": "Monolith",
    })
    output_path = tmp_path / "PRD.md"

    result = _run_prd_render("--spec", str(spec_path), "--output", str(output_path))
    assert result.returncode == 0, f"prd_render.py failed: {result.stderr}"
    assert output_path.is_file(), "PRD.md not created"

    content = output_path.read_text(encoding="utf-8")
    assert "Test Project" in content
    assert "## Overview" in content
    assert "A test project" in content
    assert "## Architecture" in content


# ---------------------------------------------------------------------------
# 2. Auto-generated banner
# ---------------------------------------------------------------------------


def test_prd_render_banner(tmp_path: Path) -> None:
    """PRD.md must start with auto-generated banner."""
    spec_path = _write_spec(tmp_path, {"Overview": "Test"})
    output_path = tmp_path / "PRD.md"

    _run_prd_render("--spec", str(spec_path), "--output", str(output_path))
    content = output_path.read_text(encoding="utf-8")
    assert "AUTO-GENERATED" in content
    assert "DO NOT EDIT" in content
    assert "specification.vbrief.json" in content


# ---------------------------------------------------------------------------
# 3. Narrative key ordering
# ---------------------------------------------------------------------------


def test_prd_render_key_ordering(tmp_path: Path) -> None:
    """Narratives must be rendered in the canonical order."""
    spec_path = _write_spec(tmp_path, {
        "Architecture": "Microservices",
        "Overview": "My project",
        "ProblemStatement": "Users need X",
        "Goals": "Deliver Y",
        "ZExtra": "Extra content",
    })
    output_path = tmp_path / "PRD.md"

    _run_prd_render("--spec", str(spec_path), "--output", str(output_path))
    content = output_path.read_text(encoding="utf-8")

    # Ordered keys should appear before extra keys
    overview_pos = content.find("## Overview")
    problem_pos = content.find("## ProblemStatement")
    goals_pos = content.find("## Goals")
    arch_pos = content.find("## Architecture")
    extra_pos = content.find("## ZExtra")

    assert overview_pos < problem_pos < goals_pos < arch_pos < extra_pos, (
        "Narrative keys not in canonical order"
    )


# ---------------------------------------------------------------------------
# 4. Missing spec file
# ---------------------------------------------------------------------------


def test_prd_render_missing_spec(tmp_path: Path) -> None:
    """prd_render.py must exit with error when spec file is missing."""
    result = _run_prd_render(
        "--spec", str(tmp_path / "nonexistent.json"),
        "--output", str(tmp_path / "PRD.md"),
    )
    assert result.returncode != 0
    assert "not found" in result.stderr.lower()


# ---------------------------------------------------------------------------
# 5. Empty narratives warning
# ---------------------------------------------------------------------------


def test_prd_render_empty_narratives(tmp_path: Path) -> None:
    """prd_render.py must warn when narratives dict is empty."""
    spec_path = _write_spec(tmp_path, {})
    output_path = tmp_path / "PRD.md"

    result = _run_prd_render("--spec", str(spec_path), "--output", str(output_path))
    assert result.returncode == 0
    assert "no narratives" in result.stderr.lower()


# ---------------------------------------------------------------------------
# 6. Full path narratives
# ---------------------------------------------------------------------------


def test_prd_render_full_path_narratives(tmp_path: Path) -> None:
    """All 7 rich narrative keys from Full path should render correctly."""
    narratives = {
        "Overview": "Brief summary",
        "ProblemStatement": "Users struggle with X",
        "Goals": "Improve Y by Z",
        "UserStories": "As a user, I want...",
        "Requirements": "FR-1: ...\nNFR-1: ...",
        "SuccessMetrics": "90% user satisfaction",
        "Architecture": "Event-driven microservices",
    }
    spec_path = _write_spec(tmp_path, narratives)
    output_path = tmp_path / "PRD.md"

    result = _run_prd_render("--spec", str(spec_path), "--output", str(output_path))
    assert result.returncode == 0

    content = output_path.read_text(encoding="utf-8")
    for key in narratives:
        assert f"## {key}" in content, f"Missing section: {key}"
        assert narratives[key] in content, f"Missing content for: {key}"


# ---------------------------------------------------------------------------
# 7. Footer present
# ---------------------------------------------------------------------------


def test_prd_render_footer(tmp_path: Path) -> None:
    """PRD.md must end with a footer noting it is auto-generated."""
    spec_path = _write_spec(tmp_path, {"Overview": "Test"})
    output_path = tmp_path / "PRD.md"

    _run_prd_render("--spec", str(spec_path), "--output", str(output_path))
    content = output_path.read_text(encoding="utf-8")
    assert "auto-generated" in content.lower()
    assert "task prd:render" in content


# ---------------------------------------------------------------------------
# 8. #573 -- refuse-to-overwrite + --force recovery (regression)
# ---------------------------------------------------------------------------
#
# Background: #539 added the refuse-to-overwrite safety check that exits
# with code 2 when the target PRD.md lacks the auto-generated banner
# (likely hand-authored). The error message advises
# ``Re-run with --force to overwrite``. Issue #573 reported that
# ``task prd:render -- --force`` silently no-op'd because go-task's
# ``sources:`` / ``generates:`` cache layer short-circuited the task
# before CLI_ARGS reached the script. #574 dropped sources/generates from
# ``tasks/prd.yml``, restoring the recovery path. These tests pin the
# end-to-end script-level behaviour so a future caching reintroduction
# in ``tasks/prd.yml`` cannot silently regress the recovery contract.


def test_prd_render_refuses_to_overwrite_without_force(tmp_path: Path) -> None:
    """#539: refuse to overwrite a PRD.md that lacks the auto-generated banner.

    Pre-stages a hand-authored PRD.md (no banner). Without ``--force`` the
    script exits with code 2 and surfaces the canonical recovery hint.
    """
    spec_path = _write_spec(tmp_path, {"Overview": "Test"})
    output_path = tmp_path / "PRD.md"
    output_path.write_text(
        "# Hand-authored PRD\n\nDo not clobber.\n", encoding="utf-8"
    )

    result = _run_prd_render(
        "--spec", str(spec_path), "--output", str(output_path)
    )
    assert result.returncode == 2, (
        f"expected exit 2 (refuse-to-overwrite); got {result.returncode}; "
        f"stderr={result.stderr!r}"
    )
    assert "refusing to overwrite" in result.stderr.lower()
    # Recovery hint MUST mention --force literally.
    assert "--force" in result.stderr
    # Hand-authored content MUST be preserved byte-for-byte.
    preserved = output_path.read_text(encoding="utf-8")
    assert "Hand-authored PRD" in preserved
    assert "AUTO-GENERATED" not in preserved


def test_prd_render_force_recovery_overwrites_prd(tmp_path: Path) -> None:
    """#573: following the #539 recovery hint (``--force``) overwrites PRD.md.

    Reproduces the original repro:
      1. Stage a hand-authored PRD.md (no banner).
      2. ``prd_render --spec ... --output ...`` -> exit 2 (refuse).
      3. Follow the recovery hint LITERALLY: re-run with ``--force``.
      4. Assert PRD.md is overwritten with a fresh auto-generated artifact.

    The script-level ``--force`` flag is the canonical recovery surface;
    when invoked directly (this test) or via the post-#574 Taskfile entry
    (no caching) the rewrite must succeed. Pre-#574, ``task prd:render --
    --force`` silently no-op'd at the go-task layer; that path is covered
    by ``tests/content/test_taskfile_caching.py`` and the audit note in
    the CHANGELOG entry for #573.
    """
    spec_path = _write_spec(tmp_path, {"Overview": "Replacement content"})
    output_path = tmp_path / "PRD.md"
    output_path.write_text(
        "# Hand-authored PRD\n\nOriginal payload.\n", encoding="utf-8"
    )

    # Step 1: bare invocation refuses.
    refused = _run_prd_render(
        "--spec", str(spec_path), "--output", str(output_path)
    )
    assert refused.returncode == 2

    # Step 2: follow the recovery hint literally with --force.
    forced = _run_prd_render(
        "--spec", str(spec_path), "--output", str(output_path), "--force"
    )
    assert forced.returncode == 0, (
        "--force MUST overwrite a non-generated PRD per #573 recovery "
        f"contract; got returncode={forced.returncode}; "
        f"stderr={forced.stderr!r}"
    )
    # PRD.md is overwritten with the auto-generated banner + spec content.
    overwritten = output_path.read_text(encoding="utf-8")
    assert "AUTO-GENERATED" in overwritten, (
        "after --force recovery PRD.md MUST carry the canonical "
        "auto-generated banner (#572 / #573)"
    )
    assert "Replacement content" in overwritten
    # Original hand-authored payload is gone (force overwrites).
    assert "Original payload." not in overwritten
