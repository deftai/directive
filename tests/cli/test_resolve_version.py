"""test_resolve_version.py -- Tests for scripts/resolve_version.py (#723, #771).

``scripts/resolve_version.py`` is an INDEPENDENT Python mirror of the
resolution priority chain implemented inline in ``Taskfile.yml``
``vars: VERSION: { sh: ... }``. The Python module is NOT invoked from
Taskfile.yml -- these tests pin the Python-side contract so callers
(``scripts/release.py::run_build``, future Python entry-points) cannot
silently drift from the canonical Taskfile sh: block.

Covers the three resolution branches:
- ``$DEFT_RELEASE_VERSION`` env override wins over git tag.
- ``git describe --tags --abbrev=0`` fallback (stripped of leading ``v``).
- ``0.0.0-dev`` fallback when neither env nor git produce a value.
- ``main()`` writes the resolved version to stdout WITHOUT a trailing newline.

Also covers the canonical PEP 440 normalization helper added in #771:
- ``to_pep440`` maps ``vX.Y.Z`` -> ``X.Y.Z`` and pre-release tokens
  ``rc.N`` / ``alpha.N`` / ``beta.N`` -> PEP 440 compressed form ``rcN`` /
  ``aN`` / ``bN``.
- Non-publishable tags (``test.N``) raise ``NonPublishableVersionError``.
- Malformed input raises generic ``ValueError`` (caught by
  ``is_publishable`` as non-publishable).
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "resolve_version",
        scripts_dir / "resolve_version.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["resolve_version"] = module
    spec.loader.exec_module(module)
    return module


resolve_version = _load_module()


# ---------------------------------------------------------------------------
# _from_env
# ---------------------------------------------------------------------------


class TestFromEnv:
    def test_returns_value_when_set(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.21.0")
        assert resolve_version._from_env() == "0.21.0"

    def test_returns_none_when_unset(self, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        assert resolve_version._from_env() is None

    def test_returns_none_when_empty(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "")
        assert resolve_version._from_env() is None

    def test_strips_whitespace(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "  0.21.0\n")
        assert resolve_version._from_env() == "0.21.0"

    def test_returns_none_on_pure_whitespace(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "   \n")
        assert resolve_version._from_env() is None


# ---------------------------------------------------------------------------
# _from_git
# ---------------------------------------------------------------------------


class TestFromGit:
    def test_strips_leading_v(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v0.20.2\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() == "0.20.2"

    def test_returns_unprefixed_tag(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="0.21.0\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() == "0.21.0"

    def test_returns_none_when_git_missing(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_on_timeout(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, timeout=10)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_on_nonzero_exit(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="No names found", returncode=128
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_on_empty_stdout(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None

    def test_returns_none_when_only_v(self, monkeypatch):
        # Defensive: a tag that is bare "v" should not become an empty version.
        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version._from_git() is None


# ---------------------------------------------------------------------------
# resolve_version (priority chain)
# ---------------------------------------------------------------------------


class TestResolveVersion:
    def test_env_wins_over_git(self, monkeypatch):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.21.0")

        def fake_run(cmd, **kwargs):  # pragma: no cover - asserted not called
            raise AssertionError("git must not be invoked when env is set")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version.resolve_version() == "0.21.0"

    def test_git_used_when_env_missing(self, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v0.20.2\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version.resolve_version() == "0.20.2"

    def test_dev_fallback_when_neither_available(self, monkeypatch):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert resolve_version.resolve_version() == resolve_version.DEV_FALLBACK
        assert resolve_version.DEV_FALLBACK == "0.0.0-dev"


# ---------------------------------------------------------------------------
# main (stdout contract: byte-for-byte match with the Taskfile sh: block)
# ---------------------------------------------------------------------------


class TestMain:
    def test_main_writes_resolved_version_without_trailing_newline(
        self, monkeypatch, capsys
    ):
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.21.0")
        rc = resolve_version.main([])
        assert rc == 0
        captured = capsys.readouterr()
        # The no-trailing-newline contract matches the inline POSIX `sh:`
        # block in Taskfile.yml (which uses `printf '%s'`) byte-for-byte.
        # The Python module is NOT invoked from Taskfile.yml -- it mirrors
        # the same shape so Python callers receive the identical string.
        assert captured.out == "0.21.0"
        assert "\n" not in captured.out

    def test_main_default_is_dev_when_nothing_resolves(self, monkeypatch, capsys):
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        rc = resolve_version.main([])
        assert rc == 0
        captured = capsys.readouterr()
        assert captured.out == "0.0.0-dev"


# ---------------------------------------------------------------------------
# Regression: subprocess smoke test (only runs when python is on PATH)
# ---------------------------------------------------------------------------


class TestSubprocessSmoke:
    def test_subprocess_invocation_with_env_override(self, monkeypatch):
        # Run the script as a real subprocess to exercise the
        # ``if __name__ == \"__main__\"`` guard and the os.environ path.
        env_override = "0.99.0"
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "resolve_version.py")],
            capture_output=True,
            text=True,
            env={**__import__("os").environ, "DEFT_RELEASE_VERSION": env_override},
            check=False,
        )
        assert result.returncode == 0
        assert result.stdout == env_override


# ---------------------------------------------------------------------------
# to_pep440 (#771): canonical semver -> PEP 440 normalization helper
# ---------------------------------------------------------------------------


class TestToPep440Stable:
    """Stable releases: ``vX.Y.Z`` -> ``"X.Y.Z"`` (or already-bare)."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("v0.22.0", "0.22.0"),
            ("0.22.0", "0.22.0"),
            ("v1.0.0", "1.0.0"),
            ("v10.20.30", "10.20.30"),
            ("v0.0.1", "0.0.1"),
            ("V0.22.0", None),  # uppercase ``V`` is NOT accepted; expect parse error
        ],
    )
    def test_stable_mappings(self, raw, expected):
        if expected is None:
            with pytest.raises(ValueError):
                resolve_version.to_pep440(raw)
        else:
            assert resolve_version.to_pep440(raw) == expected

    def test_v_prefix_optional(self):
        # The leading ``v`` is optional so callers can pass either the
        # raw tag or an already-stripped value (matching ``_from_git``).
        assert resolve_version.to_pep440("v0.22.0") == resolve_version.to_pep440("0.22.0")

    def test_strips_whitespace(self):
        assert resolve_version.to_pep440("  v0.22.0  ") == "0.22.0"


