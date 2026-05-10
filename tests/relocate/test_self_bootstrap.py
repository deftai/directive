"""tests/relocate/test_self_bootstrap.py -- self-bootstrap + F1/F2/F3 (#1015).

Owned by the v0.27.1 follow-up issue #1015. Covers four behaviour blocks:

- **Self-bootstrap** -- :func:`scripts.relocate.self_bootstrap_to_temp` copies
  the in-place framework to an OS temp dir + re-launches the relocator from
  there with the canonical sentinel. Argv stripping, copy ignore-set, sentinel
  injection, runner / temp-factory seams, and end-to-end relocation against a
  real subprocess child are pinned here.

- **F1 UPGRADING.md note** -- the doc-only note about above-marker ``deft/run``
  references is present in ``UPGRADING.md`` under the v0.27 migration section.

- **F2 canonical default** -- the canonical ``.gitignore`` baseline is
  ``.deft-cache/`` + ``vbrief/.eval/`` (NOT ``.deft/core/``). A small
  parametrised test pins consistency across the relocator implementation,
  the pre-existing state-matrix fixture assertions, and the relocator-side
  test fixture (``test_state_matrix.py::_assert_canonical_end_state``).

- **F3 rollback residue** -- after a rollback the relocator-created
  ``.gitignore`` is removed when the pre-relocate project had none. The
  ``.deft-cache/`` dir is intentionally outside the byte-equivalent contract.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "relocate.py"
UPGRADING_MD = REPO_ROOT / "UPGRADING.md"


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


# ---------------------------------------------------------------------------
# Self-bootstrap helper -- argv strip, sentinel, runner / factory seams
# ---------------------------------------------------------------------------


class TestArgvStripFrameworkSource:
    """``_argv_strip_framework_source`` removes existing --framework-source flags."""

    def test_strips_space_separated_form(self, relocate: Any) -> None:
        argv = ["--project-root", "/x", "--framework-source", "/old", "--confirm"]
        assert relocate._argv_strip_framework_source(argv) == [
            "--project-root",
            "/x",
            "--confirm",
        ]

    def test_strips_equals_form(self, relocate: Any) -> None:
        argv = ["--project-root", "/x", "--framework-source=/old", "--confirm"]
        assert relocate._argv_strip_framework_source(argv) == [
            "--project-root",
            "/x",
            "--confirm",
        ]

    def test_no_op_when_absent(self, relocate: Any) -> None:
        argv = ["--project-root", "/x", "--confirm", "--no-snapshot"]
        assert relocate._argv_strip_framework_source(argv) == argv


class TestSelfBootstrapHelperInjectsSentinelAndTempPath:
    """``self_bootstrap_to_temp`` builds the canonical child argv."""

    def _build_in_place_framework(self, root: Path) -> Path:
        # Minimal framework shape -- scripts/relocate.py + a stub helper +
        # templates/agents-entry.md so the copy is non-trivial. This stub
        # version of relocate.py is NOT the real one; we just need the file
        # to exist so the helper's path-existence guard passes.
        framework = root / "in-place-deft"
        (framework / "scripts").mkdir(parents=True)
        (framework / "scripts" / "relocate.py").write_text(
            "# stub relocate\n", encoding="utf-8"
        )
        (framework / "templates").mkdir(parents=True)
        (framework / "templates" / "agents-entry.md").write_text(
            "<!-- deft:managed-section v2 -->\n# stub\n<!-- /deft:managed-section -->\n",
            encoding="utf-8",
        )
        # A noise file that the ignore-set MUST skip during copy.
        (framework / ".git").mkdir()
        (framework / ".git" / "HEAD").write_text("ref: ignored\n", encoding="utf-8")
        return framework

    def test_helper_injects_sentinel_and_temp_path(
        self, relocate: Any, tmp_path: Path
    ) -> None:
        framework = self._build_in_place_framework(tmp_path)
        captured: list[list[str]] = []

        def fake_runner(argv: list[str]) -> int:
            captured.append(argv)
            return 0

        temp_root = tmp_path / "bootstrap-temp"

        def fake_factory() -> Path:
            temp_root.mkdir(parents=True, exist_ok=True)
            return temp_root

        rc = relocate.self_bootstrap_to_temp(
            in_place_framework=framework,
            argv=[
                "--project-root",
                "/some/consumer",
                "--framework-source",
                str(framework),
                "--confirm",
                "--no-snapshot",
            ],
            runner=fake_runner,
            temp_factory=fake_factory,
        )
        assert rc == 0
        assert len(captured) == 1, "child runner must be called exactly once"
        argv = captured[0]
        assert argv[0] == sys.executable, "child argv[0] must be the python interpreter"
        # The script path lives under the temp framework copy.
        assert str(temp_root / relocate.BOOTSTRAP_FRAMEWORK_NAME) in argv[1]
        assert argv[1].endswith("scripts" + ("\\" if "\\" in argv[1] else "/") + "relocate.py")
        # Original --framework-source is stripped; bootstrap injects its own.
        assert argv.count("--framework-source") == 1
        idx = argv.index("--framework-source")
        injected_framework = Path(argv[idx + 1])
        assert injected_framework == temp_root / relocate.BOOTSTRAP_FRAMEWORK_NAME
        # The sentinel is appended.
        assert relocate.BOOTSTRAP_SENTINEL in argv
        # Operator's --confirm / --no-snapshot are forwarded verbatim.
        assert "--confirm" in argv
        assert "--no-snapshot" in argv

    def test_helper_skips_repo_noise_during_copy(
        self, relocate: Any, tmp_path: Path
    ) -> None:
        framework = self._build_in_place_framework(tmp_path)
        # Add a noise dir not in the ignore-set top-level entry list (a
        # nested .git inside scripts/ MUST be COPIED because the ignore
        # callback only filters top-level matches per shutil.copytree).
        (framework / "scripts" / ".git").mkdir()
        (framework / "scripts" / ".git" / "HEAD").write_text(
            "nested\n", encoding="utf-8"
        )

        def runner(_argv: list[str]) -> int:
            return 0

        temp_root = tmp_path / "bootstrap-temp"

        def factory() -> Path:
            temp_root.mkdir(parents=True, exist_ok=True)
            return temp_root

        relocate.self_bootstrap_to_temp(
            in_place_framework=framework,
            argv=[],
            runner=runner,
            temp_factory=factory,
        )
        copied = temp_root / relocate.BOOTSTRAP_FRAMEWORK_NAME
        # Top-level .git dir was filtered.
        assert not (copied / ".git").exists(), \
            "top-level .git must be filtered by the bootstrap ignore-set"
        # Required artifacts survived.
        assert (copied / "scripts" / "relocate.py").is_file()
        assert (copied / "templates" / "agents-entry.md").is_file()


class TestSelfBootstrapEndToEnd:
    """Integration: real subprocess child runs the relocator from temp."""

    def _build_real_framework(self, root: Path) -> Path:
        """Materialise a working framework copy by mirroring this repo's scripts."""
        framework = root / "in-place-deft"
        framework.mkdir(parents=True)
        # Mirror the scripts/ + templates/ subset the relocator actually
        # needs to run. We copy from the live REPO_ROOT so the test child
        # is exercising the same code path as the deployed relocator.
        for sub in ("scripts", "templates"):
            shutil.copytree(REPO_ROOT / sub, framework / sub)
        # vbrief/schemas/ is part of the deposit; ship a minimal stub.
        (framework / "vbrief" / "schemas").mkdir(parents=True)
        (framework / "vbrief" / "schemas" / "vbrief.schema.json").write_text(
            '{"name": "fixture"}\n', encoding="utf-8"
        )
        (framework / "vbrief" / "vbrief.md").write_text(
            "# vbrief template\n", encoding="utf-8"
        )
        return framework

    def test_temp_child_relocates_state_a_consumer(
        self, relocate: Any, tmp_path: Path
    ) -> None:
        # Build a state-A consumer (legacy deft/ framework).
        framework = self._build_real_framework(tmp_path / "fresh")
        consumer = tmp_path / "consumer"
        consumer.mkdir()
        legacy = consumer / "deft"
        shutil.copytree(framework, legacy)
        (consumer / "AGENTS.md").write_text(
            "# Project AGENTS.md\nLegacy install.\n", encoding="utf-8"
        )
        (consumer / "vbrief").mkdir()

        # Invoke the bootstrap helper directly with a real subprocess.
        # ``in_place_framework`` here points at the legacy ``deft/`` dir
        # so the temp copy mirrors a state-A consumer's framework.
        # ``--force`` is passed because this test mirrors the live repo's
        # ``scripts/`` and ``templates/`` into the legacy dir, which (after
        # pytest imports) carries ``__pycache__`` artifacts the
        # customization probe legitimately flags. The bootstrap mechanism
        # is what's under test here, not the customization gate.
        rc = relocate.self_bootstrap_to_temp(
            in_place_framework=legacy,
            argv=[
                "--project-root",
                str(consumer),
                "--force",
                "--confirm",
                "--no-snapshot",
                "--quiet",
            ],
        )
        assert rc == relocate.EXIT_SUCCESS
        # The relocator ran from temp and successfully wiped+reinstalled
        # the consumer into canonical state.
        assert (consumer / ".deft" / "core").is_dir()
        assert not (consumer / "deft").exists()


