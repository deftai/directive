"""test_upgrade_gate.py -- Tests for #410 deft/run upgrade gate and #404
lifecycle subdirectory scaffolding in cmd_project.

Covers:
- cmd_project creates all 5 lifecycle subdirectories under vbrief/ (#404)
- cmd_project writes vbrief/.deft-version marker (#410 companion)
- _check_upgrade_gate: warns on version drift, silent on match, prompts
  interactively, non-interactively continues, skips inside deft repo itself
- cmd_upgrade writes marker, no-ops when already current
- Detection of pre-cutover legacy artifacts without redirect sentinel

Story: #404 + #410 (swarm-402)
"""

from __future__ import annotations

import io
from pathlib import Path

# ---------------------------------------------------------------------------
# #404: lifecycle subdirectories after cmd_project
# ---------------------------------------------------------------------------


def _project_responses(project_path: Path) -> list:
    """Standard 9-response queue for cmd_project (matches test_project.py)."""
    return [
        str(project_path),   # 1 output path
        "TestProject",        # 2 project name
        "1",                  # 3 CLI
        "1",                  # 4 first language
        "85",                 # 5 coverage
        "Flask",              # 6 tech stack
        "1",                  # 7 strategy
        "1",                  # 8 branch-based
        False,                # 9 don't chain to spec
    ]


class TestProjectLifecycleSubdirs:
    """#404: `run project` must scaffold vbrief/ lifecycle subdirectories."""

    def test_creates_all_five_lifecycle_folders(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "deft").mkdir(exist_ok=True)
        project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
        mock_user_input(_project_responses(project_path))

        run_command("cmd_project", [])

        vbrief_root = project_path.parent
        for folder in ("proposed", "pending", "active", "completed", "cancelled"):
            assert (vbrief_root / folder).is_dir(), (
                f"Expected lifecycle folder vbrief/{folder}/ to exist after `run project`"
            )

    def test_lifecycle_folders_match_validator_constant(self, deft_run_module):
        """LIFECYCLE_FOLDERS in run must stay in sync with scripts/vbrief_validate.py.

        Parses `scripts/vbrief_validate.py` via `ast` (no import, so the
        validator module is not pulled into the coverage report) and
        extracts the `LIFECYCLE_FOLDERS` constant for comparison.  Any
        reorder, rename, add, or remove in either file fails this test.
        """
        import ast
        from pathlib import Path

        validator_source = (
            Path(__file__).resolve().parents[2] / "scripts" / "vbrief_validate.py"
        ).read_text(encoding="utf-8")
        tree = ast.parse(validator_source)

        validator_folders: tuple[str, ...] | None = None
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if "LIFECYCLE_FOLDERS" not in targets:
                continue
            # Expect: LIFECYCLE_FOLDERS = tuple(FOLDER_ALLOWED_STATUSES.keys())
            # Fall back to evaluating a literal tuple/list if ever inlined.
            if (
                isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "tuple"
                and len(node.value.args) == 1
            ):
                inner = node.value.args[0]
                # tuple(FOLDER_ALLOWED_STATUSES.keys()) -> look up the dict literal
                if (
                    isinstance(inner, ast.Call)
                    and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr == "keys"
                    and isinstance(inner.func.value, ast.Name)
                ):
                    dict_name = inner.func.value.id
                    for dn in tree.body:
                        if (
                            isinstance(dn, (ast.Assign, ast.AnnAssign))
                            and (
                                (
                                    isinstance(dn, ast.Assign)
                                    and any(
                                        isinstance(t, ast.Name) and t.id == dict_name
                                        for t in dn.targets
                                    )
                                )
                                or (
                                    isinstance(dn, ast.AnnAssign)
                                    and isinstance(dn.target, ast.Name)
                                    and dn.target.id == dict_name
                                )
                            )
                        ):
                            value_node = dn.value
                            if isinstance(value_node, ast.Dict):
                                validator_folders = tuple(
                                    k.value for k in value_node.keys if isinstance(k, ast.Constant)
                                )
                                break
            elif isinstance(node.value, (ast.Tuple, ast.List)):
                validator_folders = tuple(
                    e.value for e in node.value.elts if isinstance(e, ast.Constant)
                )
            break

        assert validator_folders is not None, (
            "Could not extract LIFECYCLE_FOLDERS from scripts/vbrief_validate.py"
        )
        assert validator_folders == deft_run_module.LIFECYCLE_FOLDERS

    def test_cmd_project_writes_version_marker(
        self, run_command, mock_user_input, isolated_env, deft_run_module, monkeypatch
    ):
        """#410 companion: first setup writes .deft-version so the gate is quiet."""
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "deft").mkdir(exist_ok=True)
        project_path = isolated_env / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
        mock_user_input(_project_responses(project_path))

        run_command("cmd_project", [])

        marker = project_path.parent / ".deft-version"
        assert marker.is_file(), "Expected vbrief/.deft-version marker after `run project`"
        assert marker.read_text(encoding="utf-8").strip() == deft_run_module.VERSION


