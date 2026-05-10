"""tests/relocate/test_state_matrix.py -- state A-G fixture matrix (#992 PR2).

Owned by acceptance criterion ``992-ac-2-pr2-relocator`` on the active scope
vBRIEF (filename split for line-length compliance):
``vbrief/active/2026-05-10-992-adopt-deftcore-as-canonical-
install-layout-ship-relocator-an.vbrief.json``.

Per the active vBRIEF's ``Test`` narrative, the matrix covers:

- **A** -- pure ``deft/`` (legacy install)
- **B** -- pure ``.deft/core/`` (current installer output, marker stale)
- **C** -- hybrid both ``deft/`` and ``.deft/core/`` (broken)
- **D** -- AGENTS.md only (broken partial install)
- **E** -- customized framework dir (preserve-and-warn / state classifier
  flips to ``E``)
- **F** -- missing ``vbrief/`` (greenfield-ish)
- **G** -- active swarm worktree with running ``plan.status`` (hard-fail
  without ``--force`` -- exercised in :mod:`test_preflight`)

Each fixture builds a synthetic project root + framework source under
``tmp_path``, runs the relocator, and asserts the end state:
``.deft/core/`` populated, legacy ``deft/`` removed, AGENTS.md re-rendered
with the v2 marker, ``.gitignore`` updated, snapshot rollback callable.

The synthetic ``framework_source`` is a minimal but realistic deft
checkout (just enough files to exercise the deposit filter + AGENTS.md
re-render). Tests that need state-E customization signals use the
``.deft-customized`` sentinel for deterministic detection.
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
    """Load ``scripts/relocate.py`` once per session via importlib."""
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


# ---------------------------------------------------------------------------
# Synthetic framework source
# ---------------------------------------------------------------------------


def _build_framework_source(root: Path) -> Path:
    """Build a minimal-but-realistic fresh framework deposit under ``root``."""
    root.mkdir(parents=True, exist_ok=True)
    # Minimal templates/agents-entry.md with v2 markers so
    # render_managed_section yields a meaningful block.
    (root / "templates").mkdir(parents=True, exist_ok=True)
    (root / "templates" / "agents-entry.md").write_text(
        "<!-- deft:managed-section v2 -->\n"
        "# Deft -- AI Development Framework\n"
        "\n"
        "Test fixture template.\n"
        "<!-- /deft:managed-section -->\n",
        encoding="utf-8",
    )
    # main.md sentinel + a couple of skill files so the deposit has
    # non-trivial content the test can verify post-relocate.
    (root / "main.md").write_text("# main.md sentinel\n", encoding="utf-8")
    (root / "QUICK-START.md").write_text("# Quick start\n", encoding="utf-8")
    (root / "scripts").mkdir(parents=True, exist_ok=True)
    (root / "scripts" / "fixture_helper.py").write_text("# noop\n", encoding="utf-8")
    (root / "tasks").mkdir(parents=True, exist_ok=True)
    (root / "tasks" / "core.yml").write_text("version: '3'\ntasks: {}\n", encoding="utf-8")
    # vbrief/schemas/ ships in the deposit; vbrief/active/ does NOT.
    (root / "vbrief" / "schemas").mkdir(parents=True, exist_ok=True)
    (root / "vbrief" / "schemas" / "vbrief.schema.json").write_text(
        '{"name": "fixture"}\n', encoding="utf-8"
    )
    (root / "vbrief" / "vbrief.md").write_text("# vbrief template\n", encoding="utf-8")
    return root


@pytest.fixture()
def framework_source(tmp_path: Path) -> Path:
    return _build_framework_source(tmp_path / "fresh-deft")


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    root = tmp_path / "consumer"
    root.mkdir(parents=True, exist_ok=True)
    return root


# ---------------------------------------------------------------------------
# State fixture builders -- one helper per state A through G
# ---------------------------------------------------------------------------


def _populate_legacy(project_root: Path, framework_source: Path) -> None:
    """Materialise an in-place legacy ``deft/`` checkout under project_root."""
    target = project_root / "deft"
    target.mkdir(parents=True, exist_ok=True)
    for src in framework_source.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(framework_source)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def _populate_canonical(project_root: Path, framework_source: Path) -> None:
    """Materialise an in-place canonical ``.deft/core/`` checkout under project_root."""
    target = project_root / ".deft" / "core"
    target.mkdir(parents=True, exist_ok=True)
    for src in framework_source.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(framework_source)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())


def _make_state_a(project_root: Path, framework_source: Path) -> None:
    _populate_legacy(project_root, framework_source)
    (project_root / "AGENTS.md").write_text(
        "# Project AGENTS.md\nLegacy install.\n", encoding="utf-8"
    )
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)


def _make_state_b(project_root: Path, framework_source: Path) -> None:
    _populate_canonical(project_root, framework_source)
    # No managed-section markers -> classifier returns "B".
    (project_root / "AGENTS.md").write_text(
        "# Project AGENTS.md\nNo deft markers yet.\n", encoding="utf-8"
    )
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)


def _make_state_c(project_root: Path, framework_source: Path) -> None:
    _populate_legacy(project_root, framework_source)
    _populate_canonical(project_root, framework_source)
    (project_root / "AGENTS.md").write_text(
        "# Project AGENTS.md\nHybrid install.\n", encoding="utf-8"
    )
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)


def _make_state_d(project_root: Path) -> None:
    (project_root / "AGENTS.md").write_text(
        "# Project AGENTS.md\nPartial install -- no framework dir.\n",
        encoding="utf-8",
    )
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)


def _make_state_e(project_root: Path, framework_source: Path) -> None:
    _populate_canonical(project_root, framework_source)
    # Sentinel signals customization independent of hash compare so tests
    # are deterministic even when the synthetic source is byte-identical.
    (project_root / ".deft" / "core" / ".deft-customized").write_text(
        "operator local edit\n", encoding="utf-8"
    )
    (project_root / "AGENTS.md").write_text("# AGENTS.md\n", encoding="utf-8")
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)


def _make_state_f(project_root: Path) -> None:
    # Empty project root -- no deft, no canonical, no AGENTS.md, no vbrief.
    pass


def _make_state_g(project_root: Path) -> None:
    """Active swarm worktree -- vbrief/active/<scope>.vbrief.json with running plan.status."""
    active = project_root / "vbrief" / "active"
    active.mkdir(parents=True, exist_ok=True)
    (active / "fixture-running.vbrief.json").write_text(
        json.dumps(
            {
                "vBRIEFInfo": {"version": "0.6"},
                "plan": {"id": "fixture", "status": "running"},
            }
        ),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# State classification tests
# ---------------------------------------------------------------------------


class TestStateClassifier:
    """``detect_install_state`` returns the correct primary code per fixture."""

    def test_state_a_classifies_as_a(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_a(project_root, framework_source)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "A"
        )

    def test_state_b_classifies_as_b(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_b(project_root, framework_source)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "B"
        )

    def test_state_c_classifies_as_c(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_c(project_root, framework_source)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "C"
        )

    def test_state_d_classifies_as_d(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_d(project_root)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "D"
        )

    def test_state_e_classifies_as_e(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_e(project_root, framework_source)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "E"
        )

    def test_state_f_classifies_as_f(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_f(project_root)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "F"
        )

    def test_state_g_classifies_as_g(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_g(project_root)
        assert (
            relocate.detect_install_state(project_root, framework_source=framework_source)
            == "G"
        )


# ---------------------------------------------------------------------------
# Wipe-and-reinstall tests (idempotent end state across A/B/C/D/F)
# ---------------------------------------------------------------------------


def _assert_canonical_end_state(
    project_root: Path, *, expect_legacy_removed: bool = True
) -> None:
    """Common post-relocate assertions for layout states A-D + F."""
    assert (project_root / ".deft" / "core").is_dir(), ".deft/core/ should be present"
    assert (project_root / ".deft" / "core" / "main.md").is_file(), \
        "framework deposit missing main.md"
    if expect_legacy_removed:
        assert not (project_root / "deft").exists(), "legacy deft/ should have been removed"
    agents = (project_root / "AGENTS.md").read_text(encoding="utf-8")
    assert "<!-- deft:managed-section v2 -->" in agents, "v2 marker open absent"
    assert "<!-- /deft:managed-section -->" in agents, "v2 marker close absent"
    gitignore = (project_root / ".gitignore").read_text(encoding="utf-8")
    assert ".deft-cache/" in gitignore, ".gitignore missing .deft-cache/ entry"
    assert "vbrief/.eval/" in gitignore, ".gitignore missing vbrief/.eval/ entry"


class TestRelocateAcrossStates:
    """``wipe_and_reinstall`` is idempotent across A/B/C/D/F."""

    def test_state_a_relocates_to_canonical(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_a(project_root, framework_source)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        relocate.wipe_and_reinstall(plan, skip_snapshot=True)
        _assert_canonical_end_state(project_root)

    def test_state_b_relocates_to_canonical(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_b(project_root, framework_source)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        relocate.wipe_and_reinstall(plan, skip_snapshot=True)
        _assert_canonical_end_state(project_root, expect_legacy_removed=False)

    def test_state_c_relocates_to_canonical(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_c(project_root, framework_source)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        relocate.wipe_and_reinstall(plan, skip_snapshot=True)
        _assert_canonical_end_state(project_root)

    def test_state_d_relocates_to_canonical(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_d(project_root)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        relocate.wipe_and_reinstall(plan, skip_snapshot=True)
        _assert_canonical_end_state(project_root, expect_legacy_removed=False)

    def test_state_f_relocates_to_canonical(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_f(project_root)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        relocate.wipe_and_reinstall(plan, skip_snapshot=True)
        _assert_canonical_end_state(project_root, expect_legacy_removed=False)

    def test_canonical_state_is_noop(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        # Build the canonical end state directly + verify the plan reports
        # ``needs_relocate=False`` and wipe_and_reinstall returns None
        # without mutating the tree.
        _populate_canonical(project_root, framework_source)
        relocate.regenerate_agents_md(project_root, framework_source)
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        assert plan.state == "CANONICAL"
        assert plan.needs_relocate is False
        result = relocate.wipe_and_reinstall(plan, skip_snapshot=True)
        assert result is None


# ---------------------------------------------------------------------------
# Snapshot + rollback
# ---------------------------------------------------------------------------


class TestSnapshotRollback:
    """The snapshot tarball restores the pre-relocate state on --rollback."""

    def test_rollback_restores_state_a_pre_relocate_bytes(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_a(project_root, framework_source)
        # Capture the pre-relocate byte snapshot of three sentinel paths.
        legacy_main_pre = (project_root / "deft" / "main.md").read_bytes()
        agents_pre = (project_root / "AGENTS.md").read_bytes()
        # Run the wipe with snapshot enabled.
        plan = relocate.build_relocate_plan(
            project_root, framework_source=framework_source
        )
        snap = relocate.wipe_and_reinstall(plan)
        assert snap is not None and snap.is_file(), "snapshot tarball missing"
        # Verify the canonical end state landed.
        _assert_canonical_end_state(project_root)
        # Roll back.
        restored = relocate.extract_snapshot(project_root, snapshot=snap)
        assert restored == snap
        # The legacy tree + AGENTS.md should match the pre-relocate bytes.
        assert (project_root / "deft" / "main.md").read_bytes() == legacy_main_pre
        assert (project_root / "AGENTS.md").read_bytes() == agents_pre
        # The relocator's deposited .deft/core/ should be gone after
        # rollback (it was not in the pre-relocate state).
        assert not (project_root / ".deft" / "core").exists()

    def test_rollback_without_prior_snapshot_raises(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        _make_state_a(project_root, framework_source)
        with pytest.raises(relocate.RelocateError, match="no snapshot found"):
            relocate.extract_snapshot(project_root)


# ---------------------------------------------------------------------------
# Self-detect + self-bootstrap (BOOTSTRAP NEVER SELF-DESTRUCTIVE; #1015)
# ---------------------------------------------------------------------------


class TestSelfDetect:
    """``main()`` invokes the self-bootstrap path when running from in-place.

    v0.27.0 (#992 PR2) shipped a fail-loud branch that returned exit 2 when
    the relocator script lived inside the wipe target. #1015 replaces that
    branch with an in-process self-bootstrap: the framework is copied to an
    OS temp dir and the relocator is re-launched from there. The fail-loud
    branch only fires now if the bootstrap copy itself fails (an OS / shutil
    error). These tests assert the bootstrap-dispatch contract.
    """

    def test_main_dispatches_self_bootstrap_when_inside_canonical_dir(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Materialise canonical/legacy dirs so the self-detect check has
        # something to resolve script_path into.
        _populate_canonical(project_root, framework_source)
        # Place a fake "running script" inside the canonical wipe target.
        canonical = project_root / ".deft" / "core"
        fake_script = canonical / "scripts" / "relocate.py"
        fake_script.parent.mkdir(parents=True, exist_ok=True)
        fake_script.write_text("# fake\n", encoding="utf-8")
        # Patch the helper so the self-detect compares against our
        # fake_script path (the real ``__file__`` lives outside the wipe
        # target on the test runner).
        original = relocate._running_inside_wipe_target

        def fake_helper(
            *, script_path: Path, project_root: Path
        ) -> tuple[bool, Path | None]:
            return original(script_path=fake_script, project_root=project_root)

        monkeypatch.setattr(relocate, "_running_inside_wipe_target", fake_helper)

        # Stub the bootstrap so we can assert it was invoked without
        # actually copying the framework + spawning a subprocess.
        bootstrap_invocations: list[dict[str, Any]] = []

        def fake_bootstrap(*, in_place_framework: Path, argv: Any) -> int:
            bootstrap_invocations.append(
                {"in_place_framework": in_place_framework, "argv": list(argv)}
            )
            return relocate.EXIT_SUCCESS

        monkeypatch.setattr(relocate, "self_bootstrap_to_temp", fake_bootstrap)

        rc = relocate.main(
            [
                "--project-root",
                str(project_root),
                "--framework-source",
                str(framework_source),
                "--confirm",
                "--no-snapshot",
                "--quiet",
            ]
        )
        assert rc == relocate.EXIT_SUCCESS, (
            "self-bootstrap dispatch should propagate the child's exit code"
        )
        assert len(bootstrap_invocations) == 1, (
            "the self-bootstrap helper must be invoked exactly once on detect"
        )
        invocation = bootstrap_invocations[0]
        # The offending wipe target is the canonical dir.
        assert invocation["in_place_framework"] == canonical.resolve()
        # The full argv (minus the script name) is forwarded so the temp
        # child can re-parse the operator's flags.
        assert "--confirm" in invocation["argv"]
        assert "--no-snapshot" in invocation["argv"]

    def test_bootstrapped_from_temp_sentinel_suppresses_self_detect(
        self,
        relocate: Any,
        project_root: Path,
        framework_source: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Place a fake script inside the wipe target -- but ALSO pass
        # ``--bootstrapped-from-temp`` to simulate the temp-child run.
        # The relocator MUST proceed normally instead of self-bootstrapping
        # again; otherwise we get an infinite re-launch loop.
        _populate_canonical(project_root, framework_source)
        canonical = project_root / ".deft" / "core"
        fake_script = canonical / "scripts" / "relocate.py"
        fake_script.parent.mkdir(parents=True, exist_ok=True)
        fake_script.write_text("# fake\n", encoding="utf-8")
        original = relocate._running_inside_wipe_target

        def fake_helper(
            *, script_path: Path, project_root: Path
        ) -> tuple[bool, Path | None]:
            return original(script_path=fake_script, project_root=project_root)

        monkeypatch.setattr(relocate, "_running_inside_wipe_target", fake_helper)

        bootstrap_calls: list[Any] = []

        def forbidden_bootstrap(**_: Any) -> int:  # pragma: no cover
            bootstrap_calls.append(_)
            raise AssertionError(
                "self_bootstrap_to_temp must NOT fire when the sentinel is set"
            )

        monkeypatch.setattr(
            relocate, "self_bootstrap_to_temp", forbidden_bootstrap
        )
        # ``--force`` clears the customization probe -- this fixture seeds
        # a fake ``scripts/relocate.py`` inside the wipe target which the
        # state-classifier rightly flags as customization. The contract
        # under test here is the sentinel-suppression of the bootstrap
        # dispatch, NOT the customization gate.
        rc = relocate.main(
            [
                "--project-root",
                str(project_root),
                "--framework-source",
                str(framework_source),
                "--force",
                "--confirm",
                "--no-snapshot",
                "--quiet",
                "--bootstrapped-from-temp",
            ]
        )
        # The wipe should proceed normally to canonical end state -- the
        # exit code is the canonical-state success code.
        assert rc == relocate.EXIT_SUCCESS
        assert bootstrap_calls == [], (
            "sentinel must short-circuit the bootstrap dispatch (no infinite loop)"
        )


# ---------------------------------------------------------------------------
# AGENTS.md re-render preservation
# ---------------------------------------------------------------------------


class TestAgentsMdRender:
    """``regenerate_agents_md`` preserves consumer prose around the marker block."""

    def test_existing_prose_above_markers_is_preserved(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        # Pre-existing AGENTS.md with consumer prose ABOVE the marker block.
        rendered = relocate.render_managed_section(framework_source)
        (project_root / "AGENTS.md").write_text(
            "# Consumer Prose Header\n\nHand-rolled notes survive.\n\n"
            + rendered
            + "\n",
            encoding="utf-8",
        )
        relocate.regenerate_agents_md(project_root, framework_source)
        text = (project_root / "AGENTS.md").read_text(encoding="utf-8")
        assert "# Consumer Prose Header" in text
        assert "Hand-rolled notes survive." in text
        assert "<!-- deft:managed-section v2 -->" in text

    def test_legacy_unwrapped_content_is_wrapped_below(
        self, relocate: Any, project_root: Path, framework_source: Path
    ) -> None:
        # Pre-existing AGENTS.md with legacy text but NO markers.
        (project_root / "AGENTS.md").write_text(
            "# Legacy AGENTS.md\nDeft v0.19 install notes.\n", encoding="utf-8"
        )
        relocate.regenerate_agents_md(project_root, framework_source)
        text = (project_root / "AGENTS.md").read_text(encoding="utf-8")
        assert "# Legacy AGENTS.md" in text, "legacy content stripped"
        assert "Deft v0.19 install notes." in text, "legacy content stripped"
        assert "<!-- deft:managed-section v2 -->" in text, "marker not appended"


# ---------------------------------------------------------------------------
# Advisory grep
# ---------------------------------------------------------------------------


class TestAdvisoryGrep:
    """``advise_external_hardcodes`` flags consumer files referencing legacy ``deft/run``."""

    def test_advisory_finds_consumer_hardcode(
        self, relocate: Any, project_root: Path
    ) -> None:
        (project_root / "ci.sh").write_text(
            "#!/usr/bin/env bash\npython deft/run check\n", encoding="utf-8"
        )
        hits = relocate.advise_external_hardcodes(project_root)
        assert any(p == "ci.sh" for p, _, _ in hits)

    def test_advisory_skips_framework_deposit(
        self, relocate: Any, project_root: Path
    ) -> None:
        # Hardcode INSIDE .deft/core/ should not be flagged -- the
        # framework owns that directory.
        canonical = project_root / ".deft" / "core"
        canonical.mkdir(parents=True, exist_ok=True)
        (canonical / "internal.md").write_text(
            "deft/run is referenced here for the redirect-stub contract.\n",
            encoding="utf-8",
        )
        hits = relocate.advise_external_hardcodes(project_root)
        assert hits == []
