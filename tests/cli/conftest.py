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


@pytest.fixture
def isolated_env_no_user(
    tmp_project_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Wire the standard CLI test env (DEFT_USER_PATH / DEFT_PROJECT_PATH /
    DEFT_VBRIEF_PROPOSED + chdir) WITHOUT pre-creating USER.md.

    This is the canonical env-wiring fixture in tests/cli/. The sibling
    `isolated_env` builds on top of it by additionally writing a minimal
    USER.md so cmd_spec / cmd_project happy-path tests don't trip the
    #163 gate. Routing both paths through one wiring point eliminates
    the dual-maintenance hazard Greptile P2 on PR #753 flagged: a future
    env var addition only needs to happen here, not in two places.

    Use `isolated_env_no_user` directly in tests that exercise the
    USER.md presence gate (`tests/cli/test_usermd_gate.py`) or that
    need to assert behavior when USER.md is absent
    (`test_project_user_defaults.py::test_read_user_defaults_returns_none_when_missing`,
    `test_project_user_defaults.py::test_project_blocks_when_user_md_missing`,
    every `cmd_bootstrap` test in `test_bootstrap.py` / `test_resume.py` /
    `test_loop_bugs.py` since cmd_bootstrap writes USER.md as its primary
    behavior under test).
    """
    user_md = tmp_project_dir / "USER.md"
    project_json = tmp_project_dir / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    vbrief_proposed = tmp_project_dir / "vbrief" / "proposed"
    monkeypatch.setenv("DEFT_USER_PATH", str(user_md))
    monkeypatch.setenv("DEFT_PROJECT_PATH", str(project_json))
    monkeypatch.setenv("DEFT_VBRIEF_PROPOSED", str(vbrief_proposed))
    monkeypatch.chdir(tmp_project_dir)
    return tmp_project_dir


@pytest.fixture
def isolated_env(isolated_env_no_user: Path) -> Path:
    """CLI-scoped override that pre-creates USER.md to satisfy the #163 gate.

    Composes `isolated_env_no_user` (the canonical env-wiring fixture)
    and writes a minimal USER.md at `$DEFT_USER_PATH`. The base fixture
    in tests/conftest.py only wires env vars and chdir; this override
    extends it so existing CLI tests (cmd_spec / cmd_project happy paths
    in test_cmd_spec.py, test_project.py, test_spec_sizing.py,
    test_loop_bugs.py::test_project_*, test_project_user_defaults.py)
    keep passing without per-test edits.

    Tests that need USER.md absent should use `isolated_env_no_user`
    directly.
    """
    user_md = isolated_env_no_user / "USER.md"
    user_md.write_text(_MINIMAL_USER_MD, encoding="utf-8")
    return isolated_env_no_user


# ---------------------------------------------------------------------------
# #801: disable the periodic remote-version probe in CLI tests by default.
# ---------------------------------------------------------------------------
#
# The probe (run::_maybe_emit_remote_drift_warning) shells out to `git
# ls-remote --tags --refs <upstream>` against the framework's upstream
# remote. That is the correct behavior in production, but during the test
# suite it would (a) introduce a real network round-trip per `_check_upgrade_gate`
# call site that traverses past the early returns, and (b) potentially
# emit `framework:remote-drift` events in test runs that did not opt in.
# This autouse fixture replaces the helper with a no-op for every CLI test
# unless the test explicitly monkeypatches it back. The dedicated #801
# tests (`test_cmd_check_updates.py`, `test_remote_probe_throttle.py`,
# `test_upgrade_gate_remote_drift.py`) call the probe primitives
# (`_run_remote_probe`, `_maybe_emit_remote_drift_warning`) directly with
# their own `subprocess.run` mocks and are unaffected by this default.
@pytest.fixture(autouse=True)
def _disable_remote_probe(
    deft_run_module, monkeypatch: pytest.MonkeyPatch  # noqa: ANN001
) -> None:
    """Replace `_maybe_emit_remote_drift_warning` with a no-op by default.

    Tests that need the real helper restore it via
    ``monkeypatch.setattr(deft_run_module, "_maybe_emit_remote_drift_warning",
    deft_run_module._real_maybe_emit_remote_drift_warning)``. The original
    function is captured once on the first invocation and stashed on the
    module under ``_real_maybe_emit_remote_drift_warning`` so the
    monkeypatch loop does not lose it across tests.

    The session-level dedup flag ``_PROBE_NOTIFIED_THIS_SESSION`` is also
    reset to ``False`` so each test starts with a clean session-dedup
    state.
    """
    if not hasattr(deft_run_module, "_real_maybe_emit_remote_drift_warning"):
        # Capture the genuine implementation BEFORE monkeypatch replaces it.
        deft_run_module._real_maybe_emit_remote_drift_warning = (
            deft_run_module._maybe_emit_remote_drift_warning
        )
    monkeypatch.setattr(
        deft_run_module,
        "_maybe_emit_remote_drift_warning",
        lambda project_root: None,
        raising=False,
    )
    monkeypatch.setattr(
        deft_run_module,
        "_PROBE_NOTIFIED_THIS_SESSION",
        False,
        raising=False,
    )