# ---------------------------------------------------------------------------
# #410: upgrade gate helper behavior
# ---------------------------------------------------------------------------


class TestVersionMarkerHelpers:
    """Direct tests of the `.deft-version` read/write helpers."""

    def test_read_missing_marker_returns_none(self, tmp_path, deft_run_module):
        assert deft_run_module._read_version_marker(tmp_path) is None

    def test_write_and_read_marker_round_trip(self, tmp_path, deft_run_module):
        vbrief_root = tmp_path / "vbrief"
        deft_run_module._write_version_marker(vbrief_root)
        assert (vbrief_root / ".deft-version").is_file()
        assert deft_run_module._read_version_marker(tmp_path) == deft_run_module.VERSION

    def test_project_root_marker_is_fallback(self, tmp_path, deft_run_module):
        """If vbrief/.deft-version is missing, project-root .deft-version is used."""
        (tmp_path / ".deft-version").write_text("0.18.5\n", encoding="utf-8")
        assert deft_run_module._read_version_marker(tmp_path) == "0.18.5"

    def test_vbrief_marker_takes_precedence(self, tmp_path, deft_run_module):
        """vbrief/.deft-version wins over root .deft-version."""
        (tmp_path / ".deft-version").write_text("0.18.5\n", encoding="utf-8")
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text("0.20.0\n", encoding="utf-8")
        assert deft_run_module._read_version_marker(tmp_path) == "0.20.0"


class TestLegacyDetection:
    """`_detect_pre_cutover_legacy` returns filenames missing the redirect sentinel."""

    def test_no_legacy_when_files_absent(self, tmp_path, deft_run_module):
        assert deft_run_module._detect_pre_cutover_legacy(tmp_path) == []

    def test_detects_specification_without_sentinel(self, tmp_path, deft_run_module):
        (tmp_path / "SPECIFICATION.md").write_text("# real spec content\n", encoding="utf-8")
        assert deft_run_module._detect_pre_cutover_legacy(tmp_path) == ["SPECIFICATION.md"]

    def test_detects_project_without_sentinel(self, tmp_path, deft_run_module):
        (tmp_path / "PROJECT.md").write_text("# real project content\n", encoding="utf-8")
        assert deft_run_module._detect_pre_cutover_legacy(tmp_path) == ["PROJECT.md"]

    def test_ignores_files_with_redirect_sentinel(self, tmp_path, deft_run_module):
        sentinel = deft_run_module.DEPRECATED_REDIRECT_SENTINEL
        (tmp_path / "SPECIFICATION.md").write_text(sentinel + "\n", encoding="utf-8")
        (tmp_path / "PROJECT.md").write_text(sentinel + "\n", encoding="utf-8")
        assert deft_run_module._detect_pre_cutover_legacy(tmp_path) == []


class TestRunningInsideDeftRepo:
    """Heuristic that identifies the deft framework repo itself."""

    def test_user_project_not_deft_repo(self, tmp_path, deft_run_module):
        # Simulates a consumer project: ./deft/ submodule present, no root main.md
        (tmp_path / "deft").mkdir()
        assert not deft_run_module._running_inside_deft_repo(tmp_path)

    def test_deft_repo_detected(self, tmp_path, deft_run_module):
        # Simulates the deft repo: root main.md present, no ./deft/ subdir
        (tmp_path / "main.md").write_text("# Deft\n", encoding="utf-8")
        assert deft_run_module._running_inside_deft_repo(tmp_path)


