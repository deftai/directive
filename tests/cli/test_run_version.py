"""test_run_version.py -- Tests for `run`'s dynamic VERSION resolution (#741).

The framework CLI ``run`` previously hard-coded ``VERSION = "X.Y.Z"`` at
module top, requiring a manual literal bump every release cycle. The
v0.21.0 cut surfaced the resulting drift: ``run --help`` reported
``0.20.0`` for weeks after the v0.21.0 tag landed because nothing in the
release pipeline updated the literal.

#741 replaces the literal with an inline priority chain that mirrors
``scripts/resolve_version.py::resolve_version()`` (and the canonical
Taskfile ``vars: VERSION: { sh: ... }`` block from #723):

1. ``$DEFT_RELEASE_VERSION`` env override -- pinned by
   ``scripts/release.py::run_build`` during ``task release -- 0.X.Y``.
2. ``git describe --tags --abbrev=0`` (with leading ``v`` stripped) --
   ordinary checkouts on a tagged commit.
3. ``0.0.0-dev`` -- fresh checkouts with no tags or git unavailable.

These tests pin the priority chain at the ``run`` surface so future
contributors cannot silently re-introduce the literal-bump pattern. The
companion module ``tests/cli/test_resolve_version.py`` (#723) pins the
same chain at ``scripts/resolve_version.py``; the two files are
deliberately parallel so a regression in either surface is caught
independently.

Why this lives in a separate module rather than extending
``tests/cli/test_release.py`` (per the #741 vBRIEF acceptance):
``tests/cli/test_release.py`` is already 1771 lines, well over the
1000-line MUST limit set by ``AGENTS.md``. The existing pattern in this
repo is to split test modules along feature boundaries when the parent
exceeds the limit (cf. ``tests/cli/test_release_skip_flags.py`` and
``tests/cli/test_release_summary.py``). Keeping these tests in a focused
sibling module honours that pattern AND the AGENTS.md rule.

Refs:
  - deftai/directive#741 -- root regression issue (this fix)
  - deftai/directive#723 -- sibling Taskfile-side dynamic resolver
  - tests/cli/test_resolve_version.py -- parallel surface coverage
  - scripts/resolve_version.py -- Python mirror of the chain
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_PATH = REPO_ROOT / "run"


def _load_run_module(monkeypatch: pytest.MonkeyPatch | None = None) -> ModuleType:
    """Re-load the extension-less ``run`` script as a Python module.

    Each test gets its own freshly-loaded copy so module-load-time
    resolution (``VERSION = _resolve_version()``) re-runs against the
    monkeypatched env / subprocess. The ``deft_run_test`` module name
    is deliberately distinct from ``deft_run`` (used by ``run.py``)
    so the production shim is not perturbed.
    """
    loader = importlib.machinery.SourceFileLoader(
        "deft_run_test", str(RUN_PATH)
    )
    spec = importlib.util.spec_from_loader(
        "deft_run_test", loader, origin=str(RUN_PATH)
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(RUN_PATH)
    # Always replace the cached entry so successive calls in a test
    # session get a fresh resolution.
    sys.modules["deft_run_test"] = module
    loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Priority chain -- module-load-time VERSION assignment
# ---------------------------------------------------------------------------


class TestPriorityChain:
    """The ``VERSION`` constant is resolved at import time via the
    ``_resolve_version()`` helper. Each test monkeypatches the env /
    subprocess BEFORE re-importing ``run`` so the chain executes fresh.
    """

    def test_env_var_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "9.9.9")

        def fake_run(*args, **kwargs):  # pragma: no cover - asserted not called
            raise AssertionError("git must not be invoked when env is set")

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "9.9.9"

    def test_git_describe_used_when_env_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            # #1454: the resolver first probes the payload's git root, then
            # runs `git describe`. Report the payload dir as its own
            # top-level so the describe branch is reached.
            if cmd[:3] == ["git", "rev-parse", "--show-toplevel"]:
                return SimpleNamespace(
                    stdout=str(REPO_ROOT) + "\n", stderr="", returncode=0
                )
            assert cmd[:2] == ["git", "describe"], (
                f"unexpected subprocess call: {cmd!r}"
            )
            return SimpleNamespace(stdout="v0.21.0\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        # Leading `v` MUST be stripped to match the canonical
        # `scripts/resolve_version.py` contract.
        assert run_mod.VERSION == "0.21.0"

    def test_git_describe_unprefixed_tag_passthrough(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            if cmd[:3] == ["git", "rev-parse", "--show-toplevel"]:
                return SimpleNamespace(
                    stdout=str(REPO_ROOT) + "\n", stderr="", returncode=0
                )
            return SimpleNamespace(stdout="0.21.0\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.21.0"

    def test_dev_fallback_when_git_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("git")

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.0.0-dev"

    def test_dev_fallback_on_git_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, timeout=10)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.0.0-dev"

    def test_dev_fallback_on_git_nonzero_exit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A repo without any tags makes ``git describe`` exit 128."""
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(
                stdout="", stderr="No names found", returncode=128
            )

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.0.0-dev"

    def test_dev_fallback_on_empty_git_stdout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.0.0-dev"

    def test_dev_fallback_on_bare_v_tag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A defensive: tag ``v`` (post-strip empty) MUST NOT propagate."""
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)

        def fake_run(cmd, **kwargs):
            return SimpleNamespace(stdout="v\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.0.0-dev"

    def test_env_takes_priority_even_with_valid_git(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Env override MUST short-circuit the git probe (priority order)."""
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "0.99.0")
        called: list[list[str]] = []

        def fake_run(cmd, **kwargs):
            called.append(list(cmd))
            return SimpleNamespace(stdout="v0.21.0\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.99.0"
        assert called == [], (
            "subprocess.run MUST NOT be called when env override is set; got "
            f"{called!r}"
        )

    def test_env_whitespace_stripped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "  0.21.0\n")

        def fake_run(*args, **kwargs):  # pragma: no cover - guard
            raise AssertionError("git must not be invoked")

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        assert run_mod.VERSION == "0.21.0"

    def test_env_pure_whitespace_falls_through_to_git(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DEFT_RELEASE_VERSION", "   \n")

        def fake_run(cmd, **kwargs):
            if cmd[:3] == ["git", "rev-parse", "--show-toplevel"]:
                return SimpleNamespace(
                    stdout=str(REPO_ROOT) + "\n", stderr="", returncode=0
                )
            return SimpleNamespace(stdout="v0.21.0\n", stderr="", returncode=0)

        monkeypatch.setattr(subprocess, "run", fake_run)
        run_mod = _load_run_module(monkeypatch)
        # Pure-whitespace env value MUST be treated as unset, not as the
        # version literal " " or "".
        assert run_mod.VERSION == "0.21.0"


# ---------------------------------------------------------------------------
# No literal VERSION = "X.Y.Z" left in `run`
# ---------------------------------------------------------------------------


class TestNoLiteralVersion:
    """Defensive guard against future contributors re-introducing the
    static literal that #741 removed.
    """

    def test_no_static_version_literal(self) -> None:
        """The text ``VERSION = "X.Y.Z"`` MUST NOT appear in ``run``."""
        text = RUN_PATH.read_text(encoding="utf-8")
        # The dynamic assignment is `VERSION = _resolve_version()`. A
        # static literal of the form `VERSION = "0.20.0"` (or any other
        # quoted string) is what #741 forbids; allow ANY function-call
        # right-hand side. We use a deliberate substring scan rather
        # than a regex to keep the assertion easy to grep-and-fix.
        forbidden_starts = ('VERSION = "', "VERSION = '")
        offending_lines: list[tuple[int, str]] = []
        for idx, line in enumerate(text.splitlines(), start=1):
            stripped = line.lstrip()
            for prefix in forbidden_starts:
                if stripped.startswith(prefix):
                    offending_lines.append((idx, line))
        assert not offending_lines, (
            "Static `VERSION = \"X.Y.Z\"` literal forbidden in `run` per "
            f"#741. Offending lines: {offending_lines}"
        )

    def test_resolve_version_helper_present(self) -> None:
        """The dynamic resolver function MUST exist by name in ``run``."""
        text = RUN_PATH.read_text(encoding="utf-8")
        assert "def _resolve_version()" in text, (
            "`run` MUST define `_resolve_version()` -- the dynamic "
            "replacement for the removed VERSION literal per #741."
        )
        # Sanity: the dynamic assignment is the canonical wire-up point.
        assert "VERSION = _resolve_version()" in text, (
            "`run` MUST assign `VERSION = _resolve_version()` so the "
            "priority chain runs at module load time."
        )


# ---------------------------------------------------------------------------
# Smoke: VERSION is a non-empty string at the import surface used by run.py
# ---------------------------------------------------------------------------


def test_imported_version_is_non_empty_string() -> None:
    """The exported VERSION is what every command header / docstring uses.

    A regression that left it as ``None`` or ``""`` would silently
    corrupt every ``Deft CLI v{VERSION}`` panel.
    """
    run_mod = _load_run_module()
    assert isinstance(run_mod.VERSION, str)
    assert run_mod.VERSION.strip() != ""
    # The dev fallback OR a real semver-shape -- both are valid post-#741.
    # We do not pin to a specific number here because git state at test
    # time varies (CI on a tagged commit will see e.g. "0.21.0";
    # contributors on a feature branch see whatever the last reachable
    # tag is). The chain MUST always produce something usable.
    assert run_mod.VERSION  # non-empty sentinel-or-semver string


# ---------------------------------------------------------------------------
# #1454: git-describe fallback is gated on the payload's OWN git root
# ---------------------------------------------------------------------------


_HAS_GIT = shutil.which("git") is not None


def _init_git_repo(repo: Path, tag: str | None = None) -> None:
    """Initialise a throwaway git repo at ``repo`` with one (optionally
    tagged) empty commit. Author/committer identity is injected via env so
    the helper works on CI runners with no global git config.
    """
    repo.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
    }

    def _git(*args: str) -> None:
        subprocess.run(
            ["git", "-C", str(repo), *args],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )

    _git("init", "-q")
    _git("commit", "--allow-empty", "-q", "-m", "init")
    if tag is not None:
        _git("tag", tag)


