"""Tests for ``scripts/setup_ghx.py`` -- the consent-gated ghx installer (#884).

Covers the four-branch behaviour matrix documented in the script's module
docstring:

- ``ghx`` already on PATH -> "already on PATH" message + exit 0.
- ``ghx`` missing, decline -> "recommended for speed" note + exit 0.
- ``ghx`` missing, consent (interactive ``y``) -> install dispatch + exit 0.
- ``ghx`` missing, ``--yes`` flag -> install dispatch (no prompt) + exit 0.
- ``--yes`` AND ``--check`` -> exit 2 (config error).
- ``--check`` flag -> never install / never prompt; exit 0 either way.

The install-dispatch branch is mocked end-to-end via ``subprocess.run`` so
the suite never invokes the real upstream installer (which would download
binaries and mutate PATH on the host). Host detection (Windows /
Darwin / Linux) is exercised via ``platform.system`` patches; the assertion
shape pins the upstream-installer URL contract so a regression that
swapped the URL or the shell trampoline would fail loudly.

Mirrors the test patterns established in ``test_migrate_preflight.py``
(#793) -- module loaded once via importlib for hermeticity, ``shutil.which``
+ ``subprocess.run`` patched per test.
"""

from __future__ import annotations

import importlib.util
import io
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "setup_ghx.py"


def _load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def setup_ghx() -> Any:
    """Load ``scripts/setup_ghx.py`` fresh per test run."""
    return _load_module("setup_ghx", SCRIPT_PATH)


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------


class TestGhxPresent:
    """``ghx_present`` is the canonical detection helper."""

    def test_returns_true_when_ghx_on_path(
        self, setup_ghx: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            setup_ghx.shutil,
            "which",
            lambda name: "/usr/local/bin/ghx" if name == "ghx" else None,
        )
        assert setup_ghx.ghx_present() is True

    def test_returns_false_when_ghx_missing(
        self, setup_ghx: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(setup_ghx.shutil, "which", lambda name: None)
        assert setup_ghx.ghx_present() is False


class TestDetectHost:
    """Host normalisation for the install-dispatch branch."""

    @pytest.mark.parametrize(
        "system_value,expected",
        [
            ("Darwin", "darwin"),
            ("Linux", "linux"),
            ("Windows", "windows"),
            # Anything else is forwarded lowercased; the dispatch branch
            # raises a friendly error in that case.
            ("FreeBSD", "freebsd"),
        ],
    )
    def test_canonical_tag_per_host(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        system_value: str,
        expected: str,
    ) -> None:
        monkeypatch.setattr(platform, "system", lambda: system_value)
        assert setup_ghx.detect_host() == expected


# ---------------------------------------------------------------------------
# build_install_command argv shape (the Story 1 -> CI handoff guard)
# ---------------------------------------------------------------------------


class TestBuildInstallCommand:
    """Pin the upstream-installer URL + shell trampoline contract."""

    def test_windows_uses_powershell_irm_pipeline(
        self, setup_ghx: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            setup_ghx.shutil,
            "which",
            lambda name: "/fake/pwsh" if name == "pwsh" else None,
        )
        cmd = setup_ghx.build_install_command("windows")
        assert cmd[0] == "/fake/pwsh"
        assert cmd[1:5] == ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]
        # The piped invocation MUST reference the upstream install.ps1 URL
        # documented in the brunoborges/ghx README. A regression that
        # swapped the URL or the trampoline would fail this assertion
        # rather than silently invoking the wrong network call.
        assert setup_ghx.INSTALL_PS1_URL in cmd[-1]
        assert "irm" in cmd[-1] and "iex" in cmd[-1]

    def test_windows_falls_back_to_powershell_when_pwsh_missing(
        self, setup_ghx: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            setup_ghx.shutil,
            "which",
            lambda name: "/fake/powershell" if name == "powershell" else None,
        )
        cmd = setup_ghx.build_install_command("windows")
        assert cmd[0] == "/fake/powershell"

    @pytest.mark.parametrize("host", ["darwin", "linux"])
    def test_unix_uses_curl_pipe_bash(self, setup_ghx: Any, host: str) -> None:
        cmd = setup_ghx.build_install_command(host)
        assert cmd[0] == "bash"
        assert cmd[1] == "-c"
        # The piped invocation MUST reference the upstream install.sh URL.
        assert setup_ghx.INSTALL_SH_URL in cmd[2]
        assert "curl -fsSL" in cmd[2]

    def test_unknown_host_raises(self, setup_ghx: Any) -> None:
        with pytest.raises(RuntimeError, match="no upstream ghx installer"):
            setup_ghx.build_install_command("plan9")

    def test_installer_urls_pinned_to_ghx_version_tag(self, setup_ghx: Any) -> None:
        # Greptile #950 P2 regression guard: the installer URL itself MUST be
        # pinned to GHX_VERSION (not the unpinned `main` branch) so a future
        # upstream regression on `main` cannot flow into either trampoline.
        # If a refactor swaps the URL pin back to `main`, this assertion
        # fails loudly rather than silently widening the trust surface.
        assert f"/{setup_ghx.GHX_VERSION}/" in setup_ghx.INSTALL_PS1_URL
        assert f"/{setup_ghx.GHX_VERSION}/" in setup_ghx.INSTALL_SH_URL
        # Defence in depth: the literal token `/main/` must NOT appear in
        # either URL -- a regression to the unpinned default branch is the
        # exact failure mode #950 P2 surfaced.
        assert "/main/" not in setup_ghx.INSTALL_PS1_URL
        assert "/main/" not in setup_ghx.INSTALL_SH_URL


