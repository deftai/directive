"""tests/relocate/test_preflight.py -- pre-flight ``--force`` gate (#992 PR2).

Owned by acceptance criterion ``992-ac-2-pr2-relocator`` on the active scope
vBRIEF (filename split for line-length compliance):
``vbrief/active/2026-05-10-992-adopt-deftcore-as-canonical-
install-layout-ship-relocator-an.vbrief.json``.

Active vBRIEF ``Constraint`` narrative:

> PRE-FLIGHT HARD-FAILS: relocator MUST refuse without ``--force`` when (a)
> framework dir is git-tracked and customized (print preserved-files
> list), OR (b) any ``vbrief/active/*.vbrief.json`` has
> ``plan.status == "running"`` (active swarm work).

These tests assert the wrapper-level CLI exit codes (1 / 0 / 2) using
``relocate.main(argv)`` rather than ``pytest.raises(SystemExit)`` because
:func:`scripts.relocate.main` returns the exit integer directly (it
doesn't call ``sys.exit`` itself; the ``__main__`` shim does). The
contract -- hard-fail without ``--force``, succeed with ``--force`` --
is identical either way.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "relocate.py"


def _load_relocate() -> Any:
    if "relocate" in sys.modules:
        return sys.modules["relocate"]
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("relocate", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["relocate"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def relocate() -> Any:
    return _load_relocate()


def _build_framework_source(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "templates").mkdir(parents=True, exist_ok=True)
    (root / "templates" / "agents-entry.md").write_text(
        "<!-- deft:managed-section v2 -->\n"
        "# Deft -- AI Development Framework\n"
        "\n"
        "Test fixture template.\n"
        "<!-- /deft:managed-section -->\n",
        encoding="utf-8",
    )
    (root / "main.md").write_text("# main.md sentinel\n", encoding="utf-8")
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "fixture_helper.py").write_text("# noop\n", encoding="utf-8")
    return root


@pytest.fixture()
def framework_source(tmp_path: Path) -> Path:
    return _build_framework_source(tmp_path / "fresh-deft")


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    root = tmp_path / "consumer"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _populate_canonical(project_root: Path, framework_source: Path) -> None:
    target = project_root / ".deft" / "core"
    target.mkdir(parents=True, exist_ok=True)
    for src in framework_source.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(framework_source)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def _seed_active_swarm(project_root: Path) -> Path:
    """Drop a vbrief/active/*.vbrief.json with plan.status=running."""
    active = project_root / "vbrief" / "active"
    active.mkdir(parents=True, exist_ok=True)
    payload = active / "fixture-running.vbrief.json"
    payload.write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"id": "fixture-active", "status": "running"},
            }
        ),
        encoding="utf-8",
    )
    return payload


def _seed_customization(project_root: Path) -> Path:
    """Drop a sentinel marker that signals state-E customization."""
    canonical = project_root / ".deft" / "core"
    canonical.mkdir(parents=True, exist_ok=True)
    sentinel = canonical / ".deft-customized"
    sentinel.write_text("operator local edit\n", encoding="utf-8")
    return sentinel


# ---------------------------------------------------------------------------
# Plan-level gate (the unit boundary the CLI delegates to)
# ---------------------------------------------------------------------------


class TestPlanForceGate:
    """``RelocatePlan.needs_force`` correctly reports the gate state."""

    def test_no_gate_on_clean_legacy_install(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        # Clean legacy install -- no customization, no swarm. Gate OFF.
        target = project_root / "deft"
        target.mkdir(parents=True, exist_ok=True)
        for src in framework_source.rglob("*"):
            if src.is_file():
                rel = src.relative_to(framework_source)
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(src.read_bytes())
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        assert plan.needs_force is False, "clean state should not need --force"
        assert plan.framework_customized is False
        assert plan.active_swarm is False

    def test_gate_fires_on_customized_framework_without_force(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _populate_canonical(project_root, framework_source)
        sentinel = _seed_customization(project_root)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        assert plan.framework_customized is True
        assert plan.needs_force is True
        assert any(
            sentinel.name in p for p in plan.customization_paths
        ), "preserved-files list missing the sentinel"

    def test_gate_clears_with_force_on_customized_framework(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _populate_canonical(project_root, framework_source)
        _seed_customization(project_root)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source, force=True
        )
        assert plan.framework_customized is True, "customization probe must still fire"
        assert plan.needs_force is False, "--force must clear the gate"

    def test_gate_fires_on_active_swarm_without_force(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _populate_canonical(project_root, framework_source)
        seeded = _seed_active_swarm(project_root)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        assert plan.active_swarm is True
        assert plan.needs_force is True
        assert any(
            seeded.name in p for p in plan.active_swarm_paths
        ), "active_swarm_paths list missing the seeded vBRIEF"

    def test_gate_clears_with_force_on_active_swarm(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _populate_canonical(project_root, framework_source)
        _seed_active_swarm(project_root)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source, force=True
        )
        assert plan.active_swarm is True, "swarm probe must still fire"
        assert plan.needs_force is False, "--force must clear the gate"


# ---------------------------------------------------------------------------
# CLI-level gate (the operator-facing surface)
# ---------------------------------------------------------------------------


def _run_cli(
    relocate: Any,
    project_root: Path,
    framework_source: Path,
    *extra_argv: str,
) -> int:
    return relocate.main(
        [
            "--project-root",
            str(project_root),
            "--framework-source",
            str(framework_source),
            *extra_argv,
        ]
    )


class TestCliForceGate:
    """``relocate.main`` honours the gate at exit-code level."""

    def test_main_exits_failure_on_active_swarm_without_force(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        _populate_canonical(project_root, framework_source)
        _seed_active_swarm(project_root)
        rc = _run_cli(
            relocate,
            project_root,
            framework_source,
            "--confirm",
            "--no-snapshot",
            "--quiet",
        )
        assert rc == relocate.EXIT_FAILURE
        captured = capsys.readouterr()
        assert "preflight hard-fail" in captured.err
        assert "active swarm" in captured.err

    def test_main_exits_failure_on_customized_framework_without_force(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        _populate_canonical(project_root, framework_source)
        _seed_customization(project_root)
        rc = _run_cli(
            relocate,
            project_root,
            framework_source,
            "--confirm",
            "--no-snapshot",
            "--quiet",
        )
        assert rc == relocate.EXIT_FAILURE
        captured = capsys.readouterr()
        assert "preflight hard-fail" in captured.err
        assert "customized" in captured.err
        # The preserved-files list should appear in the error body so the
        # operator can inspect it before re-running with --force.
        assert ".deft-customized" in captured.err

    def test_main_succeeds_on_active_swarm_with_force(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
    ) -> None:
        _populate_canonical(project_root, framework_source)
        _seed_active_swarm(project_root)
        rc = _run_cli(
            relocate,
            project_root,
            framework_source,
            "--force",
            "--confirm",
            "--no-snapshot",
            "--quiet",
        )
        assert rc == relocate.EXIT_SUCCESS

    def test_main_succeeds_on_customized_framework_with_force(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
    ) -> None:
        _populate_canonical(project_root, framework_source)
        _seed_customization(project_root)
        rc = _run_cli(
            relocate,
            project_root,
            framework_source,
            "--force",
            "--confirm",
            "--no-snapshot",
            "--quiet",
        )
        assert rc == relocate.EXIT_SUCCESS

    def test_dry_run_skips_gate_enforcement_and_returns_zero(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
    ) -> None:
        # --dry-run reports the plan and exits 0 even when the gate would
        # normally fire -- tests the operator-facing introspection path.
        _populate_canonical(project_root, framework_source)
        _seed_active_swarm(project_root)
        rc = _run_cli(
            relocate,
            project_root,
            framework_source,
            "--dry-run",
            "--quiet",
        )
        assert rc == relocate.EXIT_SUCCESS
        # No mutation: snapshot dir not created, AGENTS.md untouched.
        assert not (project_root / ".deft-cache").exists()


class TestCliEdgeCases:
    """CLI surface edge cases: missing framework source, inside-wipe-target self-detect."""

    def test_main_exits_config_error_when_framework_source_missing(
        self,
        relocate: Any,
        project_root: Path,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        bogus = tmp_path / "nonexistent-fresh-deft"
        rc = _run_cli(
            relocate,
            project_root,
            bogus,
            "--confirm",
            "--no-snapshot",
            "--quiet",
        )
        assert rc == relocate.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "is not a directory" in captured.err

    def test_main_returns_success_on_canonical_project_no_op(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
    ) -> None:
        _populate_canonical(project_root, framework_source)
        relocate.regenerate_agents_md(project_root, framework_source)
        rc = _run_cli(
            relocate,
            project_root,
            framework_source,
            "--confirm",
            "--no-snapshot",
            "--quiet",
        )
        assert rc == relocate.EXIT_SUCCESS