def _load_run_module_from(run_file: Path) -> ModuleType:
    """Load a COPY of ``run`` from an arbitrary on-disk location.

    The #1454 guard keys off ``Path(__file__).parent`` (the payload dir),
    so the only faithful way to exercise the vendored-install path is to
    place a copy of ``run`` inside a synthetic ``.deft/core/`` tree and
    import it from there -- the module name is derived from the path so
    repeated loads do not clobber one another.
    """
    name = f"deft_run_copy_{abs(hash(str(run_file)))}"
    loader = importlib.machinery.SourceFileLoader(name, str(run_file))
    spec = importlib.util.spec_from_loader(name, loader, origin=str(run_file))
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(run_file)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


@pytest.mark.skipif(not _HAS_GIT, reason="git binary not available")
class TestGitRootGuard:
    """`_resolve_version` only trusts ``git describe`` when the framework
    payload directory is itself the git top-level. A vendored ``.deft/core/``
    install (no VERSION manifest, no ``.deft-version``) sitting inside a
    tagged consumer repo MUST resolve to the dev sentinel, NOT the
    consumer's tag (#1454, salvaged from #1447).
    """

    def test_payload_is_own_git_root_true_for_repo_root(self, tmp_path: Path) -> None:
        run_mod = _load_run_module()
        repo = tmp_path / "repo"
        _init_git_repo(repo, tag="v1.2.3")
        assert run_mod._payload_is_own_git_root(repo) is True

    def test_payload_is_own_git_root_false_for_subdir(self, tmp_path: Path) -> None:
        run_mod = _load_run_module()
        repo = tmp_path / "repo"
        _init_git_repo(repo, tag="v1.2.3")
        payload = repo / ".deft" / "core"
        payload.mkdir(parents=True)
        assert run_mod._payload_is_own_git_root(payload) is False

    def test_payload_is_own_git_root_false_outside_any_repo(
        self, tmp_path: Path
    ) -> None:
        run_mod = _load_run_module()
        loose = tmp_path / "loose"
        loose.mkdir()
        assert run_mod._payload_is_own_git_root(loose) is False

    def test_vendored_install_does_not_bleed_consumer_tag(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Headline #1454 regression: consumer tag must NOT leak into the
        framework version on a vendored install with no manifest."""
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        consumer = tmp_path / "consumer"
        _init_git_repo(consumer, tag="v9.9.9")
        payload = consumer / ".deft" / "core"
        payload.mkdir(parents=True)
        shutil.copy2(RUN_PATH, payload / "run")
        run_mod = _load_run_module_from(payload / "run")
        assert run_mod.VERSION == "0.0.0-dev"

    def test_self_dev_payload_uses_git_describe(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When the payload IS its own git root (framework self-dev), the
        ``git describe`` fallback still resolves the real tag."""
        monkeypatch.delenv("DEFT_RELEASE_VERSION", raising=False)
        payload = tmp_path / "framework"
        _init_git_repo(payload, tag="v3.2.1")
        shutil.copy2(RUN_PATH, payload / "run")
        run_mod = _load_run_module_from(payload / "run")
        assert run_mod.VERSION == "3.2.1"


# ---------------------------------------------------------------------------
# #1454: never PERSIST the 0.0.0-dev sentinel into consumer markers/manifests
# ---------------------------------------------------------------------------


class TestNoPersistDevSentinel:
    """`_write_version_marker` / `_write_install_manifest` must refuse to
    write the ``0.0.0-dev`` sentinel so a dev-checkout (or a vendored
    install whose git context could not be trusted) never clobbers a real
    recorded version. The in-process VERSION may still be the sentinel;
    only the WRITE is suppressed (#1454).
    """

    def test_marker_not_written_when_version_is_dev_sentinel(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        run_mod = _load_run_module()
        monkeypatch.setattr(run_mod, "VERSION", "0.0.0-dev")
        vbrief_root = tmp_path / "vbrief"
        run_mod._write_version_marker(vbrief_root)
        assert not (vbrief_root / ".deft-version").exists()

    def test_marker_preserves_prior_value_when_dev_sentinel(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        run_mod = _load_run_module()
        vbrief_root = tmp_path / "vbrief"
        vbrief_root.mkdir()
        marker = vbrief_root / ".deft-version"
        marker.write_text("0.39.6\n", encoding="utf-8")
        monkeypatch.setattr(run_mod, "VERSION", "0.0.0-dev")
        run_mod._write_version_marker(vbrief_root)
        assert marker.read_text(encoding="utf-8").strip() == "0.39.6"

    def test_marker_written_for_real_version(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        run_mod = _load_run_module()
        monkeypatch.setattr(run_mod, "VERSION", "1.2.3")
        vbrief_root = tmp_path / "vbrief"
        run_mod._write_version_marker(vbrief_root)
        assert (
            (vbrief_root / ".deft-version").read_text(encoding="utf-8").strip()
            == "1.2.3"
        )

    def test_install_manifest_not_written_for_explicit_dev_tag(
        self, tmp_path: Path
    ) -> None:
        run_mod = _load_run_module()
        install = tmp_path / ".deft" / "core"
        install.mkdir(parents=True)
        result = run_mod._write_install_manifest(
            install,
            fetched_by="run-upgrade",
            project_root=tmp_path,
            tag="0.0.0-dev",
        )
        assert result is None
        assert not (install / "VERSION").exists()

    def test_install_manifest_skips_default_dev_version(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        run_mod = _load_run_module()
        monkeypatch.setattr(run_mod, "VERSION", "0.0.0-dev")
        install = tmp_path / ".deft" / "core"
        install.mkdir(parents=True)
        result = run_mod._write_install_manifest(
            install,
            fetched_by="run-upgrade",
            project_root=tmp_path,
        )
        assert result is None
        assert not (install / "VERSION").exists()

    def test_install_manifest_preserves_prior_when_dev_tag(
        self, tmp_path: Path
    ) -> None:
        run_mod = _load_run_module()
        install = tmp_path / ".deft" / "core"
        install.mkdir(parents=True)
        prior = install / "VERSION"
        prior.write_text("tag: 'v0.39.6'\n", encoding="utf-8")
        result = run_mod._write_install_manifest(
            install,
            fetched_by="run-upgrade",
            project_root=tmp_path,
            tag="v0.0.0-dev",
        )
        assert result is None
        assert prior.read_text(encoding="utf-8") == "tag: 'v0.39.6'\n"

    def test_install_manifest_written_for_real_tag(self, tmp_path: Path) -> None:
        run_mod = _load_run_module()
        install = tmp_path / ".deft" / "core"
        install.mkdir(parents=True)
        result = run_mod._write_install_manifest(
            install,
            fetched_by="run-upgrade",
            project_root=tmp_path,
            tag="v1.2.3",
            sha="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            fetched_at="2026-01-01T00:00:00Z",
        )
        assert result is not None
        assert (install / "VERSION").is_file()
