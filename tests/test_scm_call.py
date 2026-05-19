"""tests/test_scm_call.py -- unit tests for ``scripts.scm.call`` (#1145 / N5).

Covers the acceptance criteria from
``vbrief/active/2026-05-19-1145-source-agnostic-verb-boundary-scaffold-partial-445935-down-p.vbrief.json``:

- Happy path: ``call("github-issue", verb, args)`` forwards to
  ``[resolved_binary, verb, *args]`` and returns the
  :class:`subprocess.CompletedProcess` unchanged.
- ``ghx`` preference (#884): when both binaries are on PATH, the shim
  picks ``ghx`` over ``gh`` -- a regression that flips the order would
  silently break the cache-proxy behavior the swarm cohort depends on.
- Unknown source raises :class:`NotImplementedError` with the canonical
  message pointing at #445 / #935 Workstream 6 so a consumer on
  GitLab / Gitea / local sees the deferred abstraction immediately
  instead of an obscure ``gh: command not found`` deep in the call
  stack.

Companion file ``tests/test_scm_stub.py`` pins the older
``build_command`` / ``main`` / REST opt-in surface; this file pins the
new ``call`` surface so changes to either are localized.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

scm = importlib.import_module("scm")


# ---------------------------------------------------------------------------
# Happy path -- github-issue source forwards to the resolved binary verbatim
# ---------------------------------------------------------------------------


class TestCallHappyPath:
    """``scm.call("github-issue", verb, args)`` forwards to subprocess.run."""

    def test_call_forwards_argv_to_resolved_binary(self) -> None:
        # The shim must compose ``[binary, verb, *args]`` and hand it to
        # ``subprocess.run`` verbatim. We pass an explicit ``binary=`` so
        # the test does not depend on the host PATH.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with mock.patch.object(scm.subprocess, "run", side_effect=fake_run):
            result = scm.call(
                "github-issue",
                "issue",
                ["view", "1145", "--repo", "deftai/directive"],
                binary="gh",
            )

        assert isinstance(result, subprocess.CompletedProcess)
        assert result.returncode == 0
        assert captured["cmd"] == [
            "gh", "issue", "view", "1145", "--repo", "deftai/directive",
        ]
        # The capture/text defaults are documented contract; check both flow
        # through to subprocess.run.
        assert captured["kwargs"]["capture_output"] is True
        assert captured["kwargs"]["text"] is True
        # ``check`` defaults to False so callers can inspect non-zero exits
        # without an exception.
        assert captured["kwargs"]["check"] is False

    def test_call_forwards_check_kwarg(self) -> None:
        # Mutation call sites (e.g. ``triage_actions._run_gh``) pass
        # ``check=True`` so a non-zero exit raises CalledProcessError and the
        # caller can roll back. The shim must forward the flag verbatim.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with mock.patch.object(scm.subprocess, "run", side_effect=fake_run):
            scm.call(
                "github-issue",
                "issue",
                ["close", "1145", "--repo", "deftai/directive"],
                check=True,
                binary="gh",
            )

        assert captured["kwargs"]["check"] is True

    def test_call_forwards_timeout_and_cwd(self, tmp_path: Path) -> None:
        # ``issue_ingest._fetch_single_issue`` uses both timeout and cwd; pin
        # the forwarding so a future refactor cannot silently drop them.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with mock.patch.object(scm.subprocess, "run", side_effect=fake_run):
            scm.call(
                "github-issue",
                "api",
                ["repos/deftai/directive/issues/1145"],
                timeout=30,
                cwd=str(tmp_path),
                binary="gh",
            )

        assert captured["kwargs"]["timeout"] == 30
        assert captured["kwargs"]["cwd"] == str(tmp_path)

    def test_call_default_args_is_empty(self) -> None:
        # Passing ``args=None`` (the default) must produce
        # ``[binary, verb]`` -- the no-arg invocation shape is documented
        # behavior even though it's unusual in production.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with mock.patch.object(scm.subprocess, "run", side_effect=fake_run):
            scm.call("github-issue", "auth", binary="gh")

        assert captured["cmd"] == ["gh", "auth"]


# ---------------------------------------------------------------------------
# ghx preference (#884 ladder)
# ---------------------------------------------------------------------------


class TestCallGhxPreference:
    """When both binaries are on PATH, the shim picks ``ghx`` over ``gh``."""

    def test_ghx_preferred_when_on_path(self) -> None:
        # Mirror image of TestResolveBinary.test_ghx_preferred_when_on_path
        # in test_scm_stub.py, but exercised through ``call`` so the new
        # surface inherits the same #884 contract.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        # `which` mock: both ghx and gh present -- the preference ladder
        # must land on ghx.
        with (
            mock.patch.object(scm.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"),
            mock.patch.object(scm.subprocess, "run", side_effect=fake_run),
        ):
            scm.call("github-issue", "issue", ["list"])

        # First argv element is the resolved binary; assert ghx wins.
        assert captured["cmd"][0] == "ghx"

    def test_gh_fallback_when_ghx_absent(self) -> None:
        # Canonical machine state on hosts where the operator hasn't
        # installed the #884 ghx proxy yet -- the shim must transparently
        # fall back to gh without warning or failing.
        captured: dict[str, Any] = {}

        def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
            captured["cmd"] = cmd
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        def _which_gh_only(name: str) -> str | None:
            return f"/usr/local/bin/{name}" if name == "gh" else None

        with (
            mock.patch.object(scm.shutil, "which", side_effect=_which_gh_only),
            mock.patch.object(scm.subprocess, "run", side_effect=fake_run),
        ):
            scm.call("github-issue", "issue", ["list"])

        assert captured["cmd"][0] == "gh"

    def test_neither_binary_raises_scm_stub_error(self) -> None:
        # On a host with neither binary, the shim raises ScmStubError so the
        # operator gets actionable installation guidance rather than a
        # silent FileNotFoundError mid-pipeline.
        with (
            mock.patch.object(scm.shutil, "which", return_value=None),
            pytest.raises(scm.ScmStubError, match="neither 'ghx' nor 'gh'"),
        ):
            scm.call("github-issue", "issue", ["list"])


# ---------------------------------------------------------------------------
# NotImplementedError for non-github-issue sources
# ---------------------------------------------------------------------------


class TestCallUnknownSource:
    """Non-``github-issue`` sources raise NotImplementedError loudly."""

    @pytest.mark.parametrize(
        "source", ["gitlab", "gitea", "local", "bitbucket", "azure-devops"]
    )
    def test_unknown_source_raises_not_implemented(self, source: str) -> None:
        # Per the #1145 spec: the shim raises NotImplementedError with a
        # message pointing at #445 / #935 Workstream 6 so a consumer on
        # GitLab / Gitea / local backends sees the deferred abstraction
        # immediately instead of an obscure ``gh: command not found``
        # deep in the call stack.
        with pytest.raises(NotImplementedError) as exc_info:
            scm.call(source, "issue", ["view", "1"])

        message = str(exc_info.value)
        # The canonical message must carry both the source name (so the
        # operator knows which forge they're on) and the referral to the
        # deferred abstraction issues so they can find the tracker.
        assert f"source={source!r}" in message
        assert "#445" in message
        assert "#935" in message
        assert "Workstream 6" in message

    def test_empty_source_raises(self) -> None:
        # Empty-string source is invalid -- not a typo allowed to silently
        # match "github-issue". The same NotImplementedError applies.
        with pytest.raises(NotImplementedError):
            scm.call("", "issue", ["view"])

    def test_typo_in_github_issue_raises(self) -> None:
        # Defensive: a typo like ``"github_issue"`` (underscore instead
        # of dash) must NOT silently match ``github-issue``. The shim's
        # whitelist is exact-match.
        with pytest.raises(NotImplementedError, match="github_issue"):
            scm.call("github_issue", "issue", ["view"])