class TestToPep440PreRelease:
    """Pre-release tag mapping (#771 acceptance criteria)."""

    def test_rc_compressed(self):
        # ``rc.3`` -> ``rc3`` (no separator) per PEP 440 normalization.
        assert resolve_version.to_pep440("v0.20.0-rc.3") == "0.20.0rc3"

    def test_beta_compressed_to_b(self):
        # PEP 440 spells ``beta`` as ``b``.
        assert resolve_version.to_pep440("v0.20.0-beta.2") == "0.20.0b2"

    def test_alpha_compressed_to_a(self):
        # PEP 440 spells ``alpha`` as ``a``.
        assert resolve_version.to_pep440("v0.20.0-alpha.1") == "0.20.0a1"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("v0.20.0-rc.0", "0.20.0rc0"),
            ("v0.20.0-rc.10", "0.20.0rc10"),
            ("v0.20.0-beta.0", "0.20.0b0"),
            ("v0.20.0-beta.99", "0.20.0b99"),
            ("v0.20.0-alpha.0", "0.20.0a0"),
            ("v0.20.0-alpha.42", "0.20.0a42"),
            # Without leading v, same mapping.
            ("0.20.0-rc.3", "0.20.0rc3"),
            ("0.20.0-beta.2", "0.20.0b2"),
            ("0.20.0-alpha.1", "0.20.0a1"),
        ],
    )
    def test_pre_release_mappings_parametrized(self, raw, expected):
        assert resolve_version.to_pep440(raw) == expected


