"""
Guard-rail test for #578.

Ensures that any ``SKILL.md`` across the repo which declares an ``os:``
frontmatter key lists ALL three currently-supported operating systems:
``darwin``, ``linux``, and ``windows``.

Background
----------

``deft/SKILL.md`` originally declared ``os: ["darwin", "linux"]`` in its
YAML frontmatter, omitting ``"windows"``.  That metadata contradicted
observable framework behaviour:

* ``#568`` added a ``windows-task-dispatch`` CI matrix job on
  ``windows-latest``.
* Multiple skills (``deft-directive-setup``, ``deft-directive-build``,
  ...) carry explicit Platform Detection sections that resolve Windows
  paths (e.g. ``%APPDATA%\\deft\\USER.md``).
* ``scripts/migrate_vbrief.py`` handles Windows-specific concerns
  (CRLF, ``.gitignore`` append on Windows projects, ...).
* RC3 validation (``MScottAdams/slizard-rc3-test``) ran the full deft
  consumer migration on Windows 11 + pwsh 5.1.

Depending on how the clawdbot skill loader interprets this field, a
missing ``"windows"`` entry risks silently filtering deft out for
Windows consumers.  The fix in #578 adds ``"windows"`` to the array
(Option A, preferred) or removes the field entirely (Option B).

Invariants enforced
-------------------

This module enforces two invariants via parametrized tests:

1. ``test_skill_os_frontmatter_includes_all_supported_oses`` -- every
   ``SKILL.md`` whose YAML frontmatter contains an ``os:`` key MUST
   list all of ``darwin``, ``linux``, and ``windows`` in the array.
   Files that omit the key entirely (Option B) are exempt.
2. ``test_skill_frontmatter_discovery_found_files`` -- sanity check:
   the ``SKILL.md`` discovery glob must find at least one candidate
   file.  Guards against a silent glob regression that would make the
   first test trivially pass on zero parametrized inputs.

The guard-rail style mirrors ``test_taskfile_paths.py`` (added in
``#568``): discover all candidate files, parametrize one test per file,
assert the invariant with a helpful failure message.

See:
  - deftai/directive#578 -- root issue
  - deft/SKILL.md -- the file originally missing ``"windows"``
  - tests/content/test_taskfile_paths.py -- sibling guard-rail pattern
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Supported operating systems.  If deft ever adds a new supported OS
# (e.g. BSD), extend this set -- the test will then require every
# ``os:``-declaring ``SKILL.md`` to include it.
REQUIRED_OSES: frozenset[str] = frozenset({"darwin", "linux", "windows"})

# Match ``os: [...]`` on its own line within the YAML frontmatter.
# The frontmatter spans from the first ``---`` line to the second
# ``---`` line at the top of the file.  We match ``os:`` anchored to
# the start of a line so we don't pick up incidental ``os:`` mentions
# inside fenced code blocks or prose lower in the document.
_OS_LINE = re.compile(
    r"^os\s*:\s*\[(?P<body>[^\]]*)\]\s*$",
    re.MULTILINE,
)

# Match a quoted (single or double) OS token inside the array body.
_OS_TOKEN = re.compile(r"""['"]([^'"]+)['"]""")


def _frontmatter(text: str) -> str | None:
    """Return the YAML frontmatter block of ``text`` (between the first
    two ``---`` lines) or ``None`` if no frontmatter is present.

    ``SKILL.md`` files follow the AgentSkills convention of a
    YAML-fronted markdown document.  Restricting the ``os:`` match to
    the frontmatter avoids false positives from prose such as ``"os:
    linux"`` appearing in examples or code blocks.
    """
    if not text.startswith("---"):
        return None
    # Find the closing ``---`` line after the opening fence.
    closing = re.search(r"^---\s*$", text[3:], re.MULTILINE)
    if closing is None:
        return None
    return text[3 : 3 + closing.start()]


def _skill_md_files() -> list[Path]:
    """Discover every ``SKILL.md`` in the repo.

    Walks the repository root, excluding ``.git`` and common virtualenv
    directories to keep the scan cheap and deterministic.  Includes the
    root ``SKILL.md`` and every ``skills/*/SKILL.md`` (and any nested
    ``.agents/skills/*/SKILL.md`` if present).
    """
    excluded_parts = {".git", ".venv", "venv", "node_modules", "__pycache__"}
    results: list[Path] = []
    for path in REPO_ROOT.rglob("SKILL.md"):
        if any(part in excluded_parts for part in path.parts):
            continue
        results.append(path)
    return sorted(results)


def _parse_os_array(frontmatter: str) -> list[str] | None:
    """Extract the ``os:`` array tokens from ``frontmatter``.

    Returns a list of OS strings (e.g. ``["darwin", "linux"]``) if the
    key is present, or ``None`` if the ``os:`` key is absent.  Quoting
    style (single vs double) is tolerated.
    """
    match = _OS_LINE.search(frontmatter)
    if match is None:
        return None
    body = match.group("body")
    return _OS_TOKEN.findall(body)


_ALL_SKILLS = _skill_md_files()
_SKILLS_WITH_OS = [
    path
    for path in _ALL_SKILLS
    if (fm := _frontmatter(path.read_text(encoding="utf-8"))) is not None
    and _parse_os_array(fm) is not None
]


@pytest.mark.parametrize(
    "skill_path",
    _SKILLS_WITH_OS,
    ids=lambda p: str(p.relative_to(REPO_ROOT)),
)
def test_skill_os_frontmatter_includes_all_supported_oses(
    skill_path: Path,
) -> None:
    """Every ``SKILL.md`` that declares ``os:`` MUST include darwin,
    linux, AND windows -- see #578.

    Rationale: deft ships Windows CI (``windows-task-dispatch``,
    #568) and Windows-specific path resolution in multiple skills;
    declaring a narrower ``os`` array mis-reports the framework's
    platform support to skill loaders (clawdbot) and humans alike.
    Files that omit the ``os:`` key entirely (Option B from #578)
    are not exercised by this parametrization.
    """
    text = skill_path.read_text(encoding="utf-8")
    frontmatter = _frontmatter(text)
    assert frontmatter is not None, (
        f"{skill_path.relative_to(REPO_ROOT)} was selected for the os-array "
        f"check but has no YAML frontmatter -- discovery is inconsistent."
    )
    tokens = _parse_os_array(frontmatter)
    assert tokens is not None, (
        f"{skill_path.relative_to(REPO_ROOT)} was selected for the os-array "
        f"check but no os: key was found on re-parse -- discovery is "
        f"inconsistent."
    )
    missing = REQUIRED_OSES - set(tokens)
    assert not missing, (
        f"{skill_path.relative_to(REPO_ROOT)} declares os: {tokens!r} which "
        f"is missing {sorted(missing)!r}. Either add the missing OS(es) to "
        f"the array or drop the os: key entirely (see #578, Option B)."
    )


def test_skill_frontmatter_discovery_found_files() -> None:
    """Sanity-check: the discovery glob finds at least one ``SKILL.md``.

    Without this, a refactor that moves or renames every ``SKILL.md``
    would make :func:`test_skill_os_frontmatter_includes_all_supported_oses`
    trivially pass on zero parametrized inputs.
    """
    assert _ALL_SKILLS, (
        f"No SKILL.md files discovered under {REPO_ROOT}; the guard-rail "
        f"in tests/content/test_skill_frontmatter.py cannot enforce "
        f"anything on an empty set."
    )
