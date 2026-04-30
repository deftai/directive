"""test_build_dist.py -- Tests for scripts/build_dist.py (#736).

Covers the cross-platform parity contract:

- Parametrized over Linux tar / Windows zip / macOS tar -- excluded paths
  (.git, dist, backup, node_modules) are absent from the produced
  artifact regardless of format.
- Expected core paths (scripts/, skills/, tasks/, AGENTS.md) are present
  in the produced artifact.
- Artifact size below a sanity ceiling (50 MB) so a regression that
  re-introduces the .git history would fail loudly.
- Idempotent re-run: invoking build twice does NOT ingest the prior
  dist/ artifact into the new archive.
- ``--exclude-extra`` flag extends the canonical exclude list.
- End-to-end smoke: invoke ``task build`` and confirm the Python helper
  ran and an artifact landed in dist/. Skipped when the ``task`` binary
  is not on PATH (mirrors tests/content/test_taskfile_caching.py and
  tests/content/test_taskfile_release_names.py).

The format-selection function is exercised independently so platform
behaviour is asserted without monkeypatching ``sys.platform`` for the
whole test session.

Refs #736 (cross-platform build artifact parity defect).
"""

from __future__ import annotations

import contextlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/build_dist.py in-process."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "build_dist",
        scripts_dir / "build_dist.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["build_dist"] = module
    spec.loader.exec_module(module)
    return module


build_dist = _load_module()


# Sanity ceiling for artifact size. The repo without .git, dist, backup,
# node_modules, and Python-tooling caches measures ~6 MB on a clean
# checkout; 50 MB gives generous headroom while still catching the
# pre-#736 Windows regression where the zip ingested several hundred MB
# of .git history.
SIZE_CEILING_BYTES = 50 * 1024 * 1024