class TestToPep440NonPublishable:
    """Non-publishable / disposable tags raise NonPublishableVersionError."""

    def test_test_tag_raises_non_publishable(self):
        # The exact acceptance case from the #771 vBRIEF.
        with pytest.raises(resolve_version.NonPublishableVersionError):
            resolve_version.to_pep440("v0.0.0-test.1")

    @pytest.mark.parametrize(
        "raw",
        [
            "v0.0.0-test.1",
            "v0.0.0-test.0",
            "v0.0.0-test.99",
            "v0.22.0-test.5",  # Non-publishable irrespective of the X.Y.Z value.
            "0.0.0-test.1",  # Without leading v.
        ],
    )
    def test_test_tag_variants_raise(self, raw):
        with pytest.raises(resolve_version.NonPublishableVersionError):
            resolve_version.to_pep440(raw)

    def test_non_publishable_subclasses_value_error(self):
        # Catch-blocks that already trap ``ValueError`` (e.g. argparse
        # error reporting) MUST keep working post-#771.
        assert issubclass(
            resolve_version.NonPublishableVersionError, ValueError
        )

    def test_non_publishable_message_cites_tag(self):
        # The pipeline embeds the exception message in the operator-readable
        # Step 5 log line; the message MUST cite the tag verbatim and the
        # ``test`` kind so operators can identify the skip cause.
        with pytest.raises(
            resolve_version.NonPublishableVersionError,
            match=r"v0\.0\.0-test\.1.*test",
        ):
            resolve_version.to_pep440("v0.0.0-test.1")


class TestToPep440Malformed:
    """Generic ValueError for inputs that do not parse as semver-shaped."""

    @pytest.mark.parametrize(
        "raw",
        [
            "",  # empty
            "   ",  # whitespace-only
            "abc",  # garbage
            "v0.22",  # only two parts
            "v0.22.0.0",  # four parts
            "0.22",  # only two parts, no v
            "v0.22.0+build",  # build metadata not supported
            "v0.22.0-rc",  # missing .N
            "v0.22.0-rc.",  # trailing dot, no number
            "v0.22.0-gamma.1",  # unknown kind token
            "v0.22.0-RC.1",  # uppercase kind token (we are case-sensitive)
            "vv0.22.0",  # double-v
            "0.22.0-1",  # missing kind
        ],
    )
    def test_malformed_raises_value_error(self, raw):
        with pytest.raises(ValueError):
            resolve_version.to_pep440(raw)

    def test_non_string_input_raises(self):
        with pytest.raises(ValueError):
            resolve_version.to_pep440(None)  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            resolve_version.to_pep440(0.22)  # type: ignore[arg-type]


class TestIsPublishable:
    """is_publishable returns False for both non-publishable + malformed."""

    @pytest.mark.parametrize(
        "raw",
        [
            "v0.22.0",
            "v0.20.0-rc.3",
            "v0.20.0-beta.2",
            "v0.20.0-alpha.1",
            "0.22.0",
            "v1.0.0",
        ],
    )
    def test_publishable_versions(self, raw):
        assert resolve_version.is_publishable(raw) is True

    @pytest.mark.parametrize(
        "raw",
        [
            "v0.0.0-test.1",
            "v0.22.0-test.5",
            "",
            "abc",
            "v0.22",
            "v0.22.0+build",
        ],
    )
    def test_non_publishable_versions(self, raw):
        assert resolve_version.is_publishable(raw) is False


class TestPep440PhaseCExtensionHook:
    """Documents the #771 Phase C contract: future pip packaging consumes
    ``to_pep440`` rather than reimplementing the rule. The test below
    exercises every documented mapping in a single round-trip so a
    future change to the helper that breaks any of the canonical
    mappings fails fast.
    """

    def test_canonical_acceptance_table(self):
        cases = {
            "v0.22.0": "0.22.0",
            "v0.20.0-rc.3": "0.20.0rc3",
            "v0.20.0-beta.2": "0.20.0b2",
            "v0.20.0-alpha.1": "0.20.0a1",
        }
        for raw, expected in cases.items():
            assert resolve_version.to_pep440(raw) == expected, (
                f"#771 canonical mapping drift: {raw!r} -> {expected!r}"
            )
        with pytest.raises(resolve_version.NonPublishableVersionError):
            resolve_version.to_pep440("v0.0.0-test.1")
