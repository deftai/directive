"""
tests/cli/conftest.py -- CLI-test scoped pytest fixtures.

Overrides the parent `isolated_env` fixture (defined in tests/conftest.py)
to additionally pre-create a minimal USER.md at the path pointed to by
`$DEFT_USER_PATH`. This keeps existing CLI tests working unchanged after
the USER.md presence gate (#163) was introduced at `cmd_spec` and
`cmd_project` entry points -- without the override every CLI test that
exercised those commands would fail at the gate before reaching the
behavior under test.

Tests that need to assert gate behavior with USER.md absent should use
the sibling `isolated_env_no_user` fixture instead.

Author: Deft Directive agent (msadams) -- 2026-04-29
Refs: #163
"""

from pathlib import Path

import pytest

_MINIMAL_USER_MD = (
    "# User Preferences\n"
    "\n"
    "Legend (from RFC2119): !=MUST, ~=SHOULD, \u2249=SHOULD NOT, \u2297=MUST NOT, ?=MAY.\n"
    "\n"
    "## Personal (always wins)\n"
    "\n"
    "**Name**: Address the user as: **Test User**\n"
    "\n"
    "**Custom Rules**:\n"
    "No custom rules defined yet.\n"
    "\n"
    "## Defaults (fallback)\n"
    "\n"
    "**Primary Languages**:\n"
    "- (None specified)\n"
)


def _wire_env(tmp_project_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Mirror tests/conftest.py:isolated_env env-var wiring exactly.

    Kept in sync with the parent fixture so this override stays a strict
    superset of the base behavior -- env vars and chdir are identical;
    only USER.md creation differs between the two variants.
    """
    user_md = tmp_project_dir / "USER.md"
    project_json = tmp_project_dir / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    vbrief_proposed = tmp_project_dir / "vbrief" / "proposed"
    monkeypatch.setenv("DEFT_USER_PATH", str(user_md))
    monkeypatch.setenv("DEFT_PROJECT_PATH", str(project_json))
    monkeypatch.setenv("DEFT_VBRIEF_PROPOSED", str(vbrief_proposed))
    monkeypatch.chdir(tmp_project_dir)


@pytest.fixture
def isolated_env(tmp_project_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """CLI-scoped override that pre-creates USER.md to satisfy the #163 gate.

    The base fixture in tests/conftest.py only wires env vars and chdir;
    this override additionally writes a minimal USER.md at
    `$DEFT_USER_PATH` so cmd_spec / cmd_project happy-path tests don't
    trip the new presence gate. Tests that need USER.md absent should
    use `isolated_env_no_user` instead.
    """
    _wire_env(tmp_project_dir, monkeypatch)
    user_md = tmp_project_dir / "USER.md"
    user_md.write_text(_MINIMAL_USER_MD, encoding="utf-8")
    return tmp_project_dir


@pytest.fixture
def isolated_env_no_user(
    tmp_project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Variant of `isolated_env` that does NOT pre-create USER.md.

    Use this in tests that exercise the #163 USER.md presence gate or
    that need to assert behavior when USER.md is absent at the resolved
    path. Env vars and chdir match the standard `isolated_env` fixture
    so other path-resolution behavior is unchanged.
    """
    _wire_env(tmp_project_dir, monkeypatch)
    return tmp_project_dir
