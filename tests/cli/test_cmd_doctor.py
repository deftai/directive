"""
test_cmd_doctor.py -- Tests for cmd_doctor (#792, #1272).

Covers:
  * `_check_uv_available` helper -- the shared uv-detection seam #793
    will reuse.
  * uv-present branch: cmd_doctor reports uv as installed and does NOT
    surface a uv-missing error.
  * uv-missing branch: cmd_doctor returns non-zero, prints an actionable
    error containing the canonical install URL, and surfaces the error
    in the consolidated summary above optional-tool warnings.
  * expected_dirs layout: cmd_doctor reports zero `Missing directory:`
    warnings against the live framework checkout (locks the v0.20+
    canonical layout into a regression test) and refuses any pre-v0.20
    legacy entry.
  * #1272 root Taskfile include diagnostics:
      - missing root Taskfile.yml in a consumer project: diagnose + print
        canonical snippet; default mode MUST NOT mutate filesystem state.
      - existing root Taskfile.yml without the deft include: diagnose +
        print snippet; doctor MUST NEVER mutate an existing user-owned
        Taskfile.
      - existing root Taskfile.yml WITH the deft include: ok.
      - `--session` flag: diagnose-only; even when ``--fix`` is also
        passed, MUST NOT prompt or write.
      - `--fix` interactive consent: when stdin is a TTY AND the user
        approves, the canonical snippet is written verbatim.
      - `--fix` decline: when stdin is a TTY but the user declines, no
        write.
      - the deft framework repo itself (cwd has ``main.md`` and no
        ``deft/``) skips the Taskfile diagnostic entirely.

Sibling to `test_doctor.py` (the broad happy-path smoke test from
Subphase 3.5 of the CLI regression suite). Author: Deft Directive
agent (msadams) -- 2026-05-03; #1272 coverage added 2026-05-21.

Refs: #792, #1272, related #793.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest


def _make_fake_which(presence: dict[str, bool]):
    """Return a ``shutil.which`` replacement that overrides selected names.

    ``presence`` maps a command name to True (force-present, return a
    plausible-looking path) or False (force-missing, return None). Any
    command not in the mapping falls through to the real
    :func:`shutil.which` so the rest of the doctor's checks stay
    realistic on the host. Keeping the pass-through reads-real-PATH
    semantics matches how the production helpers work and avoids
    accidentally turning every other tool into a forced-miss.
    """
    real_which = shutil.which

    def _fake(cmd, *args, **kwargs):
        if cmd in presence:
            return f"/fake/path/to/{cmd}" if presence[cmd] else None
        return real_which(cmd, *args, **kwargs)

    return _fake


def test_check_uv_available_returns_true_when_present(deft_run_module, monkeypatch):
    """`_check_uv_available` returns True when shutil.which finds `uv`."""
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True}),
    )

    assert deft_run_module._check_uv_available() is True


def test_check_uv_available_returns_false_when_missing(deft_run_module, monkeypatch):
    """`_check_uv_available` returns False when shutil.which yields None for `uv`."""
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": False}),
    )

    assert deft_run_module._check_uv_available() is False


def test_doctor_uv_missing_returns_nonzero_with_install_url(
    run_command, deft_run_module, monkeypatch
):
    """cmd_doctor exits non-zero with the canonical uv install URL when uv is absent."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": False}),
    )

    result = run_command("cmd_doctor", [])

    assert result.return_code == 1, (
        "cmd_doctor must exit non-zero when uv is missing -- otherwise a "
        "fresh-machine user gets a green doctor and then opaque "
        "`uv: command not found` failures from every task script. "
        f"Got rc={result.return_code}\nstdout:\n{result.stdout}"
    )
    assert "uv (Astral Python runner) not found" in result.stdout, (
        f"Expected uv-missing error line in stdout:\n{result.stdout}"
    )
    assert "https://docs.astral.sh/uv/" in result.stdout, (
        "Expected install URL pointer mirroring "
        "skills/deft-directive-setup/SKILL.md \u00a7 Environment Preflight; "
        f"got:\n{result.stdout}"
    )
    # Summary line must mention the error so the failure is unambiguous in CI.
    assert "System check failed" in result.stdout, (
        f"Expected 'System check failed' summary line; got:\n{result.stdout}"
    )


