"""test_release_branch_gate.py -- regression coverage for #867.

The #747 detection-bound branch gate (`.githooks/pre-commit` ->
`scripts/preflight_branch.py`, also `.githooks/pre-push`) refuses
unauthorised commits / pushes on the default branch. The release
pipeline (`scripts/release.py`) is the canonical authorised
commit-on-master path: by design it commits release artifacts
(CHANGELOG.md, ROADMAP.md, pyproject.toml, uv.lock) on master and then
tags + pushes that commit.

The fix in #867 passes the documented `DEFT_ALLOW_DEFAULT_BRANCH_COMMIT`
env-var bypass (`scripts/policy.py::ENV_BYPASS`) in the subprocess `env=`
kwarg of the Step 9 / 10 / 11 git mutations, so the hooks recognise the
pipeline as authorised. The parent-process `os.environ` MUST remain
untouched so the bypass cannot leak into a subsequent operator shell.

This test module pins the contract:

- ``commit_release_artifacts`` passes ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1``
  in the ``env=`` kwarg to ``subprocess.run`` for the ``git commit``
  invocation.
- ``create_tag`` passes the same bypass for the ``git tag -a`` invocation
  (defence-in-depth in case a future tag-side hook is wired into the
  #747 enforcement surface).
- ``push_release`` passes the same bypass for the ``git push --atomic``
  invocation so the pre-push hook recognises the pipeline.
- ``os.environ`` is byte-unchanged after each helper returns (no
  parent-process pollution).
- ``_release_subprocess_env()`` returns a dict that extends ``os.environ``
  with ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT="1"`` and does NOT mutate
  ``os.environ`` itself.

Refs #867, #747 (the gate this carve-out lands against), #74 (release
pipeline parent).
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    """Load scripts/release.py in-process (mirrors test_release.py)."""
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "release",
        scripts_dir / "release.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register in sys.modules BEFORE exec so @dataclass introspection in
    # release.py (which calls sys.modules.get(cls.__module__).__dict__) can
    # resolve the module rather than tripping AttributeError on None.
    sys.modules["release"] = module
    spec.loader.exec_module(module)
    return module


release = _load_module()


BYPASS_ENV = "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT"


# ---------------------------------------------------------------------------
# _release_subprocess_env helper contract
# ---------------------------------------------------------------------------


class TestReleaseSubprocessEnv:
    """Pin the helper that builds the bypass env dict (#867)."""

    def test_returns_dict_with_bypass_set_to_1(self, monkeypatch):
        # Strip the bypass from the parent process so we test the
        # set-from-scratch path explicitly.
        monkeypatch.delenv(BYPASS_ENV, raising=False)
        env = release._release_subprocess_env()
        assert isinstance(env, dict)
        assert env.get(BYPASS_ENV) == "1"

    def test_extends_os_environ(self, monkeypatch):
        # Sentinel env-var that should appear in the returned dict because
        # the helper extends ``os.environ.copy()`` rather than building a
        # blank dict.
        monkeypatch.setenv("DEFT_TEST_SENTINEL_867", "carry-through")
        env = release._release_subprocess_env()
        assert env.get("DEFT_TEST_SENTINEL_867") == "carry-through"
        assert env.get(BYPASS_ENV) == "1"

    def test_does_not_mutate_os_environ(self, monkeypatch):
        # The bypass MUST live only in the returned dict; mutating
        # ``os.environ`` would leak the bypass into subsequent operator
        # commands run from the same shell.
        monkeypatch.delenv(BYPASS_ENV, raising=False)
        baseline = os.environ.copy()
        _ = release._release_subprocess_env()
        assert BYPASS_ENV not in os.environ
        assert os.environ == baseline

    def test_returns_independent_dict(self, monkeypatch):
        # Mutating the returned dict MUST not back-propagate to
        # ``os.environ`` (defence-in-depth against accidental aliasing).
        monkeypatch.delenv(BYPASS_ENV, raising=False)
        env = release._release_subprocess_env()
        env["DEFT_TEST_LOCAL_867"] = "scratch"
        assert "DEFT_TEST_LOCAL_867" not in os.environ

    def test_overrides_inherited_falsy_value(self, monkeypatch):
        # If the parent shell happens to already have the bypass set to
        # "0" or some other value, the helper MUST still emit "1" so the
        # subprocess env unambiguously activates the gate's truthy check.
        monkeypatch.setenv(BYPASS_ENV, "0")
        env = release._release_subprocess_env()
        assert env[BYPASS_ENV] == "1"


# ---------------------------------------------------------------------------
# Subprocess-env capture fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def capture_subprocess(monkeypatch):
    """Capture every ``subprocess.run`` invocation against the release module.

    Returns the list of recorded ``(args_tuple, kwargs_dict)`` pairs.
    Each captured ``run`` returns a SimpleNamespace mimicking the real
    shape (``returncode=0``, empty stdout/stderr) so the helper code path
    proceeds end-to-end.
    """
    captured: list[tuple[tuple, dict]] = []

    def fake_run(*args, **kwargs):
        captured.append((args, kwargs))
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(release.subprocess, "run", fake_run)
    return captured


def _git_commands(captured: list[tuple[tuple, dict]]) -> list[tuple[list[str], dict]]:
    """Filter captured ``subprocess.run`` records to git invocations.

    Returns ``(argv_list, kwargs_dict)`` pairs where ``argv_list[0] == 'git'``.
    """
    out = []
    for args, kwargs in captured:
        if not args:
            continue
        argv = args[0]
        if isinstance(argv, list) and argv and argv[0] == "git":
            out.append((argv, kwargs))
    return out


def _find_git_subcommand(
    captured: list[tuple[tuple, dict]], subcommand: str
) -> tuple[list[str], dict]:
    """Return the (argv, kwargs) for the FIRST git invocation matching the subcommand.

    Looks past the leading ``git -C <root>`` so e.g. ``commit`` matches
    ``["git", "-C", "/repo", "commit", "-m", "..."]``.
    """
    for argv, kwargs in _git_commands(captured):
        # argv shape: ["git", "-C", str(project_root), <subcmd>, ...]
        if len(argv) >= 4 and argv[3] == subcommand:
            return argv, kwargs
    pytest.fail(
        f"no captured git invocation with subcommand {subcommand!r}; "
        f"captured: {[argv for argv, _ in _git_commands(captured)]}"
    )


# ---------------------------------------------------------------------------
# commit_release_artifacts -- #867 carve-out
# ---------------------------------------------------------------------------


class TestCommitReleaseArtifactsBranchGate:
    """``git commit`` MUST receive the #867 bypass in its subprocess env."""

    def test_commit_passes_bypass_in_env(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        # Pre-create a CHANGELOG.md so the helper has at least one
        # release artifact to stage; the fake_run returns ``returncode=0``
        # for everything (including the `diff --cached --quiet` check)
        # so we override that single call to signal "something staged".
        (tmp_path / "CHANGELOG.md").write_text("# changelog\n", encoding="utf-8")

        # Replace fake_run with one that distinguishes diff --cached --quiet
        # (must return rc=1 so the helper proceeds to commit) from
        # everything else (rc=0).
        captured = capture_subprocess

        def smart_run(*args, **kwargs):
            captured.append((args, kwargs))
            argv = args[0] if args else []
            if (
                isinstance(argv, list)
                and len(argv) >= 6
                and argv[3:6] == ["diff", "--cached", "--quiet"]
            ):
                return SimpleNamespace(stdout="", stderr="", returncode=1)
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        # Reset captured list because capture_subprocess installed an
        # earlier fake_run; replace the patch target with smart_run.
        captured.clear()
        monkeypatch.setattr(release.subprocess, "run", smart_run)

        ok, reason = release.commit_release_artifacts(tmp_path, "0.24.0")
        assert ok is True, reason

        commit_argv, commit_kwargs = _find_git_subcommand(captured, "commit")
        assert "env" in commit_kwargs, (
            "git commit subprocess.run MUST receive an env= kwarg (#867); "
            f"observed kwargs: {commit_kwargs}"
        )
        env = commit_kwargs["env"]
        assert env is not None
        assert env.get(BYPASS_ENV) == "1", (
            f"git commit env MUST carry {BYPASS_ENV}=1 (#867); "
            f"observed: {env.get(BYPASS_ENV)!r}"
        )

    def test_commit_does_not_pollute_os_environ(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        (tmp_path / "CHANGELOG.md").write_text("# changelog\n", encoding="utf-8")
        monkeypatch.delenv(BYPASS_ENV, raising=False)
        baseline = os.environ.copy()

        captured = capture_subprocess

        def smart_run(*args, **kwargs):
            captured.append((args, kwargs))
            argv = args[0] if args else []
            if (
                isinstance(argv, list)
                and len(argv) >= 6
                and argv[3:6] == ["diff", "--cached", "--quiet"]
            ):
                return SimpleNamespace(stdout="", stderr="", returncode=1)
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        captured.clear()
        monkeypatch.setattr(release.subprocess, "run", smart_run)
        release.commit_release_artifacts(tmp_path, "0.24.0")

        # The bypass MUST NOT have been leaked into the parent environment.
        assert BYPASS_ENV not in os.environ
        assert os.environ == baseline


# ---------------------------------------------------------------------------
# create_tag -- #867 carve-out (defence-in-depth)
# ---------------------------------------------------------------------------


class TestCreateTagBranchGate:
    """``git tag -a`` MUST receive the #867 bypass (defence-in-depth)."""

    def test_tag_passes_bypass_in_env(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        ok, reason = release.create_tag(tmp_path, "0.24.0")
        assert ok is True, reason

        tag_argv, tag_kwargs = _find_git_subcommand(capture_subprocess, "tag")
        assert "env" in tag_kwargs
        env = tag_kwargs["env"]
        assert env is not None
        assert env.get(BYPASS_ENV) == "1", (
            f"git tag env MUST carry {BYPASS_ENV}=1 (#867); "
            f"observed: {env.get(BYPASS_ENV)!r}"
        )
        # Sanity-check the argv shape so a future refactor that drops
        # ``-a`` (annotated) does not silently regress this assertion.
        assert "-a" in tag_argv
        assert "v0.24.0" in tag_argv

    def test_tag_does_not_pollute_os_environ(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        monkeypatch.delenv(BYPASS_ENV, raising=False)
        baseline = os.environ.copy()
        release.create_tag(tmp_path, "0.24.0")
        assert BYPASS_ENV not in os.environ
        assert os.environ == baseline


# ---------------------------------------------------------------------------
# push_release -- #867 carve-out
# ---------------------------------------------------------------------------


class TestPushReleaseBranchGate:
    """``git push --atomic`` MUST receive the #867 bypass."""

    def test_push_passes_bypass_in_env(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        ok, reason = release.push_release(tmp_path, "0.24.0", "master")
        assert ok is True, reason

        push_argv, push_kwargs = _find_git_subcommand(capture_subprocess, "push")
        assert "env" in push_kwargs
        env = push_kwargs["env"]
        assert env is not None
        assert env.get(BYPASS_ENV) == "1", (
            f"git push env MUST carry {BYPASS_ENV}=1 (#867); "
            f"observed: {env.get(BYPASS_ENV)!r}"
        )
        # Sanity-check the argv carries --atomic + the branch + the tag,
        # mirroring the contract documented in push_release's docstring.
        assert "--atomic" in push_argv
        assert "master" in push_argv
        assert "v0.24.0" in push_argv

    def test_push_does_not_pollute_os_environ(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        monkeypatch.delenv(BYPASS_ENV, raising=False)
        baseline = os.environ.copy()
        release.push_release(tmp_path, "0.24.0", "master")
        assert BYPASS_ENV not in os.environ
        assert os.environ == baseline


# ---------------------------------------------------------------------------
# Aggregate / pipeline-shape regression
# ---------------------------------------------------------------------------


class TestAllThreeMutationsCarryBypass:
    """End-to-end shape: every mutation surface in the pipeline gets the bypass.

    This is the canonical regression for #867: if a future refactor adds
    a fourth git mutation (or moves one into a new helper) and forgets
    the env=, this test fails because the new mutation appears in the
    captured invocations without the bypass set.
    """

    def test_all_recorded_git_mutations_carry_bypass(
        self, monkeypatch, tmp_path, capture_subprocess
    ):
        # Pre-create a CHANGELOG.md so commit_release_artifacts has
        # something to stage.
        (tmp_path / "CHANGELOG.md").write_text("# changelog\n", encoding="utf-8")
        captured = capture_subprocess

        def smart_run(*args, **kwargs):
            captured.append((args, kwargs))
            argv = args[0] if args else []
            if (
                isinstance(argv, list)
                and len(argv) >= 6
                and argv[3:6] == ["diff", "--cached", "--quiet"]
            ):
                # signal "something is staged" so commit step proceeds
                return SimpleNamespace(stdout="", stderr="", returncode=1)
            return SimpleNamespace(stdout="", stderr="", returncode=0)

        captured.clear()
        monkeypatch.setattr(release.subprocess, "run", smart_run)
        monkeypatch.delenv(BYPASS_ENV, raising=False)

        # Drive each helper that owns one of the three mutation surfaces.
        release.commit_release_artifacts(tmp_path, "0.24.0")
        release.create_tag(tmp_path, "0.24.0")
        release.push_release(tmp_path, "0.24.0", "master")

        # Every capture for ``git commit`` / ``git tag`` / ``git push``
        # MUST carry the bypass; read-only invocations (``git add``,
        # ``git diff --cached``) MAY have ``env=None`` since the gate
        # does not block reads.
        mutation_subcommands = {"commit", "tag", "push"}
        seen: dict[str, bool] = dict.fromkeys(mutation_subcommands, False)
        for argv, kwargs in _git_commands(captured):
            if len(argv) < 4:
                continue
            sub = argv[3]
            if sub not in mutation_subcommands:
                continue
            env = kwargs.get("env")
            assert env is not None, (
                f"git {sub} MUST receive env= kwarg (#867); "
                f"argv={argv}, kwargs={kwargs}"
            )
            assert env.get(BYPASS_ENV) == "1", (
                f"git {sub} env MUST carry {BYPASS_ENV}=1 (#867); "
                f"observed env[{BYPASS_ENV}]={env.get(BYPASS_ENV)!r}"
            )
            seen[sub] = True

        for sub, was_seen in seen.items():
            assert was_seen, (
                f"expected to capture a git {sub} invocation; "
                f"captured commands were: {[argv for argv, _ in _git_commands(captured)]}"
            )

        # Final assertion: parent os.environ remains pristine.
        assert BYPASS_ENV not in os.environ
