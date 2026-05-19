"""tests/cli/test_verify_scm_boundary.py -- gate unit tests (#1145 / N5).

Three-state contract under test:

- Exit 0 -- every in-scope file uses ``scm.call`` exclusively (clean tree).
- Exit 1 -- a violation is detected (a fixture with a raw
  ``subprocess.run(["gh", ...])`` in scope).
- Exit 2 -- config error: ``--allow-list`` path unreadable, or
  ``--project-root`` invalid.

The fixture-violation test is the primary acceptance pin from issue
#1145: the gate MUST detect a raw ``subprocess gh`` call. Each test
uses ``tmp_path`` so the temp-file fixture does NOT count as a tracked
violation in the real repo -- the verifier scopes by glob relative to
``project_root`` and the fixture lives under that temp root.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

verify_scm_boundary = importlib.import_module("verify_scm_boundary")


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _write_scripts(
    tmp_path: Path, files: dict[str, str]
) -> Path:
    """Materialise a fake project root with the given ``scripts/<name>`` files."""
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        (scripts_dir / name).write_text(body, encoding="utf-8")
    return tmp_path


# Canonical clean body: a verb-layer file that routes through scm.call.
_CLEAN_VERB_BODY = """\
import scm
def do_thing() -> None:
    scm.call("github-issue", "issue", ["view", "1"], check=True)
"""

# Canonical violation body: a verb-layer file with a raw subprocess gh call.
# This is what a regression would look like; the verifier must flag it.
_VIOLATION_VERB_BODY = """\
import subprocess
def do_thing() -> None:
    subprocess.run(["gh", "issue", "view", "1"], check=True)