def test_doctor_uv_present_no_uv_error(run_command, deft_run_module, monkeypatch):
    """When uv is on PATH, cmd_doctor reports it installed and emits no uv-missing error."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True}),
    )

    result = run_command("cmd_doctor", [])

    assert "uv (Astral Python runner) is installed" in result.stdout, (
        f"Expected uv-installed success line; got:\n{result.stdout}"
    )
    assert "uv (Astral Python runner) not found" not in result.stdout, (
        "uv was force-present in this test; cmd_doctor must not emit "
        f"a uv-missing error. stdout:\n{result.stdout}"
    )


def test_doctor_no_spurious_missing_directory_warnings(
    run_command, deft_run_module, monkeypatch
):
    """Against the live framework checkout, cmd_doctor emits zero `Missing directory:` lines.

    Locks the v0.20+ canonical layout into a regression test (#792). If
    a future cleanup removes one of the listed directories the test
    surfaces it loudly instead of letting cmd_doctor go quietly stale
    again.
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    # Force uv-present so the test exercises the directory-check path
    # only, regardless of whether the host CI has uv installed.
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True}),
    )

    result = run_command("cmd_doctor", [])

    missing_lines = [
        line for line in result.stdout.splitlines()
        if "Missing directory:" in line
    ]
    assert not missing_lines, (
        "cmd_doctor must report zero spurious 'Missing directory:' "
        "warnings on a clean v0.20+ checkout (#792). Offending lines:\n"
        + "\n".join(missing_lines)
    )


def test_doctor_expected_dirs_drops_pre_v020_entries(
    run_command, deft_run_module, monkeypatch
):
    """The dir-check section must not include any of the pre-v0.20 legacy names.

    Belt-and-suspenders for the regression test above: even if a stray
    legacy directory ends up in the live tree (so the missing-warning
    test passes by coincidence), this assertion fails fast if cmd_doctor
    re-adds `core`, `interfaces`, `tools`, `swarm`, or `meta` to its
    expected_dirs constant.
    """
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True}),
    )

    result = run_command("cmd_doctor", [])

    # cmd_doctor prints `Directory: <name>/` for every entry in
    # expected_dirs that resolves on disk. The pre-v0.20 names MUST NOT
    # appear in those success lines under any circumstances.
    legacy = ("core", "interfaces", "tools", "swarm", "meta")
    for name in legacy:
        assert f"Directory: {name}/" not in result.stdout, (
            f"cmd_doctor must not check for pre-v0.20 directory '{name}/' "
            "(#792 dropped it from expected_dirs). stdout:\n"
            f"{result.stdout}"
        )


# ---------------------------------------------------------------------------
# #1272 root Taskfile.yml include diagnostics
# ---------------------------------------------------------------------------
#
# Helpers + fixtures for the consumer-project shape: a tmp directory the
# test ``chdir``s into. Critically, we DO NOT create ``main.md`` at the
# root -- the ``_running_inside_deft_repo`` heuristic would otherwise
# short-circuit the include diagnostic to keep deft maintainers from
# nagging on every doctor invocation against the framework checkout
# itself.


CANONICAL_INCLUDE_FRAGMENT = "taskfile: ./.deft/core/Taskfile.yml"

# Sample of an existing user-owned Taskfile.yml that does NOT yet wire
# in the deft framework. The test asserts doctor surfaces this state
# and does NOT mutate the file.
USER_TASKFILE_WITHOUT_INCLUDE = (
    "version: '3'\n"
    "\n"
    "tasks:\n"
    "  hello:\n"
    "    cmds:\n"
    "      - echo \"hi\"\n"
)

# Sample of a Taskfile that ALREADY includes deft -- doctor should report
# the include as OK.
USER_TASKFILE_WITH_INCLUDE = (
    "version: '3'\n"
    "\n"
    "includes:\n"
    "  deft:\n"
    "    taskfile: ./.deft/core/Taskfile.yml\n"
    "    optional: true\n"
)