# ---------------------------------------------------------------------------
# F1 -- UPGRADING.md above-marker note
# ---------------------------------------------------------------------------


class TestF1UpgradingNote:
    """The doc-only above-marker note is present + actionable."""

    @pytest.fixture(scope="class")
    def upgrading_text(self) -> str:
        return UPGRADING_MD.read_text(encoding="utf-8")

    def test_section_heading_exists(self, upgrading_text: str) -> None:
        assert "Manual edits required after relocate (above-marker prose)" in upgrading_text

    def test_explains_why_rewrite_is_manual(self, upgrading_text: str) -> None:
        # The note MUST mention that consumer-owned files are not auto-rewritten.
        assert "advisory grep" in upgrading_text.lower()
        assert "manually" in upgrading_text.lower() or "manual" in upgrading_text.lower()

    def test_lists_canonical_replacement(self, upgrading_text: str) -> None:
        # The note MUST cite the canonical replacement target.
        assert ".deft/core/run" in upgrading_text
        assert "deft/run" in upgrading_text

    def test_cites_issue_1015(self, upgrading_text: str) -> None:
        assert "F1 #1015" in upgrading_text or "#1015" in upgrading_text


# ---------------------------------------------------------------------------
# F2 -- canonical .gitignore default
# ---------------------------------------------------------------------------