class TestInstallGhx:
    """``install_ghx`` is a thin wrapper over ``subprocess.run``."""

    def test_install_uses_runner_kwarg_and_returns_exitcode(
        self, setup_ghx: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        def fake_runner(cmd: list[str], check: bool = False, **kwargs: object) -> Any:
            captured["cmd"] = cmd
            captured["check"] = check
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        rc = setup_ghx.install_ghx("linux", runner=fake_runner)
        assert rc == 0
        assert captured["cmd"][0] == "bash"
        # We never want to raise on non-zero from the installer; the
        # caller decides how to surface the failure.
        assert captured["check"] is False

    def test_install_propagates_nonzero_exitcode(self, setup_ghx: Any) -> None:
        def fake_runner(cmd: list[str], check: bool = False, **kwargs: object) -> Any:
            return subprocess.CompletedProcess(args=cmd, returncode=42)

        assert setup_ghx.install_ghx("linux", runner=fake_runner) == 42

    def test_install_injects_ghx_version_into_subprocess_env(
        self, setup_ghx: Any
    ) -> None:
        # Greptile #950 P1 regression guard: the upstream installer scripts
        # honour ${GHX_VERSION} as the version-pin hook. Without explicit
        # injection into the subprocess env, the operator-side `task setup:ghx`
        # could install a different binary version than the CI pre-install
        # step despite the documented lockstep contract. This test asserts
        # both that an `env=` kwarg is passed AND that the value carries
        # the canonical GHX_VERSION from the module.
        captured: dict[str, Any] = {}

        def fake_runner(cmd: list[str], check: bool = False, **kwargs: object) -> Any:
            captured["env"] = kwargs.get("env")
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        rc = setup_ghx.install_ghx("linux", runner=fake_runner)
        assert rc == 0
        assert captured["env"] is not None, (
            "install_ghx MUST pass env= to subprocess.run so GHX_VERSION reaches "
            "the upstream installer (Greptile #950 P1)"
        )
        assert captured["env"].get("GHX_VERSION") == setup_ghx.GHX_VERSION

    def test_install_env_inherits_parent_environment(
        self, setup_ghx: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The injected env MUST be a copy of os.environ + GHX_VERSION; we
        # cannot replace the parent env with a single-key dict because the
        # upstream installers also read PATH, HOME, USER, etc. The merge
        # via `{**os.environ, "GHX_VERSION": GHX_VERSION}` is the documented
        # idiom; this test asserts a sentinel parent-env entry survives the
        # merge.
        monkeypatch.setenv("DEFT_TEST_SENTINEL", "sentinel-value")
        captured: dict[str, Any] = {}

        def fake_runner(cmd: list[str], check: bool = False, **kwargs: object) -> Any:
            captured["env"] = kwargs.get("env")
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        setup_ghx.install_ghx("linux", runner=fake_runner)
        assert captured["env"]["DEFT_TEST_SENTINEL"] == "sentinel-value"
        assert captured["env"]["GHX_VERSION"] == setup_ghx.GHX_VERSION


# ---------------------------------------------------------------------------
# prompt_consent
# ---------------------------------------------------------------------------


class TestPromptConsent:
    """Default-deny consent prompt mirrors #884 constraint."""

    @pytest.mark.parametrize("answer", ["y", "Y", "yes", "YES", "Yes\n", " y \n"])
    def test_y_or_yes_returns_true(self, setup_ghx: Any, answer: str) -> None:
        sin = io.StringIO(answer)
        sout = io.StringIO()
        assert setup_ghx.prompt_consent(stream_in=sin, stream_out=sout) is True

    @pytest.mark.parametrize("answer", ["", "\n", "n", "N", "no", "maybe", "  "])
    def test_anything_else_returns_false(self, setup_ghx: Any, answer: str) -> None:
        sin = io.StringIO(answer)
        sout = io.StringIO()
        # Empty stream (EOF on a non-tty CI shell) MUST default-deny so
        # a non-interactive `task setup` never installs by accident.
        assert setup_ghx.prompt_consent(stream_in=sin, stream_out=sout) is False


# ---------------------------------------------------------------------------
# main() -- end-to-end branch coverage
# ---------------------------------------------------------------------------


class TestMain:
    """End-to-end branch coverage for the entry point."""

    def test_ghx_already_present_skips_prompt_and_install(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # Detection true -> short-circuit before any prompt or subprocess.
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: True)
        # Sentinel: if main() reaches the install path, the test fails.
        monkeypatch.setattr(
            setup_ghx,
            "install_ghx",
            lambda *a, **kw: pytest.fail("install_ghx must not be called"),
        )
        rc = setup_ghx.main([])
        assert rc == 0
        out = capsys.readouterr().out
        assert "ghx already on PATH" in out

    def test_check_flag_with_missing_ghx_exits_clean_no_prompt(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # `--check` is the Taskfile-side detection-only path: no prompt,
        # no install, exit 0 with a recommendation note.
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(
            setup_ghx,
            "prompt_consent",
            lambda *a, **kw: pytest.fail("prompt_consent must not be called"),
        )
        monkeypatch.setattr(
            setup_ghx,
            "install_ghx",
            lambda *a, **kw: pytest.fail("install_ghx must not be called"),
        )
        rc = setup_ghx.main(["--check"])
        assert rc == 0
        out = capsys.readouterr().out
        assert "ghx not on PATH" in out
        assert "#884" in out

    def test_yes_and_check_combined_returns_2(
        self,
        setup_ghx: Any,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        rc = setup_ghx.main(["--yes", "--check"])
        assert rc == 2
        err = capsys.readouterr().err
        assert "mutually exclusive" in err

    def test_decline_prints_recommendation_and_exits_clean(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(setup_ghx, "prompt_consent", lambda *a, **kw: False)
        monkeypatch.setattr(
            setup_ghx,
            "install_ghx",
            lambda *a, **kw: pytest.fail("install_ghx must not be called on decline"),
        )
        # Ensure the env-var opt-out does NOT short-circuit -- this test
        # exercises the user-typed-N branch specifically.
        monkeypatch.delenv("DEFT_SETUP_GHX_SKIP", raising=False)
        rc = setup_ghx.main([])
        assert rc == 0
        out = capsys.readouterr().out
        assert "Skipping ghx install" in out
        assert "recommended for speed" in out

    def test_env_var_opt_out_skips_prompt_and_install(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        # DEFT_SETUP_GHX_SKIP=1 lets non-interactive shells suppress the
        # prompt without passing --check explicitly. Mirrors the
        # DEFT_NO_NETWORK / DEFT_FORCE_REMOTE_PROBE precedent (#801).
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(
            setup_ghx,
            "prompt_consent",
            lambda *a, **kw: pytest.fail("prompt_consent must not be called"),
        )
        monkeypatch.setattr(
            setup_ghx,
            "install_ghx",
            lambda *a, **kw: pytest.fail("install_ghx must not be called"),
        )
        monkeypatch.setenv("DEFT_SETUP_GHX_SKIP", "1")
        rc = setup_ghx.main([])
        assert rc == 0
        out = capsys.readouterr().out
        assert "DEFT_SETUP_GHX_SKIP" in out

    def test_yes_flag_dispatches_install_without_prompting(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(
            setup_ghx,
            "prompt_consent",
            lambda *a, **kw: pytest.fail("prompt_consent must not be called under --yes"),
        )
        captured: dict[str, Any] = {}

        def fake_install(host: str, **kw: object) -> int:
            captured["host"] = host
            return 0

        monkeypatch.setattr(setup_ghx, "install_ghx", fake_install)
        # Make detect_host deterministic so the assertion does not depend
        # on the test runner's host platform.
        monkeypatch.setattr(setup_ghx, "detect_host", lambda: "linux")
        rc = setup_ghx.main(["--yes"])
        assert rc == 0
        assert captured["host"] == "linux"
        out = capsys.readouterr().out
        assert "ghx installed" in out

    def test_consent_y_dispatches_install(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(setup_ghx, "prompt_consent", lambda *a, **kw: True)
        monkeypatch.setattr(setup_ghx, "detect_host", lambda: "darwin")
        monkeypatch.delenv("DEFT_SETUP_GHX_SKIP", raising=False)
        captured: dict[str, Any] = {}

        def fake_install(host: str, **kw: object) -> int:
            captured["host"] = host
            return 0

        monkeypatch.setattr(setup_ghx, "install_ghx", fake_install)
        rc = setup_ghx.main([])
        assert rc == 0
        assert captured["host"] == "darwin"

    def test_install_failure_returns_1(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(setup_ghx, "detect_host", lambda: "linux")
        monkeypatch.setattr(setup_ghx, "install_ghx", lambda host, **kw: 7)
        rc = setup_ghx.main(["--yes"])
        assert rc == 1
        err = capsys.readouterr().err
        assert "exited 7" in err

    def test_unknown_host_raises_to_exit_1(
        self,
        setup_ghx: Any,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setattr(setup_ghx, "ghx_present", lambda: False)
        monkeypatch.setattr(setup_ghx, "detect_host", lambda: "plan9")

        def fake_install(host: str, **kw: object) -> int:
            raise RuntimeError(
                f"no upstream ghx installer available for host {host!r}"
            )

        monkeypatch.setattr(setup_ghx, "install_ghx", fake_install)
        rc = setup_ghx.main(["--yes"])
        assert rc == 1
        err = capsys.readouterr().err
        assert "no upstream ghx installer" in err