@pytest.fixture
def consumer_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Set up a tmp directory shaped like a consumer project (no ``main.md``).

    The fixture chdirs into the tmp path so ``Path.cwd()`` inside
    ``cmd_doctor`` resolves to the consumer-project shape, which is
    what makes the ``_running_inside_deft_repo`` heuristic return False
    and exercise the Taskfile-include diagnostic.
    """
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_doctor_missing_taskfile_yml_diagnoses_with_snippet(
    run_command, deft_run_module, monkeypatch, consumer_project
):
    """Missing root Taskfile.yml: diagnose + print canonical snippet; no mutation."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )

    result = run_command("cmd_doctor", [])

    assert "Root Taskfile.yml missing" in result.stdout, (
        "cmd_doctor must surface the missing-Taskfile diagnostic for the "
        "adoption-blocker shape (#1272). stdout:\n" + result.stdout
    )
    assert CANONICAL_INCLUDE_FRAGMENT in result.stdout, (
        "Diagnostic MUST emit the canonical include snippet so the operator "
        "can paste it without leaving the terminal. stdout:\n" + result.stdout
    )
    # Default mode (no --fix) MUST NOT mutate filesystem state.
    assert not (consumer_project / "Taskfile.yml").exists(), (
        "Default `run doctor` invocation MUST NOT create Taskfile.yml -- "
        "only the interactive `--fix` path with explicit consent may write."
    )
    # The error must surface in the summary so the run exits non-zero.
    assert result.return_code == 1, (
        f"Missing Taskfile.yml is a doctor-detected error; expected rc=1, "
        f"got {result.return_code}\n{result.stdout}"
    )


def test_doctor_existing_taskfile_without_include_diagnoses_no_mutation(
    run_command, deft_run_module, monkeypatch, consumer_project
):
    """Existing root Taskfile.yml without the deft include: diagnose; never mutate."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )
    taskfile = consumer_project / "Taskfile.yml"
    taskfile.write_text(USER_TASKFILE_WITHOUT_INCLUDE, encoding="utf-8")
    original_bytes = taskfile.read_bytes()

    result = run_command("cmd_doctor", ["--fix"])

    assert "does not include the deft framework" in result.stdout, (
        "Doctor MUST surface the missing-include diagnostic when a root "
        "Taskfile.yml exists but has no deft include. stdout:\n" + result.stdout
    )
    assert CANONICAL_INCLUDE_FRAGMENT in result.stdout, (
        "The paste-ready snippet MUST be emitted so the operator can wire "
        "the include without leaving the terminal. stdout:\n" + result.stdout
    )
    # The install-policy prohibition is load-bearing: even with --fix
    # passed, doctor MUST NEVER mutate an existing user-owned Taskfile.
    assert taskfile.read_bytes() == original_bytes, (
        "Doctor MUST NEVER mutate an existing user-owned Taskfile.yml -- "
        "even with `--fix` passed. The install policy in main.md is "
        "explicit on this; doctor mirrors it."
    )
    assert result.return_code == 1


def test_doctor_existing_taskfile_with_include_reports_ok(
    run_command, deft_run_module, monkeypatch, consumer_project
):
    """Existing root Taskfile.yml WITH the deft include reports the diagnostic green."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )
    (consumer_project / "Taskfile.yml").write_text(
        USER_TASKFILE_WITH_INCLUDE, encoding="utf-8"
    )

    result = run_command("cmd_doctor", [])

    assert "Root Taskfile.yml includes the deft framework" in result.stdout, (
        "With the canonical include wired in, doctor MUST report it green. "
        "stdout:\n" + result.stdout
    )
    assert "Root Taskfile.yml missing" not in result.stdout
    assert "does not include the deft framework" not in result.stdout


def test_doctor_session_mode_diagnoses_only_no_prompt_no_mutation(
    run_command, deft_run_module, monkeypatch, consumer_project
):
    """--session never prompts and never mutates, even when --fix is also passed."""
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )

    # Force-stub stdin.isatty() to True so the production gate at
    # ``run`` ~4374-4378 (``fix_mode and not session_mode and
    # sys.stdin.isatty()``) cannot short-circuit on ``isatty()=False``
    # under pytest's stdin capture. Without this stub the test would
    # pass even if the ``not session_mode`` clause silently regressed,
    # because pytest's captured stdin reports ``isatty()=False`` and
    # the gate would never reach ``read_yn`` regardless of the
    # ``--session`` flag. Mirrors the ``_FakeStdin`` pattern used by
    # the ``--fix`` consent / decline tests below so the assertion
    # discriminates the ``--session`` bypass from the isatty bypass.
    class _FakeStdin:
        @staticmethod
        def isatty() -> bool:
            return True

    monkeypatch.setattr(deft_run_module.sys, "stdin", _FakeStdin())

    # Wire read_yn to a sentinel that raises if called. --session MUST
    # never reach the prompt; if it does, the test surfaces the bug
    # loudly rather than silently writing under a fake "yes".
    def _explode(*_args, **_kwargs):
        raise AssertionError(
            "--session MUST NOT prompt for repair confirmation -- "
            "session-safe mode is diagnose-only by contract (#1272)"
        )

    monkeypatch.setattr(deft_run_module, "read_yn", _explode)

    result = run_command("cmd_doctor", ["--session", "--fix"])

    # Diagnostic still surfaces.
    assert "Root Taskfile.yml missing" in result.stdout
    # No mutation.
    assert not (consumer_project / "Taskfile.yml").exists(), (
        "--session MUST NOT write any files. The Taskfile.yml was created "
        "in a session-safe invocation, which violates the #1272 contract."
    )