class TestF2GitignoreDefault:
    """The canonical default is ``.deft-cache/`` + ``vbrief/.eval/`` only.

    The framework deposit at ``.deft/core/`` is INTENTIONALLY NOT in the
    default ``.gitignore`` baseline because it ships read-only packaged
    framework assets that consumers commit for reproducibility.
    """

    def test_relocator_constant_pins_canonical_default(self, relocate: Any) -> None:
        assert relocate.GITIGNORE_LINES == (".deft-cache/", "vbrief/.eval/")

    def test_dot_deft_core_is_intentionally_absent(self, relocate: Any) -> None:
        # If a future PR adds .deft/core/ to GITIGNORE_LINES it MUST first
        # update the F2 decision rationale comment in scripts/relocate.py
        # AND drop this test (which encodes the inverse contract).
        assert ".deft/core/" not in relocate.GITIGNORE_LINES
        assert ".deft/core" not in relocate.GITIGNORE_LINES

    @pytest.mark.parametrize(
        "expected_line",
        [
            ".deft-cache/",
            "vbrief/.eval/",
        ],
    )
    def test_relocator_constant_aligns_with_state_matrix_fixture(
        self, relocate: Any, expected_line: str
    ) -> None:
        # The state-matrix fixture's _assert_canonical_end_state asserts
        # both lines verbatim; pin the same set here so a drift on either
        # side (impl OR test) is a deterministic test failure.
        assert expected_line in relocate.GITIGNORE_LINES

    def test_rationale_comment_present_in_source(self) -> None:
        # The F2 decision is documented in code so a future reader does
        # not re-litigate the question. Pin the marker text.
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        assert "F2 canonical-default decision (#1015)" in source


# ---------------------------------------------------------------------------
# F3 -- rollback removes relocator-created .gitignore residue
# ---------------------------------------------------------------------------