# ---------------------------------------------------------------------------
# Fixture: a small synthetic project that mirrors the canonical exclude
# shape. Using a synthetic root keeps the tests fast and deterministic --
# we don't have to package the real repo (which would be slow under
# pytest -n auto and would couple test outcomes to repo state).
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_project(tmp_path: Path) -> Path:
    """Build a tiny synthetic project root with all the canonical excludes.

    Layout::

        tmp_path/
            AGENTS.md
            scripts/build_dist.py
            skills/foo/SKILL.md
            tasks/core.yml
            .git/HEAD                    <- excluded
            backup/old.md                <- excluded
            node_modules/lib/index.js    <- excluded
            __pycache__/cache.pyc        <- excluded
            dist/deft-stale.tar.gz       <- excluded (idempotency)
            secret.txt                   <- excluded only via --exclude-extra
            secrets/key.txt              <- excluded only via --exclude-extra
    """
    root = tmp_path / "project"
    root.mkdir()
    (root / "AGENTS.md").write_text("# Test AGENTS.md\n", encoding="utf-8")
    (root / "scripts").mkdir()
    (root / "scripts" / "build_dist.py").write_text("# stub\n", encoding="utf-8")
    (root / "skills" / "foo").mkdir(parents=True)
    (root / "skills" / "foo" / "SKILL.md").write_text(
        "# Test skill\n", encoding="utf-8"
    )
    (root / "tasks").mkdir()
    (root / "tasks" / "core.yml").write_text("version: '3'\n", encoding="utf-8")
    # Excluded directories with marker files
    (root / ".git").mkdir()
    (root / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (root / "backup").mkdir()
    (root / "backup" / "old.md").write_text("old\n", encoding="utf-8")
    (root / "node_modules" / "lib").mkdir(parents=True)
    (root / "node_modules" / "lib" / "index.js").write_text(
        "module.exports = {};\n", encoding="utf-8"
    )
    (root / "__pycache__").mkdir()
    (root / "__pycache__" / "cache.pyc").write_bytes(b"\x00\x01\x02")
    # Pre-existing stale dist artifact -- the idempotency guarantee is that
    # the new build run must NOT ingest this into the new archive.
    (root / "dist").mkdir()
    (root / "dist" / "deft-stale.tar.gz").write_bytes(b"STALE-PRIOR-ARTIFACT")
    # Files that ONLY get excluded when --exclude-extra is supplied.
    (root / "secret.txt").write_text("top-secret\n", encoding="utf-8")
    (root / "secrets").mkdir()
    (root / "secrets" / "key.txt").write_text("api-key\n", encoding="utf-8")
    return root


# ---------------------------------------------------------------------------
# Helpers for inspecting produced archives
# ---------------------------------------------------------------------------


def _list_archive_paths(artifact: Path, fmt: str) -> list[str]:
    """Return the archive's member paths (POSIX-formatted)."""
    if fmt == "zip":
        with zipfile.ZipFile(artifact) as zf:
            return zf.namelist()
    with tarfile.open(artifact, "r:gz") as tf:
        return tf.getnames()


def _has_path_component(members: list[str], component: str) -> bool:
    """Return True iff any archive member contains ``component`` as a path part."""
    for member in members:
        parts = member.split("/")
        if component in parts:
            return True
    return False


# ---------------------------------------------------------------------------
# Format selection unit tests
# ---------------------------------------------------------------------------


class TestSelectFormat:
    def test_explicit_zip_wins(self, monkeypatch):
        monkeypatch.setattr(build_dist.sys, "platform", "linux")
        assert build_dist.select_format("zip") == "zip"

    def test_explicit_tar_wins(self, monkeypatch):
        monkeypatch.setattr(build_dist.sys, "platform", "win32")
        assert build_dist.select_format("tar") == "tar"

    def test_default_windows_is_zip(self, monkeypatch):
        monkeypatch.setattr(build_dist.sys, "platform", "win32")
        assert build_dist.select_format(None) == "zip"

    def test_default_linux_is_tar(self, monkeypatch):
        monkeypatch.setattr(build_dist.sys, "platform", "linux")
        assert build_dist.select_format(None) == "tar"

    def test_default_macos_is_tar(self, monkeypatch):
        monkeypatch.setattr(build_dist.sys, "platform", "darwin")
        assert build_dist.select_format(None) == "tar"

    def test_uppercase_format_is_normalised(self, monkeypatch):
        monkeypatch.setattr(build_dist.sys, "platform", "linux")
        assert build_dist.select_format("ZIP") == "zip"


class TestOutputPath:
    def test_tar_extension(self, tmp_path: Path):
        out = build_dist.output_path(tmp_path, "0.22.0", "tar")
        assert out == tmp_path / "dist" / "deft-0.22.0.tar.gz"

    def test_zip_extension(self, tmp_path: Path):
        out = build_dist.output_path(tmp_path, "0.22.0", "zip")
        assert out == tmp_path / "dist" / "deft-0.22.0.zip"


# ---------------------------------------------------------------------------
# Build correctness across formats (the parametrized parity check)
# ---------------------------------------------------------------------------


# IDs use OS-flavoured names so test output reads as the brief specifies
# (Linux tar / Windows zip / macOS tar). The implementation behaviour is
# identical across the three -- format selection is by the explicit ``fmt``
# argument here -- but parametrizing over all three OS+fmt combinations
# documents the parity contract directly in the test names.
@pytest.mark.parametrize(
    "platform_label,fmt",
    [
        ("linux", "tar"),
        ("windows", "zip"),
        ("macos", "tar"),
    ],
    ids=["linux-tar", "windows-zip", "macos-tar"],
)
class TestBuildParity:
    def test_excluded_paths_absent(
        self, fake_project: Path, platform_label: str, fmt: str
    ):
        """The 4 canonical excludes (.git, dist, backup, node_modules) MUST
        be absent from the produced artifact regardless of format."""
        artifact = build_dist.build(fake_project, "0.22.0", fmt)
        members = _list_archive_paths(artifact, fmt)
        for excluded in (".git", "dist", "backup", "node_modules", "__pycache__"):
            assert not _has_path_component(members, excluded), (
                f"[{platform_label}-{fmt}] excluded directory "
                f"{excluded!r} leaked into archive members: "
                f"{[m for m in members if excluded in m.split('/')][:5]}"
            )

    def test_expected_core_paths_present(
        self, fake_project: Path, platform_label: str, fmt: str
    ):
        """Expected top-level project content lives under the deft/ prefix."""
        artifact = build_dist.build(fake_project, "0.22.0", fmt)
        members = _list_archive_paths(artifact, fmt)
        for expected in (
            "deft/AGENTS.md",
            "deft/scripts/build_dist.py",
            "deft/skills/foo/SKILL.md",
            "deft/tasks/core.yml",
        ):
            assert expected in members, (
                f"[{platform_label}-{fmt}] expected member {expected!r} "
                f"not present. Archive contains: {sorted(members)[:10]} ..."
            )

    def test_artifact_size_below_ceiling(
        self, fake_project: Path, platform_label: str, fmt: str
    ):
        """Sanity ceiling: artifact MUST stay below 50 MB.

        On the synthetic fixture this is overwhelmingly true (a few KB).
        The check exists as a regression guard against the pre-#736
        Windows zip shape that hauled in .git history. If a future
        refactor re-introduces the unbounded shape, this test will fail
        on the real repo via the smoke test (and on this fixture if the
        fixture grows).
        """
        artifact = build_dist.build(fake_project, "0.22.0", fmt)
        size = artifact.stat().st_size
        assert size < SIZE_CEILING_BYTES, (
            f"[{platform_label}-{fmt}] artifact {artifact} size {size} "
            f"bytes >= ceiling {SIZE_CEILING_BYTES} bytes -- a regression "
            f"of #736 likely re-introduced the .git history into the "
            f"archive."
        )

    def test_idempotent_rerun(
        self, fake_project: Path, platform_label: str, fmt: str
    ):
        """Re-running build twice MUST NOT ingest the prior dist/ artifact.

        The first run produces an artifact in dist/. The second run, given
        the same arguments, must produce a fresh archive that excludes
        the dist/ directory entirely (so the prior artifact is not nested
        inside the new one). The acceptance criteria from #736 calls this
        out explicitly.
        """
        first = build_dist.build(fake_project, "0.22.0", fmt)
        first_size = first.stat().st_size
        # Stage a marker file inside dist/ to make the regression visible:
        # if the second run ingests dist/, the marker will be in the new
        # archive's members.
        (fake_project / "dist" / "marker.txt").write_text(
            "should-not-be-ingested\n", encoding="utf-8"
        )
        second = build_dist.build(fake_project, "0.22.0", fmt)
        members = _list_archive_paths(second, fmt)
        assert not _has_path_component(members, "dist"), (
            f"[{platform_label}-{fmt}] second run ingested dist/: "
            f"{[m for m in members if 'dist' in m.split('/')]}"
        )
        # The pre-existing stale artifact (deft-stale.tar.gz) and the
        # marker.txt added between the two runs must both be absent.
        for forbidden in ("deft/dist/deft-stale.tar.gz", "deft/dist/marker.txt"):
            assert forbidden not in members, (
                f"[{platform_label}-{fmt}] forbidden member {forbidden!r} "
                f"present in second-run archive."
            )
        # Sanity: second run produced an archive of comparable size to
        # the first (within an order of magnitude). A massive size jump
        # would indicate dist/ ingestion even if the membership check
        # somehow missed it.
        second_size = second.stat().st_size
        assert second_size < first_size * 10, (
            f"[{platform_label}-{fmt}] second-run archive size "
            f"{second_size} >>> first-run size {first_size} -- "
            f"likely ingested prior dist/ artifact (#736)."
        )


# ---------------------------------------------------------------------------
# --exclude-extra flag
# ---------------------------------------------------------------------------


class TestFileLevelExclusion:
    """Greptile P1 (PR #773): file-shaped excludes (e.g. ``.coverage``) MUST
    be pruned. Prior behaviour only matched directory basenames during the
    ``os.walk`` traversal, so a bare ``.coverage`` file at the repo root
    leaked into the archive despite being in the canonical exclude list."""

    def test_coverage_file_at_root_is_pruned(self, fake_project: Path):
        """A regular ``.coverage`` file at the project root is excluded."""
        coverage_marker = fake_project / ".coverage"
        coverage_marker.write_bytes(b"COVERAGE-DATA-MUST-BE-EXCLUDED")
        artifact = build_dist.build(fake_project, "0.22.0", "tar")
        members = _list_archive_paths(artifact, "tar")
        assert "deft/.coverage" not in members, (
            f"DEFAULT_EXCLUDES contains .coverage but the file at the project "
            f"root leaked into the archive (Greptile P1 #773). Members starting "
            f"with 'deft/.': "
            f"{[m for m in members if m.startswith('deft/.')]}"
        )

    def test_file_level_exclude_in_subdir(self, fake_project: Path):
        """File-level excludes apply at any depth, not only the root."""
        nested = fake_project / "scripts" / ".coverage"
        nested.write_bytes(b"NESTED-COVERAGE")
        artifact = build_dist.build(fake_project, "0.22.0", "tar")
        members = _list_archive_paths(artifact, "tar")
        assert "deft/scripts/.coverage" not in members, (
            f"File-level .coverage exclude only fired at root, not inside "
            f"subdirs. Affected members: {[m for m in members if '.coverage' in m]}"
        )

    def test_extra_file_excluded_via_argv(self, fake_project: Path):
        """--exclude-extra also prunes file-shaped basenames at any depth."""
        argv = [
            "--version",
            "0.22.0",
            "--root",
            str(fake_project),
            "--format",
            "tar",
            "--exclude-extra",
            "secret.txt",
        ]
        rc = build_dist.main(argv)
        assert rc == build_dist.EXIT_OK
        artifact = build_dist.output_path(fake_project, "0.22.0", "tar")
        members = _list_archive_paths(artifact, "tar")
        assert "deft/secret.txt" not in members, (
            f"--exclude-extra=secret.txt did not prune the bare file. "
            f"Members containing 'secret': "
            f"{[m for m in members if 'secret' in m]}"
        )


class TestExcludeExtra:
    def test_extra_directory_excluded_via_argv(self, fake_project: Path):
        """``--exclude-extra secrets`` prunes the secrets/ directory."""
        argv = [
            "--version",
            "0.22.0",
            "--root",
            str(fake_project),
            "--format",
            "tar",
            "--exclude-extra",
            "secrets",
        ]
        rc = build_dist.main(argv)
        assert rc == build_dist.EXIT_OK
        artifact = build_dist.output_path(fake_project, "0.22.0", "tar")
        members = _list_archive_paths(artifact, "tar")
        assert not _has_path_component(members, "secrets"), (
            f"--exclude-extra=secrets did not prune secrets/: "
            f"{[m for m in members if 'secrets' in m.split('/')]}"
        )
        # Sanity: secret.txt at the root is NOT pruned by --exclude-extra=secrets
        # because the exclude name ("secrets") does not match the file basename
        # ("secret.txt"). File-level pruning applies EXACT basename matching, so
        # partial-name overlap is NOT sufficient.
        assert "deft/secret.txt" in members

    def test_multiple_extras_split_on_comma(self, fake_project: Path):
        """Multiple comma-separated exclude-extra values all apply."""
        excludes = build_dist._parse_extras("secrets, foo ,, bar")
        assert excludes == ("secrets", "foo", "bar")

    def test_empty_exclude_extra_is_no_op(self, fake_project: Path):
        argv = [
            "--version",
            "0.22.0",
            "--root",
            str(fake_project),
            "--format",
            "tar",
            "--exclude-extra",
            "",
        ]
        rc = build_dist.main(argv)
        assert rc == build_dist.EXIT_OK
        artifact = build_dist.output_path(fake_project, "0.22.0", "tar")
        members = _list_archive_paths(artifact, "tar")
        # secrets/ is NOT in the canonical list, so without
        # --exclude-extra=secrets it must be present.
        assert _has_path_component(members, "secrets"), (
            "Empty --exclude-extra unexpectedly pruned secrets/."
        )


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


class TestCli:
    def test_main_writes_artifact_and_returns_zero(self, fake_project: Path, capsys):
        argv = [
            "--version",
            "0.22.0",
            "--root",
            str(fake_project),
            "--format",
            "tar",
        ]
        rc = build_dist.main(argv)
        assert rc == build_dist.EXIT_OK
        out, _ = capsys.readouterr()
        assert "Created" in out
        artifact = build_dist.output_path(fake_project, "0.22.0", "tar")
        assert artifact.is_file()

    def test_missing_version_arg_exits_argparse(self, tmp_path: Path, capsys):
        # argparse raises SystemExit(2) when a required arg is missing.
        # We pass tmp_path as --root so the test stays portable across
        # POSIX and Windows -- the literal /tmp path used previously
        # doesn't exist on Windows, and even though argparse exits
        # before --root is evaluated today, a future reordering would
        # silently break on Windows. (Greptile P2 on PR #773.)
        with pytest.raises(SystemExit) as exc:
            build_dist.main(["--root", str(tmp_path)])
        assert exc.value.code == 2

    def test_missing_root_returns_config_error(self, tmp_path: Path):
        bogus = tmp_path / "does-not-exist"
        argv = [
            "--version",
            "0.22.0",
            "--root",
            str(bogus),
            "--format",
            "tar",
        ]
        rc = build_dist.main(argv)
        assert rc == build_dist.EXIT_CONFIG_ERROR

    def test_format_choices_reject_invalid(self):
        with pytest.raises(SystemExit):
            build_dist.main(["--version", "0.22.0", "--format", "rar"])


# ---------------------------------------------------------------------------
# End-to-end smoke: invoke `task build` against a fixture project so the
# full go-task -> uv run python -> scripts/build_dist.py chain is exercised.
# Skipped when the `task` binary is not on PATH (mirrors the pattern in
# tests/content/test_taskfile_caching.py and test_taskfile_release_names.py).
# ---------------------------------------------------------------------------


def _task_binary_available() -> bool:
    return shutil.which("task") is not None


@pytest.mark.skipif(
    not _task_binary_available(),
    reason=(
        "task binary not available on PATH -- the windows-task-dispatch CI "
        "job and contributors with go-task installed exercise this; skip "
        "on Python-only lanes."
    ),
)
def test_task_build_smoke(tmp_path: Path):
    """``task build`` against the real repo dispatches the helper and writes
    an artifact to dist/.

    Runs ``task -t Taskfile.yml build`` with ``DEFT_RELEASE_VERSION`` pinned
    to a unique sentinel so the produced artifact name is predictable and
    the test does not collide with whatever is already in dist/. Cleans up
    the sentinel artifact after assertions.
    """
    sentinel_version = "0.0.0-test-736-smoke"
    artifact = REPO_ROOT / "dist" / f"deft-{sentinel_version}.tar.gz"
    artifact_zip = REPO_ROOT / "dist" / f"deft-{sentinel_version}.zip"
    # Pre-clean both possible names so the test is order-independent.
    for stale in (artifact, artifact_zip):
        if stale.exists():
            stale.unlink()
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["DEFT_RELEASE_VERSION"] = sentinel_version
    try:
        result = subprocess.run(
            ["task", "-t", str(REPO_ROOT / "Taskfile.yml"), "build"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )
        assert result.returncode == 0, (
            f"task build exited non-zero:\n"
            f"stdout=\n{result.stdout}\n"
            f"stderr=\n{result.stderr}\n"
        )
        # On Windows the helper writes a zip; everywhere else a tar.gz. The
        # smoke test accepts whichever is produced for the host so the same
        # assertions apply regardless of CI lane.
        produced = artifact if artifact.exists() else artifact_zip
        assert produced.exists(), (
            f"Neither {artifact} nor {artifact_zip} exists post task build. "
            f"stdout={result.stdout!r}\nstderr={result.stderr!r}"
        )
        assert produced.stat().st_size < SIZE_CEILING_BYTES
        # Sanity: the helper banner ('Created dist/deft-...') landed on
        # stdout, proving the Python helper actually ran (rather than some
        # legacy tar/Compress-Archive command).
        assert "Created" in result.stdout, (
            f"task build stdout did not contain Python helper banner; "
            f"output:\n{result.stdout}"
        )
    finally:
        for stale in (artifact, artifact_zip):
            if stale.exists():
                with contextlib.suppress(OSError):
                    stale.unlink()
