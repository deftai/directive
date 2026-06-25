"""tests/cli/test_framework_doctor.py -- doctor probe (now scripts/doctor.py per #1335/#1336).

Covers ``scripts/doctor.py`` end-to-end (retired framework_doctor.py name):

- Three-state exit code (0 clean / 1 drift / 2 config error).
- Per-check pass/fail/skip matrix for the four checks (``quick-start-resolves``,
  ``skill-paths-resolve``, ``manifest-agreement``, ``install-path-consistency``).
- ``--json`` output shape (top-level ``project_root`` / ``install_root`` /
  ``exit_code`` / ``checks`` keys; per-check ``name`` / ``status`` / ``detail``
  / ``data``).
- ``--project-root`` flag forwards the resolved project root into the probe.
- ``run_checks`` public API (consumed by ``run::_maybe_run_framework_doctor``).
- UTF-8 self-reconfigure (#814) at ``main()`` entry -- the U+2713 success
  glyph MUST render under Windows git hooks that default stdout to cp1252.

The tests drive :func:`doctor.run_checks` (pure -- no subprocess)
and :func:`doctor.main` (full CLI with arg parsing + stdout/stderr).
Mirrors the ``tests/cli/test_preflight_branch.py`` (#747) shape so the
test seam is consistent across the deft preflight family.

Story: #1046 PR-B (acceptance criterion AC-3).
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
# canonical owner per #1335/#1336 (framework_doctor.py retired)
SCRIPT_PATH = REPO_ROOT / "scripts" / "doctor.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("doctor", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["doctor"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def fd():
    return _load_module()


# ---------------------------------------------------------------------------
# Project-root fixture helpers
# ---------------------------------------------------------------------------


def _write_agents_md(project_root: Path, install_root: str = ".deft/core") -> None:
    """Write a managed AGENTS.md declaring ``install_root`` as the install path."""
    body = (
        "# Project AGENTS.md\n"
        f"Deft is installed in {install_root}/.\n"
        f"Full guidelines: {install_root}/main.md\n"
        "<!-- deft:managed-section v3 -->\n"
        "# Deft\n"
        f"Deft is installed in {install_root}/.\n"
        f"Full guidelines: {install_root}/main.md\n"
        f"See {install_root}/skills/deft-directive-setup/SKILL.md for setup.\n"
        "<!-- /deft:managed-section -->\n"
    )
    (project_root / "AGENTS.md").write_text(body, encoding="utf-8")


def _write_install_tree(
    project_root: Path,
    install_root: str = ".deft/core",
    *,
    quick_start: bool = True,
    skills: tuple[str, ...] = ("deft-directive-setup",),
) -> Path:
    install = project_root / install_root
    install.mkdir(parents=True, exist_ok=True)
    if quick_start:
        (install / "QUICK-START.md").write_text("# QUICK-START\n", encoding="utf-8")
    for skill in skills:
        skill_dir = install / "skills" / skill
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text("# SKILL\n", encoding="utf-8")
    return install


def _write_manifest(install_root_path: Path, tag: str = "0.27.1") -> None:
    install_root_path.mkdir(parents=True, exist_ok=True)
    body = (
        f"ref: 'v{tag}'\n"
        "sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'\n"
        f"tag: 'v{tag}'\n"
        "fetched_at: '2026-05-11T15:30:52Z'\n"
        "fetched_by: 'run-install'\n"
        "managed_by: 'npm'\n"
    )
    (install_root_path / "VERSION").write_text(body, encoding="utf-8")


def _write_bare_marker(project_root: Path, value: str = "0.27.1") -> None:
    (project_root / "vbrief").mkdir(parents=True, exist_ok=True)
    (project_root / "vbrief" / ".deft-version").write_text(value + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Three-state exit code matrix
# ---------------------------------------------------------------------------


class TestExitCodes:
    """``run_checks`` returns the canonical 0/1/2 exit code shape."""

    def test_clean_project_returns_zero(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        _write_bare_marker(tmp_path, "0.27.1")

        result = fd.run_checks(tmp_path)

        assert result["exit_code"] == fd.EXIT_CLEAN
        for c in result["checks"]:
            assert c["status"] in ("pass", "skip"), c

    def test_missing_install_dir_returns_drift(self, fd, tmp_path):
        _write_agents_md(tmp_path)  # claims .deft/core but no dir on disk

        result = fd.run_checks(tmp_path)

        assert result["exit_code"] == fd.EXIT_DRIFT
        names = {c["name"]: c["status"] for c in result["checks"]}
        # quick-start can't resolve -> fail
        assert names["quick-start-resolves"] == "fail"
        # install dir absent -> fail
        assert names["install-path-consistency"] == "fail"

    def test_missing_agents_md_returns_drift_with_synthetic_check(self, fd, tmp_path):
        # No AGENTS.md, no install dir -> synthetic agents-md-present check fails.
        result = fd.run_checks(tmp_path)

        assert result["exit_code"] == fd.EXIT_DRIFT
        names = {c["name"]: c["status"] for c in result["checks"]}
        assert names["agents-md-present"] == "fail"

    def test_nonexistent_project_root_returns_config_error(self, fd, tmp_path):
        missing = tmp_path / "does-not-exist"
        result = fd.run_checks(missing)
        assert result["exit_code"] == fd.EXIT_CONFIG_ERROR
        assert result["errors"]


# ---------------------------------------------------------------------------
# Per-check matrix
# ---------------------------------------------------------------------------


class TestQuickStartResolves:
    def test_pass_when_quick_start_present(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path)
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "quick-start-resolves")
        assert check["status"] == "pass"

    def test_fail_when_quick_start_missing(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path, quick_start=False)
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "quick-start-resolves")
        assert check["status"] == "fail"
        assert "QUICK-START.md" in check["detail"]


class TestSkillPathsResolve:
    def test_pass_when_all_skills_resolve(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path, skills=("deft-directive-setup",))
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "pass"

    def test_fail_when_skill_path_missing(self, fd, tmp_path):
        # AGENTS.md references a skill not on disk.
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path, skills=())  # no skills dir
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "fail"
        assert ".deft/core/skills/deft-directive-setup/SKILL.md" in check["data"]["missing"]

    def test_fail_when_skill_is_redirect_stub(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path, skills=("deft-directive-setup",))
        # Overwrite the SKILL.md with a deprecation stub sentinel.
        stub_path = install / "skills" / "deft-directive-setup" / "SKILL.md"
        stub_path.write_text(
            "<!-- deft:deprecated-redirect -->\n# legacy stub\n",
            encoding="utf-8",
        )
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "fail"
        assert check["data"]["redirect_stubs"]

    def test_fail_when_legacy_redirect_stub_has_header_preamble(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path, skills=("deft-directive-setup",))
        stub_path = install / "skills" / "deft-directive-setup" / "SKILL.md"
        stub_path.write_text(
            "<!-- DEFT-PREAMBLE-V1 -->\n"
            "<!-- deft:deprecated-redirect -->\n"
            "# legacy stub\n",
            encoding="utf-8",
        )
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "fail"
        assert check["data"]["redirect_stubs"] == [
            ".deft/core/skills/deft-directive-setup/SKILL.md"
        ]

    def test_fail_when_skill_is_deprecated_skill_redirect_stub(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path, skills=("deft-directive-setup",))
        stub_path = install / "skills" / "deft-directive-setup" / "SKILL.md"
        stub_path.write_text(
            "<!-- DEFT-PREAMBLE-V1 -->\n"
            "<!-- deft:deprecated-skill-redirect -->\n"
            "# Deprecated skill path\n"
            "Read `deft/QUICK-START.md` for current routing.\n",
            encoding="utf-8",
        )
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "fail"
        assert check["data"]["redirect_stubs"] == [
            ".deft/core/skills/deft-directive-setup/SKILL.md"
        ]

    def test_pass_when_real_skill_mentions_redirect_sentinel(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path, skills=("deft-directive-setup",))
        skill_path = install / "skills" / "deft-directive-setup" / "SKILL.md"
        skill_path.write_text(
            "---\n"
            "name: deft-directive-setup\n"
            "---\n\n"
            "# Deft Directive Setup\n\n"
            "A project is pre-cutover when PROJECT.md contains neither the "
            "legacy `<!-- deft:deprecated-redirect -->` sentinel nor the "
            "current Purpose marker.\n",
            encoding="utf-8",
        )
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "pass"
        assert check["data"].get("redirect_stubs", []) == []

    def test_redirect_stub_header_window_boundary(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path, skills=("deft-directive-setup",))
        stub_path = install / "skills" / "deft-directive-setup" / "SKILL.md"

        covered_preamble = "\n".join(f"# preamble {i}" for i in range(7))
        stub_path.write_text(
            f"{covered_preamble}\n<!-- deft:deprecated-redirect -->\n# legacy stub\n",
            encoding="utf-8",
        )
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "fail"
        assert check["data"]["redirect_stubs"] == [
            ".deft/core/skills/deft-directive-setup/SKILL.md"
        ]

        uncovered_preamble = "\n".join(f"# preamble {i}" for i in range(8))
        stub_path.write_text(
            f"{uncovered_preamble}\n<!-- deft:deprecated-redirect -->\n# not a stub\n",
            encoding="utf-8",
        )
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "skill-paths-resolve")
        assert check["status"] == "pass"
        assert check["data"].get("redirect_stubs", []) == []


class TestManifestAgreement:
    def test_pass_when_manifest_and_bare_agree(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        _write_bare_marker(tmp_path, "0.27.1")
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "manifest-agreement")
        assert check["status"] == "pass"

    def test_fail_on_drift_between_manifest_and_bare(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        _write_bare_marker(tmp_path, "0.26.0")
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "manifest-agreement")
        assert check["status"] == "fail"
        assert check["data"]["authoritative"] == "manifest"

    def test_fail_when_manifest_missing_but_bare_present(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path)
        _write_bare_marker(tmp_path, "0.27.1")
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "manifest-agreement")
        assert check["status"] == "fail"
        assert (
            "missing" in check["detail"].lower()
            or "missing" in check["data"].get("manifest_path", "").lower()
            or "manifest" in check["detail"].lower()
        )

    def test_pass_when_only_manifest_present(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "manifest-agreement")
        assert check["status"] == "pass"

    def test_skip_when_neither_manifest_nor_bare(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path)
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "manifest-agreement")
        assert check["status"] == "skip"


class TestInstallPathConsistency:
    def test_pass_when_declared_install_dir_exists(self, fd, tmp_path):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path)
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "install-path-consistency")
        assert check["status"] == "pass"

    def test_fail_when_declared_install_dir_missing(self, fd, tmp_path):
        _write_agents_md(tmp_path, install_root=".deft/core")
        # No .deft/core/ directory on disk.
        result = fd.run_checks(tmp_path)
        check = next(c for c in result["checks"] if c["name"] == "install-path-consistency")
        assert check["status"] == "fail"


# ---------------------------------------------------------------------------
# CLI surface (--json, --project-root, --quiet)
# ---------------------------------------------------------------------------


class TestCli:
    def test_main_clean_returns_zero(self, fd, tmp_path, capsys):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        _write_bare_marker(tmp_path, "0.27.1")

        rc = fd.main(["--project-root", str(tmp_path)])

        assert rc == fd.EXIT_CLEAN
        captured = capsys.readouterr()
        assert "all checks pass" in captured.out

    def test_main_drift_returns_one(self, fd, tmp_path):
        _write_agents_md(tmp_path)  # no install tree -> drift
        rc = fd.main(["--project-root", str(tmp_path), "--quiet"])
        assert rc == fd.EXIT_DRIFT

    def test_main_json_emits_structured_payload(self, fd, tmp_path, capsys):
        _write_agents_md(tmp_path)
        _write_install_tree(tmp_path)
        rc = fd.main(["--project-root", str(tmp_path), "--json"])
        captured = capsys.readouterr()
        payload = json.loads(captured.out)
        assert "exit_code" in payload
        assert "project_root" in payload
        assert "install_root" in payload
        assert "checks" in payload
        assert isinstance(payload["checks"], list)
        for c in payload["checks"]:
            assert {"name", "status", "detail", "data"}.issubset(c.keys())
        assert rc == payload["exit_code"]

    def test_main_quiet_suppresses_clean_summary(self, fd, tmp_path, capsys):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        _write_bare_marker(tmp_path, "0.27.1")

        rc = fd.main(["--project-root", str(tmp_path), "--quiet"])

        assert rc == fd.EXIT_CLEAN
        captured = capsys.readouterr()
        assert captured.out.strip() == ""

    def test_project_root_override_isolates_to_temp(self, fd, tmp_path):
        # If --project-root override is honored, the cwd of pytest should
        # NOT pollute the probe (cwd is the directive repo root which has
        # a real AGENTS.md and install tree).
        rc = fd.main(["--project-root", str(tmp_path), "--quiet"])
        # tmp_path is empty -> agents-md-present synthetic check fails.
        assert rc == fd.EXIT_DRIFT


# ---------------------------------------------------------------------------
# #814 UTF-8 reconfigure regression
# ---------------------------------------------------------------------------


class TestUtf8Reconfigure:
    """The success summary uses U+2713 (\u2713); cp1252 streams must reconfigure."""

    def test_main_reconfigures_stdout_to_utf8(self, fd, tmp_path, monkeypatch):
        _write_agents_md(tmp_path)
        install = _write_install_tree(tmp_path)
        _write_manifest(install, tag="0.27.1")
        _write_bare_marker(tmp_path, "0.27.1")

        # Swap stdout for an io.TextIOWrapper that simulates the Windows
        # git hook cp1252 default. ``main()`` MUST call ``reconfigure``
        # to switch it to utf-8 (otherwise printing the U+2713 success
        # marker raises UnicodeEncodeError).
        buf = io.BytesIO()
        # latin-1 encoding has no U+2713 glyph either -- forcing reconfigure
        # is the only path that produces output without raising.
        stream = io.TextIOWrapper(buf, encoding="latin-1", errors="strict")
        monkeypatch.setattr(sys, "stdout", stream)

        rc = fd.main(["--project-root", str(tmp_path)])

        stream.flush()
        assert rc == fd.EXIT_CLEAN
        # Output bytes contain the UTF-8 encoded U+2713.
        assert b"\xe2\x9c\x93" in buf.getvalue()


# ---------------------------------------------------------------------------
# #1272: ``task framework:doctor`` is now a redacted shim.
# ---------------------------------------------------------------------------
#
# The legacy ``task framework:doctor`` surface (which used to dispatch the
# python probe above) is redacted in favour of ``task doctor`` ->
# ``.deft/core/run doctor``. The redacted shim MUST emit the canonical
# phrase ``redacted use run doctor instead`` exactly. This is a
# YAML-text assertion -- a true end-to-end shell-out would require
# go-task to be available in the test environment, which we don't
# guarantee.


class TestFrameworkDoctorTaskRedaction:
    """Verify ``tasks/framework.yml`` task ``doctor`` is the #1272 redaction shim."""

    FRAMEWORK_TASKFILE = REPO_ROOT / "tasks" / "framework.yml"
    REDACTION_PHRASE = "redacted use run doctor instead"

    def test_framework_yml_doctor_task_emits_redaction_phrase(self):
        """The framework:doctor task body MUST emit the canonical phrase."""
        body = self.FRAMEWORK_TASKFILE.read_text(encoding="utf-8")
        assert self.REDACTION_PHRASE in body, (
            f"task framework:doctor MUST emit exactly "
            f"'{self.REDACTION_PHRASE}' (#1272). tasks/framework.yml:\n{body}"
        )

    def test_framework_yml_doctor_task_no_longer_dispatches_python_probe(self):
        """The redaction shim MUST NOT dispatch the legacy python probe."""
        body = self.FRAMEWORK_TASKFILE.read_text(encoding="utf-8")
        # The shim invokes a one-line ``echo`` / ``Write-Output``; the
        # legacy probe invocation used ``scripts/framework_doctor.py``.
        # Locate the ``doctor:`` task header, then inspect everything
        # below it up to the next top-level task or EOF. Strip comment
        # lines so the assertion is on the actual task body (the docstring
        # comments correctly reference the legacy probe by name).
        #
        # Limitation (tests reviewer MINOR-4): this filter only drops
        # WHOLE-LINE comments (lines whose first non-whitespace character
        # is ``#``). A YAML line carrying an INLINE trailing comment
        # (e.g. ``cmds: [echo done]  # framework_doctor.py ran here``)
        # would NOT be stripped and would (correctly) fail this
        # assertion -- the goal is to forbid actual probe dispatch, so
        # mentioning the legacy name in a trailing comment on a real
        # task line is a yellow flag worth surfacing. We deliberately do
        # NOT try to strip inline ``#`` comments from the middle of YAML
        # lines: that would require a quote-aware parser to avoid
        # corrupting ``#`` characters inside quoted strings, which is
        # brittle for the value gained. If a future maintainer needs to
        # carry an inline reference to the legacy probe name, route it
        # to a whole-line comment instead.
        marker = "\n  doctor:\n"
        assert marker in body, body
        tail = body.split(marker, 1)[1]
        non_comment = "\n".join(
            line for line in tail.splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "framework_doctor.py" not in non_comment, (
            "task framework:doctor MUST be redacted to a one-line shim "
            "(#1272); the task body (excluding comments) must not invoke "
            "scripts/framework_doctor.py."
        )