class TestUpgradeGate:
    """`_check_upgrade_gate` warns on drift, silent on match, never fatal when non-interactive."""

    def _stdin_tty(self, monkeypatch, value: bool) -> None:
        """Force sys.stdin.isatty() to return `value` for the test."""
        monkeypatch.setattr("sys.stdin", io.StringIO(""))

        def _isatty_patch(_self=None):  # noqa: ANN001
            return value

        # Patch isatty on both the attribute and the function
        import sys as _sys
        monkeypatch.setattr(_sys.stdin, "isatty", lambda: value, raising=False)

    def test_skip_on_no_deft_project(self, tmp_path, deft_run_module, monkeypatch):
        """No marker, no vbrief/, no legacy -> gate is a no-op (True)."""
        monkeypatch.chdir(tmp_path)
        assert deft_run_module._check_upgrade_gate("project") is True

    def test_skip_inside_deft_repo(self, tmp_path, deft_run_module, monkeypatch):
        """In the deft source repo, the gate is always a no-op."""
        (tmp_path / "main.md").write_text("# Deft\n", encoding="utf-8")
        # Even with legacy artifacts the gate should skip for the deft repo itself
        (tmp_path / "SPECIFICATION.md").write_text("# real\n", encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        assert deft_run_module._check_upgrade_gate("project") is True

    def test_matching_version_marker_is_silent(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        monkeypatch.chdir(tmp_path)
        assert deft_run_module._check_upgrade_gate("project") is True
        # capsys.readouterr() drains the capture buffer on each call -- combine
        # stdout and stderr from a single call to avoid a false green if warn()
        # ever switches to stderr.
        captured = capsys.readouterr()
        out = captured.out + captured.err
        assert "updated" not in out.lower()

    def test_version_drift_non_interactive_warns_and_continues(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text("0.19.0\n", encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        self._stdin_tty(monkeypatch, False)
        assert deft_run_module._check_upgrade_gate("project") is True
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "0.19.0" in combined
        assert deft_run_module.VERSION in combined

    def test_legacy_artifacts_without_marker_non_interactive_warns(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        (tmp_path / "vbrief").mkdir()  # pretend the project has a vbrief/ dir
        (tmp_path / "SPECIFICATION.md").write_text("# real spec\n", encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        self._stdin_tty(monkeypatch, False)
        assert deft_run_module._check_upgrade_gate("project") is True
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "Pre-v0.20" in combined
        assert "SPECIFICATION.md" in combined

    def test_canonical_v019_layout_without_vbrief_warns(
        self, tmp_path, deft_run_module, monkeypatch, capsys
    ):
        """Canonical v0.19 consumer project (legacy docs, no vbrief/) must warn.

        This is the primary migration scenario the gate targets: SPECIFICATION.md
        and PROJECT.md exist with real content (no deprecation sentinel), no
        marker, and no vbrief/ lifecycle dir yet.  The gate must surface the
        upgrade prompt, not silently pass through (regression coverage).
        """
        # deliberately NO vbrief/ directory
        (tmp_path / "SPECIFICATION.md").write_text("# real spec content\n", encoding="utf-8")
        (tmp_path / "PROJECT.md").write_text("# real project content\n", encoding="utf-8")
        # simulate consumer context (./deft/ submodule present) so the deft-repo
        # self-detection does not short-circuit the gate.
        (tmp_path / "deft").mkdir()
        monkeypatch.chdir(tmp_path)
        self._stdin_tty(monkeypatch, False)
        assert deft_run_module._check_upgrade_gate("project") is True
        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert "Pre-v0.20" in combined
        assert "SPECIFICATION.md" in combined
        assert "PROJECT.md" in combined

    def test_skip_for_help_command(self, tmp_path, deft_run_module, monkeypatch):
        """Gate must never fire for help/version commands."""
        (tmp_path / "vbrief").mkdir()
        (tmp_path / "vbrief" / ".deft-version").write_text("0.1.0\n", encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        for cmd in ("help", "--help", "-h", "version", "--version", "-v", "upgrade"):
            assert deft_run_module._check_upgrade_gate(cmd) is True, (
                f"Gate should skip for '{cmd}' but returned False"
            )


# ---------------------------------------------------------------------------
# #410: cmd_upgrade command
# ---------------------------------------------------------------------------


class TestCmdUpgrade:
    """`run upgrade` writes the marker and guides users to `task migrate:vbrief`."""

    def test_writes_marker_when_missing(
        self, run_command, isolated_env, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "vbrief").mkdir(exist_ok=True)
        result = run_command("cmd_upgrade", [])
        assert result.return_code in (0, None)
        assert (isolated_env / "vbrief" / ".deft-version").is_file()
        assert (isolated_env / "vbrief" / ".deft-version").read_text(
            encoding="utf-8"
        ).strip() == deft_run_module.VERSION
        assert "Recorded framework version" in result.stdout

    def test_idempotent_when_current(
        self, run_command, isolated_env, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "vbrief").mkdir(exist_ok=True)
        (isolated_env / "vbrief" / ".deft-version").write_text(
            deft_run_module.VERSION + "\n", encoding="utf-8"
        )
        result = run_command("cmd_upgrade", [])
        assert result.return_code in (0, None)
        assert "already at" in result.stdout.lower()

    def test_updates_marker_on_drift(
        self, run_command, isolated_env, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "vbrief").mkdir(exist_ok=True)
        (isolated_env / "vbrief" / ".deft-version").write_text("0.19.0\n", encoding="utf-8")
        result = run_command("cmd_upgrade", [])
        assert result.return_code in (0, None)
        assert (isolated_env / "vbrief" / ".deft-version").read_text(
            encoding="utf-8"
        ).strip() == deft_run_module.VERSION
        assert "Updated .deft-version" in result.stdout

    def test_warns_on_legacy_artifacts(
        self, run_command, isolated_env, deft_run_module, monkeypatch
    ):
        monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
        (isolated_env / "vbrief").mkdir(exist_ok=True)
        (isolated_env / "SPECIFICATION.md").write_text("# real\n", encoding="utf-8")
        result = run_command("cmd_upgrade", [])
        assert result.return_code in (0, None)
        combined = result.stdout + result.stderr
        assert "Pre-v0.20" in combined
        assert "SPECIFICATION.md" in combined