def test_doctor_fix_with_consent_creates_canonical_taskfile(
    run_command, deft_run_module, doctor_module, monkeypatch, consumer_project
):
    """--fix + TTY + explicit consent writes the canonical snippet verbatim."""
    # After Epic-1 #1335, the interactive --fix path lives in
    # scripts/doctor.py (the run::cmd_doctor shim defers to doctor.cmd_doctor).
    # Patches MUST target the doctor_module namespace -- monkeypatching
    # deft_run.read_yn / HAS_RICH is invisible to the running code because
    # those name lookups resolve under doctor_module's globals, not deft_run's.
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(doctor_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )

    # Fake TTY so the interactive repair gate opens. ``sys`` is a shared
    # module object so setting the attribute via either deft_run.sys or
    # doctor_module.sys is equivalent -- both rebind the global sys.stdin.
    class _FakeStdin:
        @staticmethod
        def isatty() -> bool:
            return True

    monkeypatch.setattr(doctor_module.sys, "stdin", _FakeStdin())
    # Operator approves. Patch doctor_module.read_yn (the actual call site).
    monkeypatch.setattr(
        doctor_module, "read_yn", lambda *_args, **_kwargs: True
    )

    result = run_command("cmd_doctor", ["--fix"])

    target = consumer_project / "Taskfile.yml"
    assert target.is_file(), (
        "Interactive --fix with explicit consent MUST create Taskfile.yml. "
        f"stdout:\n{result.stdout}"
    )
    written = target.read_text(encoding="utf-8")
    # Must match the canonical snippet byte-for-byte so the docs and the
    # write path do not drift over time.
    assert written == doctor_module._TASKFILE_INCLUDE_SNIPPET
    # Drift decrement: after a successful in-session repair, the summary
    # should report success rather than 1 error.
    assert "Wrote" in result.stdout


def test_doctor_fix_decline_does_not_write(
    run_command, deft_run_module, doctor_module, monkeypatch, consumer_project
):
    """--fix + TTY + decline leaves Taskfile.yml absent."""
    # See test_doctor_fix_with_consent_creates_canonical_taskfile for why
    # the patches target doctor_module after Epic-1 #1335.
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(doctor_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )

    class _FakeStdin:
        @staticmethod
        def isatty() -> bool:
            return True

    monkeypatch.setattr(doctor_module.sys, "stdin", _FakeStdin())
    monkeypatch.setattr(
        doctor_module, "read_yn", lambda *_args, **_kwargs: False
    )

    result = run_command("cmd_doctor", ["--fix"])

    assert not (consumer_project / "Taskfile.yml").exists(), (
        "Decline at the --fix prompt MUST leave Taskfile.yml absent. "
        f"stdout:\n{result.stdout}"
    )
    # Both substrings co-occur on the production decline path (see the
    # ``info(...)`` block in ``scripts/doctor.py`` around the canonical-include
    # diagnostic), so ``or`` would pass even if one of them silently
    # regressed. Use ``and`` so a drift in either token surfaces here.
    assert "Skipped" in result.stdout and "snippet above" in result.stdout, (
        "Decline-path output must include BOTH the 'Skipped' lead-in and the "
        "'snippet above' paste-pointer so the operator sees the full "
        f"recovery message. stdout:\n{result.stdout}"
    )


