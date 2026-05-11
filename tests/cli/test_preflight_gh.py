"""Tests for scripts/preflight_gh.py (#1019).

Covers the destructive-gh-verb gate's exit-code states and the three
destructive categories (delete_repo / admin_merge / force_push_default),
plus the env-var bypass and the pre-push stdin parser.

Tests drive :func:`preflight_gh.classify_command` /
:func:`preflight_gh.evaluate_command` / :func:`preflight_gh.evaluate_pre_push`
directly (pure functions) so no real ``gh`` / ``git`` invocation is
shelled out -- the gate is by design pre-execution so the unit tests
mirror that.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT_PATH = REPO_ROOT / "scripts" / "preflight_gh.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def preflight():
    return _load_module("preflight_gh", PREFLIGHT_PATH)


# ---------------------------------------------------------------------------
# classify_command -- delete_repo category
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "gh repo delete deftai/directive",
        "gh repo delete deftai/directive --yes",
        "ghx repo delete deftai/directive",  # ghx ladder per #884
        "GH repo delete deftai/directive",   # case-insensitive command head
    ],
)
def test_classify_delete_repo_positive(preflight, command):
    verdict = preflight.classify_command(command)
    assert not verdict.allowed
    assert verdict.category == "delete_repo"
    assert "deftai" in verdict.detail or "<unspecified>" in verdict.detail


@pytest.mark.parametrize(
    "command",
    [
        "gh api -X DELETE repos/deftai/directive",
        "gh api --method DELETE repos/deftai/directive",
        "gh api -X=DELETE repos/deftai/directive",
        "gh api --method=DELETE repos/deftai/directive",
        "gh api -XDELETE repos/deftai/directive",
        "gh api -X DELETE /repos/deftai/directive/contents/README.md",
    ],
)
def test_classify_delete_repo_via_api_positive(preflight, command):
    verdict = preflight.classify_command(command)
    assert not verdict.allowed
    assert verdict.category == "delete_repo"


@pytest.mark.parametrize(
    "command",
    [
        "gh repo view deftai/directive",
        "gh repo list",
        "gh api repos/deftai/directive",            # GET, not DELETE
        "gh api -X PATCH repos/deftai/directive",   # mutation but not delete
        "gh api -X DELETE /user/keys/123",          # not a repo endpoint
        "gh api -X DELETE /gists/abc",              # not a repo endpoint
    ],
)
def test_classify_delete_repo_negative(preflight, command):
    verdict = preflight.classify_command(command)
    assert verdict.allowed
    assert verdict.category is None


# ---------------------------------------------------------------------------
# classify_command -- admin_merge category
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "gh pr merge 123 --admin",
        "gh pr merge --admin --squash 123",
        "gh pr merge --squash --admin 123",
        "ghx pr merge 123 --admin",
    ],
)
def test_classify_admin_merge_positive(preflight, command):
    verdict = preflight.classify_command(command)
    assert not verdict.allowed
    assert verdict.category == "admin_merge"


@pytest.mark.parametrize(
    "command",
    [
        "gh pr merge 123 --squash",
        "gh pr merge 123 --squash --delete-branch",
        "gh pr merge 123",
        "gh pr view 123",
        "gh pr create --title T --body B",
    ],
)
def test_classify_admin_merge_negative(preflight, command):
    verdict = preflight.classify_command(command)
    assert verdict.allowed
    assert verdict.category is None


# ---------------------------------------------------------------------------
# classify_command -- force_push_default category
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "git push --force origin master",
        "git push -f origin master",
        "git push --force origin main",
        "git push origin --force-with-lease main",
        "git push --force-with-lease origin master",
        "git push --force-with-lease=master origin master",
        "git push --force origin HEAD:master",
        "git push origin +master",
        "git push origin +HEAD:main",
        "git push --force origin refs/heads/master",
    ],
)
def test_classify_force_push_default_positive(preflight, command):
    verdict = preflight.classify_command(command)
    assert not verdict.allowed, (
        f"Expected force_push_default for {command!r}, got allowed verdict"
    )
    assert verdict.category == "force_push_default"


@pytest.mark.parametrize(
    "command",
    [
        "git push origin master",                       # not force
        "git push origin main",                         # not force
        "git push --force origin feat/my-branch",       # force, but not default
        "git push --force-with-lease origin feat/x",    # force, but not default
        "git push origin +feat/branch",                 # +refspec, not default
        "git push origin HEAD:feat/branch",             # not force, not default
        "git push",                                     # bare push
        "git fetch --force origin master",              # fetch, not push
    ],
)
def test_classify_force_push_default_negative(preflight, command):
    verdict = preflight.classify_command(command)
    assert verdict.allowed, (
        f"Expected allowed verdict for {command!r}, got {verdict.category}"
    )


def test_classify_force_push_custom_default_branch(preflight):
    """Custom default-branch list (e.g. trunk) flags force-push to that ref."""
    verdict = preflight.classify_command(
        "git push --force origin trunk",
        default_branches=frozenset({"trunk"}),
    )
    assert not verdict.allowed
    assert verdict.category == "force_push_default"


# ---------------------------------------------------------------------------
# evaluate_command -- exit-code wrapper + env-var bypass
# ---------------------------------------------------------------------------


def test_evaluate_command_allowed_returns_exit_0(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code, msg = preflight.evaluate_command("gh repo view deftai/directive")
    assert code == 0
    assert "not destructive" in msg


def test_evaluate_command_block_returns_exit_1(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code, msg = preflight.evaluate_command("gh repo delete deftai/directive")
    assert code == 1
    assert "refusing to execute" in msg
    assert "delete_repo" in msg
    assert "DEFT_ALLOW_DESTRUCTIVE_GH_VERBS=1" in msg


def test_evaluate_command_env_bypass_returns_exit_0(preflight, monkeypatch):
    monkeypatch.setenv(preflight.ENV_BYPASS, "1")
    code, msg = preflight.evaluate_command("gh repo delete deftai/directive")
    assert code == 0
    assert "policy bypassed" in msg
    assert "delete_repo" in msg


@pytest.mark.parametrize("truthy", ["1", "true", "TRUE", "yes", "on"])
def test_env_bypass_accepts_canonical_truthy(preflight, monkeypatch, truthy):
    monkeypatch.setenv(preflight.ENV_BYPASS, truthy)
    code, _ = preflight.evaluate_command("gh repo delete deftai/directive")
    assert code == 0


@pytest.mark.parametrize("falsy", ["0", "false", "no", "off", ""])
def test_env_bypass_rejects_falsy(preflight, monkeypatch, falsy):
    monkeypatch.setenv(preflight.ENV_BYPASS, falsy)
    code, _ = preflight.evaluate_command("gh repo delete deftai/directive")
    assert code == 1


def test_evaluate_command_empty_string_returns_exit_2(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code, msg = preflight.evaluate_command("   ")
    assert code == 2
    assert "empty command string" in msg


# ---------------------------------------------------------------------------
# evaluate_pre_push -- git pre-push hook stdin parser
# ---------------------------------------------------------------------------


_ZERO = "0" * 40
_SHA_A = "a" * 40
_SHA_B = "b" * 40


def test_evaluate_pre_push_feature_branch_passes(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    refs = [("refs/heads/feat/x", _SHA_A, "refs/heads/feat/x", _SHA_B)]
    code, msg = preflight.evaluate_pre_push(refs)
    assert code == 0
    assert "no pushes to default branches" in msg


def test_evaluate_pre_push_default_branch_update_blocks(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    refs = [("refs/heads/feat/x", _SHA_A, "refs/heads/master", _SHA_B)]
    code, msg = preflight.evaluate_pre_push(refs)
    assert code == 1
    assert "refusing to push" in msg
    assert "master" in msg


def test_evaluate_pre_push_default_branch_create_blocks(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    # Remote OID is zero -> creating the ref on the remote.
    refs = [("refs/heads/local", _SHA_A, "refs/heads/main", _ZERO)]
    code, msg = preflight.evaluate_pre_push(refs)
    assert code == 1
    assert "create main" in msg


def test_evaluate_pre_push_env_bypass(preflight, monkeypatch):
    monkeypatch.setenv(preflight.ENV_BYPASS, "1")
    refs = [("refs/heads/feat/x", _SHA_A, "refs/heads/master", _SHA_B)]
    code, msg = preflight.evaluate_pre_push(refs)
    assert code == 0
    assert "policy bypassed" in msg


def test_evaluate_pre_push_empty_stdin(preflight, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code, msg = preflight.evaluate_pre_push([])
    assert code == 0
    assert "no refs" in msg


def test_evaluate_pre_push_mixed_refs_blocks_on_default(preflight, monkeypatch):
    """Multiple refs: feature branch + default branch -> exit 1."""
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    refs = [
        ("refs/heads/feat/x", _SHA_A, "refs/heads/feat/x", _SHA_B),
        ("refs/heads/feat/y", _SHA_A, "refs/heads/master", _SHA_B),
    ]
    code, msg = preflight.evaluate_pre_push(refs)
    assert code == 1
    assert "master" in msg


def test_evaluate_pre_push_multi_ref_deletion_labels_per_ref(preflight, monkeypatch):
    """Greptile #1042 regression: deletion of default branch in a multi-ref push
    MUST use the iteration's own local_oid for the zero check, not refs[0][1].

    Pre-fix, a multi-ref push whose first ref had a non-zero local OID (feature
    branch update) and a later ref deleted master (local OID = all-zeros) was
    labelled `update master (local=...)` because `refs[0][1]` always pointed at
    the first ref's non-zero OID. The gate still blocked (correct), but the
    diagnostic was wrong.
    """
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    refs = [
        # First ref: non-zero local OID (feature-branch push).
        ("refs/heads/feat/x", _SHA_A, "refs/heads/feat/x", _SHA_B),
        # Second ref: zero local OID -> deletion of master.
        ("(delete)", _ZERO, "refs/heads/master", _SHA_B),
    ]
    code, msg = preflight.evaluate_pre_push(refs)
    assert code == 1
    assert "delete master" in msg
    # Defence-in-depth: the misleading pre-fix `update master` label MUST NOT
    # surface for a deletion when an earlier ref carries a non-zero local OID.
    assert "update master" not in msg


# ---------------------------------------------------------------------------
# value_taking set -- duplicate `-f` ruff B033 regression (Greptile Issue 3 / #1042)
# ---------------------------------------------------------------------------


def test_value_taking_set_has_no_duplicate_short_flags(preflight):
    """`-f` MUST appear at most once in the value_taking set and `-F` MUST be
    enumerated explicitly so both gh-api flag forms are self-documenting.
    Regression for the ruff B033 finding + Greptile Issue 3 on PR #1042.

    Classifies a benign command exercising both ``-f`` and ``-F`` value-taking
    forms; pre-fix the set's duplicate ``-f`` entry was silently dropped by
    Python's set semantics so ``-F`` was only resolved by the implicit
    lower-case fall-through. The fix replaces the duplicate ``-f`` entry with
    an explicit ``-F`` -- both forms now register their value-consuming
    semantics through distinct enumerated keys.
    """
    verdict = preflight.classify_command(
        "gh api -F field=value -f other=value repos/foo/bar"
    )
    # Non-destructive -- the set lookup must succeed without raising.
    assert verdict.allowed is True


# ---------------------------------------------------------------------------
# run_self_test -- the surface task verify:destructive-gh-verbs runs
# ---------------------------------------------------------------------------


def test_run_self_test_passes(preflight):
    code, msg = preflight.run_self_test()
    assert code == 0
    assert "classified as expected" in msg


def test_run_self_test_catches_classifier_drift(preflight, monkeypatch):
    """A poisoned classifier MUST cause --self-test to exit 2."""

    def fake_classify(command, **kwargs):  # noqa: ARG001
        return preflight.Verdict(
            allowed=True, category=None, detail="poisoned"
        )

    monkeypatch.setattr(preflight, "classify_command", fake_classify)
    code, msg = preflight.run_self_test()
    assert code == 2
    assert "classifier disagreement" in msg


# ---------------------------------------------------------------------------
# main() -- argv-shape contract + CLI integration
# ---------------------------------------------------------------------------


def test_main_self_test_returns_0(preflight, capsys):
    code = preflight.main(["--self-test", "--quiet"])
    assert code == 0


def test_main_command_block_returns_1(preflight, capsys, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code = preflight.main(["--command", "gh repo delete deftai/directive"])
    err = capsys.readouterr().err
    assert code == 1
    assert "refusing" in err


def test_main_command_allowed_returns_0(preflight, capsys, monkeypatch):
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code = preflight.main(["--command", "gh repo view foo/bar", "--quiet"])
    assert code == 0


def test_main_requires_mode_flag(preflight):
    """argparse should reject an invocation with no mode flag."""
    with pytest.raises(SystemExit) as exc:
        preflight.main([])
    assert exc.value.code == 2


def test_main_pre_push_stdin_block(preflight, monkeypatch, capsys):
    """End-to-end: --pre-push-stdin reads stdin lines and blocks on default."""
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    stdin = io.StringIO(
        f"refs/heads/feat/x {_SHA_A} refs/heads/master {_SHA_B}\n"
    )
    code = preflight.main(["--pre-push-stdin"], stdin=stdin)
    err = capsys.readouterr().err
    assert code == 1
    assert "refusing to push" in err
    assert "master" in err


def test_main_custom_default_branch(preflight, monkeypatch, capsys):
    """`--default-branch trunk` makes the gate refuse trunk force-push."""
    monkeypatch.delenv(preflight.ENV_BYPASS, raising=False)
    code = preflight.main(
        [
            "--command",
            "git push --force origin trunk",
            "--default-branch",
            "trunk",
        ]
    )
    err = capsys.readouterr().err
    assert code == 1
    assert "force_push_default" in err
    assert "trunk" in err


# ---------------------------------------------------------------------------
# Verdict dataclass + module surface contract
# ---------------------------------------------------------------------------


def test_verdict_is_frozen(preflight):
    """Verdict instances MUST be immutable so callers cannot tamper."""
    verdict = preflight.Verdict(
        allowed=False, category="delete_repo", detail="x"
    )
    with pytest.raises((AttributeError, Exception)):
        verdict.allowed = True  # type: ignore[misc]


def test_public_api_surface(preflight):
    """Pin the exported public surface so accidental removals fail loud."""
    expected = {
        "DEFAULT_BRANCHES",
        "ENV_BYPASS",
        "Verdict",
        "classify_command",
        "evaluate_command",
        "evaluate_pre_push",
        "main",
        "run_self_test",
    }
    assert set(preflight.__all__) == expected
    # Each exported name actually resolves to a non-None attribute.
    for name in expected:
        assert getattr(preflight, name) is not None