class TestF3RollbackResidue:
    """Rollback MUST restore byte-equivalent pre-relocate state for tracked paths."""

    def _build_framework_source(self, root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        (root / "templates").mkdir(parents=True, exist_ok=True)
        (root / "templates" / "agents-entry.md").write_text(
            "<!-- deft:managed-section v2 -->\n# stub\n<!-- /deft:managed-section -->\n",
            encoding="utf-8",
        )
        (root / "main.md").write_text("# main.md\n", encoding="utf-8")
        return root

    def test_rollback_removes_relocator_created_gitignore(
        self, relocate: Any, tmp_path: Path
    ) -> None:
        # Pre-relocate state-A consumer with NO .gitignore.
        framework_source = self._build_framework_source(tmp_path / "fresh")
        consumer = tmp_path / "consumer"
        consumer.mkdir()
        legacy = consumer / "deft"
        legacy.mkdir()
        shutil.copytree(framework_source, legacy / "fixture-mirror")
        (consumer / "AGENTS.md").write_text("# AGENTS.md\n", encoding="utf-8")
        (consumer / "vbrief").mkdir()
        assert not (consumer / ".gitignore").exists(), (
            "fixture precondition: no .gitignore pre-relocate"
        )

        # Run wipe-and-reinstall (creates snapshot + relocator-created .gitignore).
        plan = relocate.build_relocate_plan(
            consumer, framework_source=framework_source
        )
        snap = relocate.wipe_and_reinstall(plan)
        assert snap is not None and snap.is_file()
        assert (consumer / ".gitignore").is_file(), (
            "wipe-and-reinstall must have created .gitignore"
        )

        # Rollback should remove the relocator-created .gitignore (F3 fix).
        relocate.extract_snapshot(consumer, snapshot=snap)
        assert not (consumer / ".gitignore").exists(), (
            "F3 #1015 contract violation: relocator-created .gitignore left as residue"
        )

    def test_rollback_preserves_pre_existing_gitignore(
        self, relocate: Any, tmp_path: Path
    ) -> None:
        # Pre-relocate state-A consumer with an existing .gitignore -- the
        # rollback MUST restore the pre-relocate bytes (not delete the
        # file, since it WAS captured in the snapshot).
        framework_source = self._build_framework_source(tmp_path / "fresh")
        consumer = tmp_path / "consumer"
        consumer.mkdir()
        legacy = consumer / "deft"
        legacy.mkdir()
        shutil.copytree(framework_source, legacy / "fixture-mirror")
        (consumer / "AGENTS.md").write_text("# AGENTS.md\n", encoding="utf-8")
        (consumer / "vbrief").mkdir()
        original_gitignore_bytes = b"# consumer pre-existing\nnode_modules/\n"
        (consumer / ".gitignore").write_bytes(original_gitignore_bytes)

        plan = relocate.build_relocate_plan(
            consumer, framework_source=framework_source
        )
        snap = relocate.wipe_and_reinstall(plan)
        assert snap is not None
        # Post-relocate .gitignore is augmented with the relocator's lines.
        post = (consumer / ".gitignore").read_bytes()
        assert post != original_gitignore_bytes
        assert b".deft-cache/" in post

        # Rollback restores the pre-relocate bytes.
        relocate.extract_snapshot(consumer, snapshot=snap)
        assert (consumer / ".gitignore").read_bytes() == original_gitignore_bytes

    def test_rollback_keeps_deft_cache_for_re_rollback(
        self, relocate: Any, tmp_path: Path
    ) -> None:
        # The .deft-cache/ directory hosts the snapshot tarball itself;
        # removing it would break re-rollback against the same snapshot.
        # Verify the snapshot file is still present after the rollback.
        framework_source = self._build_framework_source(tmp_path / "fresh")
        consumer = tmp_path / "consumer"
        consumer.mkdir()
        legacy = consumer / "deft"
        legacy.mkdir()
        shutil.copytree(framework_source, legacy / "fixture-mirror")
        (consumer / "AGENTS.md").write_text("# AGENTS.md\n", encoding="utf-8")
        (consumer / "vbrief").mkdir()

        plan = relocate.build_relocate_plan(
            consumer, framework_source=framework_source
        )
        snap = relocate.wipe_and_reinstall(plan)
        assert snap is not None and snap.is_file()
        relocate.extract_snapshot(consumer, snapshot=snap)
        # .deft-cache/ + the snapshot tarball survive the rollback.
        assert (consumer / ".deft-cache").is_dir(), (
            ".deft-cache/ MUST survive rollback (hosts the snapshot tarball)"
        )
        assert snap.is_file(), "snapshot tarball MUST survive rollback for re-rollback"


# ---------------------------------------------------------------------------
# Snapshot tracked-paths set (F3 supporting contract)
# ---------------------------------------------------------------------------


class TestRollbackTrackedPathsContract:
    """``ROLLBACK_TRACKED_PATHS`` pins the four canonical members."""

    def test_tracked_paths_match_create_snapshot_members(self) -> None:
        sys.path.insert(0, str(REPO_ROOT / "scripts"))
        import _relocate_snapshot  # noqa: PLC0415 -- runtime import for test seam

        assert _relocate_snapshot.ROLLBACK_TRACKED_PATHS == (
            "deft",
            ".deft/core",
            "AGENTS.md",
            ".gitignore",
        )

    def test_capture_helper_returns_top_level_names(self, tmp_path: Path) -> None:
        sys.path.insert(0, str(REPO_ROOT / "scripts"))
        import _relocate_snapshot  # noqa: PLC0415

        # Build a minimal tarball with a sentinel top-level path.
        tarball = tmp_path / "fixture.tar.gz"
        sentinel = tmp_path / ".gitignore"
        sentinel.write_text(".deft-cache/\n", encoding="utf-8")
        with tarfile.open(tarball, "w:gz") as tar:
            tar.add(str(sentinel), arcname=".gitignore")
        names = _relocate_snapshot._captured_top_level_names(tarball)
        assert names == {".gitignore"}


# ---------------------------------------------------------------------------
# Smoke check: subprocess module is imported (helper depends on it)
# ---------------------------------------------------------------------------


def test_relocate_module_imports_subprocess(relocate: Any) -> None:
    # The bootstrap helper depends on ``subprocess.run``; pin the import.
    assert subprocess is not None
    assert hasattr(relocate, "_default_subprocess_runner")