def _seed_deft_repo_markers(root: Path) -> None:
    """Seed the positive markers required by the tightened heuristic.

    The pass-2 review tightened ``_running_inside_deft_repo`` to require
    BOTH ``templates/agents-entry.md`` and
    ``skills/deft-directive-build/SKILL.md`` in addition to the existing
    ``main.md`` + no-install-dir checks (#1303 pass-2 SLizard P1 +
    Greptile carryover). Tests that simulate "inside the deft repo"
    MUST seed both files so the heuristic fires; consumer-shaped
    fixtures that lack these files are correctly classified as NOT the
    deft repo.
    """
    (root / "templates").mkdir(parents=True, exist_ok=True)
    (root / "templates" / "agents-entry.md").write_text(
        "# fake agents-entry template\n", encoding="utf-8"
    )
    (root / "skills" / "deft-directive-build").mkdir(parents=True, exist_ok=True)
    (root / "skills" / "deft-directive-build" / "SKILL.md").write_text(
        "# fake deft-directive-build SKILL\n", encoding="utf-8"
    )


def test_doctor_inside_deft_repo_skips_taskfile_check(
    run_command, deft_run_module, monkeypatch, tmp_path
):
    """When invoked from inside the deft framework repo itself, skip the Taskfile diagnostic.

    The tightened ``_running_inside_deft_repo`` heuristic fires only
    when ALL of: ``main.md`` present, no ``./deft`` AND no
    ``./.deft/core`` install dir, AND every entry in
    ``_DEFT_REPO_POSITIVE_MARKERS`` resolves. Doctor must skip the
    consumer-side include diagnostic when the heuristic fires so
    framework maintainers do not see spurious errors against the
    framework's own Taskfile.yml (#1303 pass-2 review).
    """
    (tmp_path / "main.md").write_text("# fake framework root\n", encoding="utf-8")
    _seed_deft_repo_markers(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(deft_run_module, "HAS_RICH", False)
    monkeypatch.setattr(
        deft_run_module.shutil,
        "which",
        _make_fake_which({"uv": True, "git": True}),
    )

    result = run_command("cmd_doctor", [])

    assert "Skipping Taskfile include check" in result.stdout, (
        "Inside the deft framework repo, doctor MUST emit the skip line so "
        "maintainers see why the diagnostic is silent. stdout:\n"
        + result.stdout
    )
    assert "Root Taskfile.yml missing" not in result.stdout, (
        "Doctor MUST NOT diagnose the framework repo's own Taskfile state "
        "as missing -- the framework's Taskfile.yml IS the surface."
    )


def test_running_inside_deft_repo_requires_positive_markers(
    deft_run_module, tmp_path
):
    """Tightened heuristic: ``main.md`` alone is NOT enough (#1303 pass-2 review).

    Regression guard for the pass-2 SLizard P1 + Greptile carryover:
    the pre-fix heuristic returned True for any directory that carried
    ``main.md`` and no ``./deft`` subdir, which mis-fired on consumer
    projects whose canonical install lived at ``./.deft/core/`` (no
    legacy ``./deft`` to negate) AND on consumers who happened to ship
    their own root-level ``main.md`` for unrelated reasons.

    The fix requires the presence of ``templates/agents-entry.md`` AND
    ``skills/deft-directive-build/SKILL.md`` -- framework-internal
    artefacts a consumer would have no reason to mirror. This test
    pins the negative direction: a tree carrying ONLY ``main.md`` MUST
    NOT classify as the deft framework repo.
    """
    (tmp_path / "main.md").write_text("# consumer's root main.md\n", encoding="utf-8")
    # Intentionally do NOT seed the positive markers -- this is a
    # consumer-shaped tree, not the framework checkout.
    assert deft_run_module._running_inside_deft_repo(tmp_path) is False, (
        "Consumer project with only main.md (no framework-internal "
        "markers) MUST NOT be classified as the deft framework repo."
    )


def test_running_inside_deft_repo_negates_canonical_install_dir(
    deft_run_module, tmp_path
):
    """Canonical ``./.deft/core/`` install also blocks the heuristic (#1303 pass-2).

    Pre-fix the heuristic only negated ``./deft``; a consumer who
    installed canonically at ``./.deft/core/`` had no legacy ``./deft``
    subdir, so any ``main.md`` at their root tripped the heuristic and
    silently skipped the Taskfile-include diagnostic. The fix also
    negates ``./.deft/core``.
    """
    (tmp_path / "main.md").write_text("# consumer's root main.md\n", encoding="utf-8")
    _seed_deft_repo_markers(tmp_path)
    # The presence of an installed framework at ``./.deft/core/``
    # signals this directory has deft INSTALLED into it -- it is not
    # the framework repo itself.
    (tmp_path / ".deft" / "core").mkdir(parents=True)
    assert deft_run_module._running_inside_deft_repo(tmp_path) is False, (
        "A consumer with ``./.deft/core/`` installed MUST NOT be "
        "classified as the deft framework repo even when main.md and "
        "the positive markers are also present."
    )


def test_classify_taskfile_include_recognises_legacy_deft_path(
    doctor_module, tmp_path
):
    """_classify_taskfile_include recognises both ``./.deft/core`` and ``./deft`` includes.

    Targets ``scripts/doctor.py`` (the canonical owner after Epic-1 #1335).
    """
    legacy_form = (
        "version: '3'\n"
        "includes:\n"
        "  deft:\n"
        "    taskfile: ./deft/Taskfile.yml\n"
        "    optional: true\n"
    )
    (tmp_path / "Taskfile.yml").write_text(legacy_form, encoding="utf-8")

    assert doctor_module._classify_taskfile_include(tmp_path) == "ok"


def test_classify_taskfile_include_missing_file_status(doctor_module, tmp_path):
    """Missing root Taskfile.yml AND Taskfile.yaml -> missing-file."""
    assert doctor_module._classify_taskfile_include(tmp_path) == "missing-file"


def test_classify_taskfile_include_yaml_extension(doctor_module, tmp_path):
    """Resolver accepts the ``.yaml`` spelling as well as ``.yml``."""
    (tmp_path / "Taskfile.yaml").write_text(
        "version: '3'\nincludes:\n  deft:\n    taskfile: ./.deft/core/Taskfile.yml\n",
        encoding="utf-8",
    )
    assert doctor_module._classify_taskfile_include(tmp_path) == "ok"


def test_classify_taskfile_include_strips_utf8_bom(doctor_module, tmp_path):
    """Taskfile.yml persisted with a UTF-8 BOM must still classify as ``ok``.

    Regression guard for the #1303 pass-2 correctness finding: Windows editors
    (Notepad and some VS Code configurations) persist YAML with a leading
    ``\ufeff`` byte. Reading via plain ``utf-8`` would keep the BOM in the
    decoded text, defeat the ``^[\\t ]*includes`` anchor in
    :func:`_includes_block_has_deft_taskfile`, and produce a spurious
    ``missing-include`` diagnostic on a legitimately wired Taskfile.

    Reading via ``utf-8-sig`` strips the BOM transparently. This test writes
    the BOM bytes EXPLICITLY (not via ``encoding="utf-8-sig"``) so the
    production read path is what's actually under test.
    """
    canonical = (
        "version: '3'\n"
        "includes:\n"
        "  deft:\n"
        "    taskfile: ./.deft/core/Taskfile.yml\n"
        "    optional: true\n"
    )
    target = tmp_path / "Taskfile.yml"
    target.write_bytes(b"\xef\xbb\xbf" + canonical.encode("utf-8"))

    assert doctor_module._classify_taskfile_include(tmp_path) == "ok"


# ---------------------------------------------------------------------------
# #1389 AGENTS.md managed-section freshness verdict (shared _agents_md module)
# ---------------------------------------------------------------------------
#
# Before #1389, scripts/doctor.py::_agents_refresh_plan was an interim stub
# that unconditionally returned ``{"state": "unreadable"}`` so
# ``_run_agents_md_freshness_check`` emitted a spurious AGENTS.md-freshness
# warning on EVERY consumer ``task doctor`` run -- even when the managed
# section was present, readable and fresh. The fix extracted the
# managed-section / refresh-plan helpers into the pure shared module
# ``scripts/_agents_md.py`` and wired doctor's plan to it, so the verdict is
# now a genuine fresh / stale / unreadable computation. These tests pin all
# three states plus the regression assertion that the stub is gone.

_FRESH_TEMPLATE = (
    "<!-- deft:managed-section v3 -->\n"
    "# Deft\n"
    "Body\n"
    "<!-- /deft:managed-section -->\n"
)


def _patch_shared_template(doctor_module, monkeypatch, template=_FRESH_TEMPLATE):
    """Patch the shared ``_agents_md`` template reader doctor's plan resolves through.

    doctor's ``_agents_refresh_plan`` delegates to the shared
    ``scripts/_agents_md`` module; the plan reads the canonical template via
    that module's ``_read_agents_template``, so the patch MUST target the
    loaded shared module (not ``doctor_module``) to control the rendered
    baseline the verdict compares against.
    """
    agents_md = doctor_module._load_agents_md_module()
    monkeypatch.setattr(agents_md, "_read_agents_template", lambda: template)
    return agents_md


def _collect_freshness(doctor_module, project_root):
    """Run ``_run_agents_md_freshness_check`` capturing every emitted surface."""
    msgs: dict = {"success": [], "warn": [], "info": [], "findings": []}
    doctor_module._run_agents_md_freshness_check(
        project_root,
        emit_success=lambda m: msgs["success"].append(m),
        emit_warn=lambda m: msgs["warn"].append(m),
        emit_info=lambda m: msgs["info"].append(m),
        add_finding=lambda severity, message, **extras: msgs["findings"].append(
            {"severity": severity, "message": message, **extras}
        ),
    )
    return msgs


def test_agents_refresh_plan_not_hardcoded_unreadable(
    doctor_module, tmp_path, monkeypatch
):
    """Regression for the #1389 stub: a fresh managed section -> 'current', not 'unreadable'.

    The interim stub returned ``{"state": "unreadable"}`` regardless of the
    on-disk AGENTS.md. The real plan (delegated to ``scripts/_agents_md``)
    must compute ``current`` for a byte-current managed section.
    """
    _patch_shared_template(doctor_module, monkeypatch)
    (tmp_path / "AGENTS.md").write_text(_FRESH_TEMPLATE, encoding="utf-8")

    plan = doctor_module._agents_refresh_plan(tmp_path)

    assert plan["state"] == "current", (
        "doctor._agents_refresh_plan must compute a real verdict via the "
        "shared scripts/_agents_md module, not the interim stub that always "
        f"returned 'unreadable'. Got {plan!r}."
    )
    assert plan["state"] != "unreadable"


def test_freshness_fresh_readable_emits_no_warning(
    doctor_module, tmp_path, monkeypatch
):
    """fresh + readable managed section -> success line, NO freshness warning (#1389)."""
    _patch_shared_template(doctor_module, monkeypatch)
    (tmp_path / "AGENTS.md").write_text(_FRESH_TEMPLATE, encoding="utf-8")

    msgs = _collect_freshness(doctor_module, tmp_path)

    assert msgs["warn"] == [], (
        "A consumer whose AGENTS.md managed section is present, readable and "
        "fresh MUST NOT see an AGENTS.md-freshness warning (#1389). Warnings: "
        f"{msgs['warn']}"
    )
    assert any("current" in s for s in msgs["success"]), (
        f"Expected a 'current' success line; got {msgs['success']}"
    )
    assert not any(f["severity"] == "warning" for f in msgs["findings"])


def test_freshness_stale_points_at_agents_refresh(
    doctor_module, tmp_path, monkeypatch
):
    """genuinely stale managed section -> warning pointing at `task agents:refresh` (#1389)."""
    _patch_shared_template(doctor_module, monkeypatch)
    (tmp_path / "AGENTS.md").write_text(
        "<!-- deft:managed-section v3 -->\nOLD STALE BODY\n<!-- /deft:managed-section -->\n",
        encoding="utf-8",
    )

    msgs = _collect_freshness(doctor_module, tmp_path)

    assert any("task agents:refresh" in w for w in msgs["warn"]), (
        "A stale managed section MUST point the operator at "
        f"`task agents:refresh`. Warnings: {msgs['warn']}"
    )
    warning_findings = [f for f in msgs["findings"] if f["severity"] == "warning"]
    assert warning_findings and warning_findings[0].get("status") == "stale", (
        f"Expected a stale warning finding; got {msgs['findings']}"
    )


def test_freshness_unreadable_still_warns(doctor_module, tmp_path, monkeypatch):
    """genuinely unreadable verdict -> warning still surfaces (#1389).

    A v3 marker is present so the check's gate (``_has_v3_managed_marker``)
    passes; the plan reports a genuinely-unreadable verdict (e.g. AGENTS.md
    became unreadable between the gate read and the plan read). The check
    MUST still warn so a real problem is never silently swallowed.
    """
    (tmp_path / "AGENTS.md").write_text(_FRESH_TEMPLATE, encoding="utf-8")
    monkeypatch.setattr(
        doctor_module,
        "_agents_refresh_plan",
        lambda project_root: {
            "state": "unreadable",
            "path": str(project_root / "AGENTS.md"),
        },
    )

    msgs = _collect_freshness(doctor_module, tmp_path)

    assert msgs["warn"], (
        "A genuinely unreadable AGENTS.md MUST still surface a warning (#1389)."
    )
    assert any(f["severity"] == "warning" for f in msgs["findings"])
