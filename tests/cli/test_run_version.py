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
