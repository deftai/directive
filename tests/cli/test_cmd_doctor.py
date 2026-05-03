"""
test_cmd_doctor.py -- Tests for cmd_doctor (#792).

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

Sibling to `test_doctor.py` (the broad happy-path smoke test from
Subphase 3.5 of the CLI regression suite). Author: Deft Directive
agent (msadams) -- 2026-05-03.

Refs: #792, related #793.
"""

from __future__ import annotations

import shutil


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
