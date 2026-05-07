"""test_release_rollback_725.py -- #725 helper-level tests.

Split from tests/cli/test_release_rollback.py to keep both files under
the 1000-line MUST limit (AGENTS.md). Covers the three new helpers
introduced by #725 plus the module-level no-force-push invariant.

Coverage:
- resolve_release_prep_sha: rev-parse happy path, grep fallback,
  both-probes-fail diagnostic, rev-parse-rc0-but-empty-stdout fallthrough
- git_revert_release_commit: success (argv excludes reset / --hard /
  HEAD~1), conflict (runs git revert --abort + manual-recovery hint),
  conflict + abort-failure (extra abort diagnostic in refusal)
- git_push_base: argv contains 'push origin <base>' with NO --force /
  --force-with-lease; failure surfaces stderr; defence-in-depth check
  on a non-master branch
- Module-level invariant: no `--force-with-lease` argument and no
  `git_force_push_base(` call survives in the active code (catches
  future regressions that re-introduce force semantics)

Refs #725, #716, #74.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    if "release" not in sys.modules:
        spec_r = importlib.util.spec_from_file_location(
            "release", scripts_dir / "release.py"
        )
        assert spec_r is not None and spec_r.loader is not None
        mod_r = importlib.util.module_from_spec(spec_r)
        sys.modules["release"] = mod_r
        spec_r.loader.exec_module(mod_r)
    spec = importlib.util.spec_from_file_location(
        "release_rollback",
        scripts_dir / "release_rollback.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["release_rollback"] = module
    spec.loader.exec_module(module)
    return module


release_rollback = _load_module()

_RELEASE_PREP_SHA = "6573335cafef00d000000000000000000000bbbb"


def _fake_run_git_factory(responses):
    """Build a fake `release._run_git` that returns canned responses
    keyed by argv-prefix tuples. First match wins; default is a clean
    rc=0 no-op so tests only need to register the responses they care
    about.
    """
    def fake(project_root, *args, check=False):
        for prefix, (rc, out, err) in responses:
            if tuple(args[:len(prefix)]) == prefix:
                return SimpleNamespace(returncode=rc, stdout=out, stderr=err)
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    return fake


# ---------------------------------------------------------------------------
# resolve_release_prep_sha (#725)
# ---------------------------------------------------------------------------


class TestResolveReleasePrepSha:
    def test_rev_parse_happy_path(self, monkeypatch):
        responses = [
            (("rev-parse", "v0.21.0^{commit}"), (0, _RELEASE_PREP_SHA + "\n", "")),
        ]
        monkeypatch.setattr(
            release_rollback.release, "_run_git",
            _fake_run_git_factory(responses),
        )
        sha, reason = release_rollback.resolve_release_prep_sha(
            Path("."), "0.21.0"
        )
        assert sha == _RELEASE_PREP_SHA
        assert reason == ""

    def test_grep_fallback_when_rev_parse_fails(self, monkeypatch):
        responses = [
            (
                ("rev-parse", "v0.21.0^{commit}"),
                (128, "", "fatal: ambiguous argument"),
            ),
            (
                ("log", "--grep", "^chore(release): v0.21.0"),
                (0, _RELEASE_PREP_SHA + "\n", ""),
            ),
        ]
        monkeypatch.setattr(
            release_rollback.release, "_run_git",
            _fake_run_git_factory(responses),
        )
        sha, reason = release_rollback.resolve_release_prep_sha(
            Path("."), "0.21.0"
        )
        assert sha == _RELEASE_PREP_SHA
        assert reason == ""

    def test_both_probes_fail_returns_diagnostic(self, monkeypatch):
        responses = [
            (
                ("rev-parse", "v0.21.0^{commit}"),
                (128, "", "fatal: ambiguous argument"),
            ),
            (
                ("log", "--grep", "^chore(release): v0.21.0"),
                (0, "", ""),  # rc=0 but empty stdout (no match)
            ),
        ]
        monkeypatch.setattr(
            release_rollback.release, "_run_git",
            _fake_run_git_factory(responses),
        )
        sha, reason = release_rollback.resolve_release_prep_sha(
            Path("."), "0.21.0"
        )
        assert sha == ""
        assert "could not resolve release-prep SHA" in reason
        assert "rev-parse" in reason
        assert "--grep" in reason

    def test_rev_parse_rc0_but_empty_stdout_falls_through_to_grep(
        self, monkeypatch
    ):
        """Some git versions return rc=0 with empty stdout for missing tags."""
        responses = [
            (("rev-parse", "v0.21.0^{commit}"), (0, "\n", "")),
            (
                ("log", "--grep", "^chore(release): v0.21.0"),
                (0, _RELEASE_PREP_SHA + "\n", ""),
            ),
        ]
        monkeypatch.setattr(
            release_rollback.release, "_run_git",
            _fake_run_git_factory(responses),
        )
        sha, _ = release_rollback.resolve_release_prep_sha(
            Path("."), "0.21.0"
        )
        assert sha == _RELEASE_PREP_SHA


# ---------------------------------------------------------------------------
# git_revert_release_commit (#725)
# ---------------------------------------------------------------------------


class TestGitRevertReleaseCommit:
    def test_revert_success_targets_resolved_sha(self, monkeypatch):
        captured_argv = []

        def fake_run_git(project_root, *args, check=False):
            captured_argv.append(args)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(
            release_rollback.release, "_run_git", fake_run_git
        )
        ok, reason = release_rollback.git_revert_release_commit(
            Path("."), _RELEASE_PREP_SHA
        )
        assert ok is True
        assert _RELEASE_PREP_SHA[:12] in reason
        assert "forward revert" in reason
        # argv must include the resolved SHA + --no-edit -- and NOT 'reset',
        # NOT '--hard', NOT 'HEAD~1' (the pre-#725 reset semantics).
        assert captured_argv == [("revert", _RELEASE_PREP_SHA, "--no-edit")]
        flat = " ".join(captured_argv[0])
        assert "reset" not in flat
        assert "--hard" not in flat
        assert "HEAD~1" not in flat

    def test_revert_conflict_aborts_and_returns_manual_recovery_hint(
        self, monkeypatch
    ):
        captured_argv = []

        def fake_run_git(project_root, *args, check=False):
            captured_argv.append(args)
            if args == ("revert", _RELEASE_PREP_SHA, "--no-edit"):
                return SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr="CONFLICT (content): Merge conflict in CHANGELOG.md",
                )
            if args == ("revert", "--abort"):
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(
            release_rollback.release, "_run_git", fake_run_git
        )
        ok, reason = release_rollback.git_revert_release_commit(
            Path("."), _RELEASE_PREP_SHA
        )
        assert ok is False
        # Conflict path runs `git revert --abort` to clean the working tree.
        assert ("revert", "--abort") in captured_argv
        # Refusal carries the manual-recovery hint pointing at the docstring.
        assert "Manual recovery" in reason
        assert "git revert --continue" in reason
        assert "git push origin" in reason
        assert "scripts/release_rollback.py" in reason

    def test_revert_conflict_with_failed_abort_includes_abort_diagnostic(
        self, monkeypatch
    ):
        def fake_run_git(project_root, *args, check=False):
            if args == ("revert", _RELEASE_PREP_SHA, "--no-edit"):
                return SimpleNamespace(
                    returncode=1, stdout="", stderr="CONFLICT"
                )
            if args == ("revert", "--abort"):
                return SimpleNamespace(
                    returncode=128, stdout="",
                    stderr="fatal: no revert in progress",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(
            release_rollback.release, "_run_git", fake_run_git
        )
        ok, reason = release_rollback.git_revert_release_commit(
            Path("."), _RELEASE_PREP_SHA
        )
        assert ok is False
        assert "git revert --abort" in reason
        assert "fatal: no revert in progress" in reason


# ---------------------------------------------------------------------------
# git_push_base (#725) -- forward push, NO --force / --force-with-lease
# ---------------------------------------------------------------------------


class TestGitPushBase:
    def test_push_succeeds_with_no_force_flags(self, monkeypatch):
        captured_argv = []

        def fake_run_git(project_root, *args, check=False):
            captured_argv.append(args)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(
            release_rollback.release, "_run_git", fake_run_git
        )
        ok, reason = release_rollback.git_push_base(Path("."), "master")
        assert ok is True
        assert "no force" in reason
        # #725 acceptance: argv MUST be `push origin master` -- nothing else.
        assert captured_argv == [("push", "origin", "master")]
        flat = " ".join(captured_argv[0])
        assert "--force" not in flat
        assert "--force-with-lease" not in flat

    def test_push_failure_returns_false(self, monkeypatch):
        def fake_run_git(project_root, *args, check=False):
            return SimpleNamespace(
                returncode=1, stdout="", stderr="network error"
            )

        monkeypatch.setattr(
            release_rollback.release, "_run_git", fake_run_git
        )
        ok, reason = release_rollback.git_push_base(Path("."), "master")
        assert ok is False
        assert "network error" in reason

    def test_push_does_not_default_to_force_with_lease(self, monkeypatch):
        """Defence in depth: if any future change accidentally re-introduces
        force semantics, this test fails.
        """
        captured_argv = []

        def fake_run_git(project_root, *args, check=False):
            captured_argv.append(args)
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(
            release_rollback.release, "_run_git", fake_run_git
        )
        release_rollback.git_push_base(Path("."), "some-other-branch")
        for argv in captured_argv:
            assert "--force" not in argv
            assert "--force-with-lease" not in argv


# ---------------------------------------------------------------------------
# Module-level invariant: no force-push references remain in the unwind code
# (#725 -- catches future regressions that re-introduce --force-with-lease)
# ---------------------------------------------------------------------------


class TestNoForcePushReferences:
    def test_module_source_does_not_reference_force_push_in_active_code(self):
        source = (REPO_ROOT / "scripts" / "release_rollback.py").read_text(
            encoding="utf-8"
        )
        # The docstring explicitly DESCRIBES the pre-#725 force-push
        # behaviour for documentation purposes -- so we can't assert
        # `--force-with-lease` is entirely absent. Instead, assert that
        # active code (anything after the closing of the module docstring)
        # does not invoke `--force-with-lease` as a subprocess argument.
        # Heuristic: strip the module docstring (between the first two
        # `"""`) and check the rest.
        first = source.find('"""')
        second = source.find('"""', first + 3)
        assert first != -1 and second != -1, "module docstring not found"
        active = source[second + 3:]
        assert '"--force-with-lease"' not in active
        # Also: no `git_force_push_base` callable should be invoked from
        # active code (the function was deleted, so any leftover reference
        # would fail at runtime; this is a belt-and-suspenders check).
        assert "git_force_push_base(" not in active