"""


# ---------------------------------------------------------------------------
# Exit 0 -- clean tree
# ---------------------------------------------------------------------------


class TestCleanTree:
    """Every in-scope verb-layer file uses ``scm.call`` -- exit 0."""

    def test_empty_scripts_dir_exits_zero(self, tmp_path: Path) -> None:
        # No verb-layer files at all -- the scope glob produces zero hits
        # and the gate exits 0 with the "N files clean" message. Mirrors
        # a checkout that has not yet landed any triage/scope verbs.
        (tmp_path / "scripts").mkdir(parents=True, exist_ok=True)
        code, findings, msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 0
        assert findings == []
        assert "clean" in msg

    def test_clean_verb_layer_exits_zero(self, tmp_path: Path) -> None:
        _write_scripts(
            tmp_path,
            {
                "triage_actions.py": _CLEAN_VERB_BODY,
                "scope_lifecycle.py": _CLEAN_VERB_BODY,
                "issue_ingest.py": _CLEAN_VERB_BODY,
            },
        )
        code, findings, msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 0, msg
        assert findings == []
        # "3 verb-layer file(s) clean" -- assert the count surfaces so a
        # regression that drops files silently is caught.
        assert "3 verb-layer file(s)" in msg


# ---------------------------------------------------------------------------
# Exit 1 -- violation detected
# ---------------------------------------------------------------------------


class TestViolationDetected:
    """A raw ``subprocess gh`` call in scope produces exit 1."""

    def test_subprocess_run_gh_flagged(self, tmp_path: Path) -> None:
        # Primary acceptance pin from #1145: the gate detects a fixture
        # with a raw ``subprocess.run(["gh", ...])`` in a verb-layer file
        # and exits 1 with one finding.
        _write_scripts(tmp_path, {"triage_actions.py": _VIOLATION_VERB_BODY})
        code, findings, msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert len(findings) == 1
        f = findings[0]
        assert f.path == "scripts/triage_actions.py"
        assert f.helper == "subprocess.run"
        # The fixture's subprocess.run sits on line 3; pin so an off-by-one
        # in ast lineno extraction would fail loud.
        assert f.line == 3
        assert "gh" in f.context
        # The error message must point at the canonical fix (import scm /
        # scm.call) so the operator knows how to remediate.
        assert "scm.call" in msg
        assert "#445" in msg

    def test_subprocess_check_output_gh_flagged(self, tmp_path: Path) -> None:
        # The ``check_output`` variant is the second-most common shape;
        # confirm the gate catches it as well.
        body = (
            "import subprocess\n"
            "def do_thing():\n"
            "    subprocess.check_output([\"gh\", \"api\", \"repos/x/y/issues/1\"])\n"
        )
        _write_scripts(tmp_path, {"triage_refresh.py": body})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert any(f.helper == "subprocess.check_output" for f in findings)

    def test_popen_gh_flagged(self, tmp_path: Path) -> None:
        # ``Popen`` (the unqualified bare-name import shape) and
        # ``subprocess.Popen`` (the attribute shape) must both be caught.
        body = (
            "from subprocess import Popen\n"
            "def do_thing():\n"
            "    p = Popen([\"gh\", \"issue\", \"list\"])\n"
            "    p.wait()\n"
        )
        _write_scripts(tmp_path, {"scope_demote.py": body})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert any(f.helper == "Popen" for f in findings)

    def test_subprocess_popen_attribute_gh_flagged(self, tmp_path: Path) -> None:
        # The ``subprocess.Popen(...)`` (attribute form) is the canonical
        # dotted shape; pin parity with the bare-name form above.
        body = (
            "import subprocess\n"
            "def do_thing():\n"
            "    subprocess.Popen([\"gh\", \"pr\", \"list\"])\n"
        )
        _write_scripts(tmp_path, {"scope_undo.py": body})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert any(f.helper == "subprocess.Popen" for f in findings)

    def test_os_system_gh_flagged(self, tmp_path: Path) -> None:
        # ``os.system("gh ...")`` is the legacy shell-invocation surface;
        # we catch it even though it's unusual in production code.
        body = (
            "import os\n"
            "def do_thing():\n"
            "    os.system(\"gh issue close 1\")\n"
        )
        _write_scripts(tmp_path, {"slice_record.py": body})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert any(f.helper == "os.system" for f in findings)

    def test_ghx_flagged_alongside_gh(self, tmp_path: Path) -> None:
        # The shim's preference ladder routes through both gh AND ghx;
        # a verb-layer file invoking ghx directly bypasses the same
        # NotImplementedError indirection so the gate must catch it too.
        body = (
            "import subprocess\n"
            "def do_thing():\n"
            "    subprocess.run([\"ghx\", \"issue\", \"list\"])\n"
        )
        _write_scripts(tmp_path, {"triage_queue.py": body})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert any(f.helper == "subprocess.run" for f in findings)

    def test_multiline_subprocess_run_caught(self, tmp_path: Path) -> None:
        # The common indented multi-line shape (``subprocess.run([\n
        # "gh", "issue", ...]``) is what real codebases write; the AST
        # walk must catch it the same way as the single-line shape.
        body = (
            "import subprocess\n"
            "def do_thing():\n"
            "    subprocess.run(\n"
            "        [\n"
            "            \"gh\",\n"
            "            \"issue\",\n"
            "            \"close\",\n"
            "            \"1\",\n"
            "        ],\n"
            "        check=True,\n"
            "    )\n"
        )
        _write_scripts(tmp_path, {"triage_welcome.py": body})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1
        assert len(findings) == 1


# ---------------------------------------------------------------------------
# Exit 2 -- config error
# ---------------------------------------------------------------------------


class TestConfigError:
    """Bad CLI shape (missing allow-list, invalid project root) exits 2."""

    def test_missing_allow_list_path_exits_two(self, tmp_path: Path) -> None:
        # A non-existent --allow-list path is a config error (not a
        # violation) -- the operator typo'd the flag and the gate must
        # tell them, not pass silently.
        (tmp_path / "scripts").mkdir(parents=True, exist_ok=True)
        missing = tmp_path / "does-not-exist.txt"
        code, findings, msg = verify_scm_boundary.evaluate(
            tmp_path, allow_list_path=missing
        )
        assert code == 2
        assert findings == []
        assert "not found" in msg

    def test_invalid_project_root_exits_two(self, tmp_path: Path) -> None:
        bogus = tmp_path / "definitely-not-a-real-directory"
        code, _findings, msg = verify_scm_boundary.evaluate(bogus)
        assert code == 2
        assert "is not a directory" in msg


# ---------------------------------------------------------------------------
# Allow-list behavior
# ---------------------------------------------------------------------------


class TestAllowList:
    """Custom --allow-list patterns exempt a documented file from the scan."""

    def test_allow_listed_file_not_flagged(self, tmp_path: Path) -> None:
        # Author a violation in a scope-glob-matching path, then exempt it
        # via --allow-list. The gate must return exit 0.
        _write_scripts(tmp_path, {"triage_actions.py": _VIOLATION_VERB_BODY})
        allow_file = tmp_path / "allow.txt"
        allow_file.write_text(
            "# Documented exception: regression fixture for #1145 tests.\n"
            "scripts/triage_actions.py\n",
            encoding="utf-8",
        )
        code, findings, _msg = verify_scm_boundary.evaluate(
            tmp_path, allow_list_path=allow_file
        )
        assert code == 0
        assert findings == []

    def test_allow_list_glob_supported(self, tmp_path: Path) -> None:
        # The allow-list accepts globs (mirrors verify_encoding.py); a
        # pattern that matches the violation file must exempt it.
        _write_scripts(
            tmp_path,
            {
                "triage_actions.py": _VIOLATION_VERB_BODY,
                "triage_refresh.py": _CLEAN_VERB_BODY,
            },
        )
        allow_file = tmp_path / "allow.txt"
        allow_file.write_text("scripts/triage_actions.py\n", encoding="utf-8")
        code, _findings, _msg = verify_scm_boundary.evaluate(
            tmp_path, allow_list_path=allow_file
        )
        assert code == 0


# ---------------------------------------------------------------------------
# Scope -- out-of-scope files NOT scanned
# ---------------------------------------------------------------------------


class TestScopeBoundary:
    """Files outside :data:`SCOPE_GLOBS` are NOT scanned even with violations."""

    def test_release_py_not_scanned(self, tmp_path: Path) -> None:
        # release.py is intentionally out of scope (release tooling has
        # legitimate direct-gh responsibilities) -- a raw gh call there
        # MUST NOT trigger a violation. This pin guards against a future
        # over-eager SCOPE_GLOBS that includes release tooling.
        _write_scripts(tmp_path, {"release.py": _VIOLATION_VERB_BODY})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 0
        assert findings == []

    def test_gh_rest_py_not_scanned(self, tmp_path: Path) -> None:
        # gh_rest.py is the REST helper module that legitimately invokes
        # gh directly via its own _run_gh_api seam; the verifier must
        # not flag it.
        _write_scripts(tmp_path, {"gh_rest.py": _VIOLATION_VERB_BODY})
        code, _findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 0

    @pytest.mark.parametrize(
        "in_scope_name",
        [
            "triage_actions.py",
            "triage_refresh.py",
            "scope_lifecycle.py",
            "scope_demote.py",
            "slice_record.py",
            "_triage_scope_milestone.py",
            "_scope_helper.py",
            "resume_conditions.py",
            "issue_ingest.py",
        ],
    )
    def test_in_scope_glob_match(self, tmp_path: Path, in_scope_name: str) -> None:
        # Each entry in SCOPE_GLOBS must match the documented filename set;
        # this parametrised pin guards against a typo in the glob list that
        # would silently exclude a verb-layer file from the gate.
        _write_scripts(tmp_path, {in_scope_name: _VIOLATION_VERB_BODY})
        code, findings, _msg = verify_scm_boundary.evaluate(tmp_path)
        assert code == 1, (
            f"{in_scope_name} should be in scope but the gate returned 0"
        )
        assert findings


# ---------------------------------------------------------------------------
# main() exit-code plumbing
# ---------------------------------------------------------------------------


class TestMainExitCodes:
    """End-to-end argv -> exit code plumbing via main()."""

    def test_main_clean_returns_zero(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        _write_scripts(tmp_path, {"triage_actions.py": _CLEAN_VERB_BODY})
        rc = verify_scm_boundary.main([
            "--project-root", str(tmp_path),
        ])
        assert rc == 0
        out = capsys.readouterr().out
        assert "clean" in out

    def test_main_violation_returns_one(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        _write_scripts(tmp_path, {"triage_actions.py": _VIOLATION_VERB_BODY})
        rc = verify_scm_boundary.main([
            "--project-root", str(tmp_path),
        ])
        assert rc == 1
        err = capsys.readouterr().err
        assert "raw" in err and "gh" in err

    def test_main_missing_allow_list_returns_two(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        (tmp_path / "scripts").mkdir(parents=True, exist_ok=True)
        rc = verify_scm_boundary.main([
            "--project-root", str(tmp_path),
            "--allow-list", str(tmp_path / "missing.txt"),
        ])
        assert rc == 2
        err = capsys.readouterr().err
        assert "not found" in err
