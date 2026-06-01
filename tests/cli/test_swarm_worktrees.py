"""test_swarm_worktrees.py -- tests for scripts/swarm_worktrees.py (#1387).

Covers the FROZEN C3 resolver ``resolve_worktree_map`` and its CLI:

- validation accepts a pre-created git worktree (even with create_missing=False)
- idempotent creation: a missing worktree is created from the base branch and
  a re-run is a no-op
- same-path collision rejection names the colliding stories
- base-branch mismatch rejection
- normalized output carries exactly the three C3 keys
- the CLI's three-state exit (0 resolved / 1 validation / 2 config)

Each test drives a throwaway git repository under ``tmp_path`` so the
resolver exercises real ``git worktree`` plumbing rather than a mock.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "swarm_worktrees",
        scripts_dir / "swarm_worktrees.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["swarm_worktrees"] = module
    spec.loader.exec_module(module)
    return module


swm = _load_module()


# ---------------------------------------------------------------------------
# git fixtures / helpers
# ---------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    """A throwaway git repo on ``master`` with one commit."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "master", str(repo)], check=True)
    _git(repo, "config", "user.email", "t@x")
    _git(repo, "config", "user.name", "T")
    (repo / "f.txt").write_text("x\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


def _registered_keys(repo: Path) -> set[str]:
    """Return the resolved/normcased compare-keys of all registered worktrees."""
    out = _git(repo, "worktree", "list", "--porcelain").stdout
    return set(swm.parse_worktree_porcelain(out).keys())


def _key(path: Path) -> str:
    return swm._compare_key(path.resolve())


# ---------------------------------------------------------------------------
# resolve_worktree_map -- validation against real git state
# ---------------------------------------------------------------------------


def test_validates_pre_created_worktree(git_repo: Path, tmp_path: Path) -> None:
    """A pre-created worktree validates without creation (create_missing=False)."""
    wt = tmp_path / "wt-a"
    _git(git_repo, "worktree", "add", "--detach", str(wt), "master")

    result = swm.resolve_worktree_map(
        [{"story_id": "s1", "worktree_path": str(wt)}],
        "master",
        create_missing=False,
        repo_root=git_repo,
    )

    assert len(result) == 1
    assert result[0]["story_id"] == "s1"
    assert result[0]["base_branch"] == "master"
    assert Path(result[0]["worktree_path"]) == wt.resolve()


def test_record_base_branch_matching_is_accepted(git_repo: Path, tmp_path: Path) -> None:
    """A record that restates the cohort base branch is accepted, not rejected."""
    wt = tmp_path / "wt-a"
    _git(git_repo, "worktree", "add", "--detach", str(wt), "master")

    result = swm.resolve_worktree_map(
        [{"story_id": "s1", "worktree_path": str(wt), "base_branch": "master"}],
        "master",
        create_missing=False,
        repo_root=git_repo,
    )

    assert result[0]["base_branch"] == "master"


# ---------------------------------------------------------------------------
# resolve_worktree_map -- idempotent creation
# ---------------------------------------------------------------------------


def test_missing_worktree_is_created_from_base(git_repo: Path, tmp_path: Path) -> None:
    """A mapped-but-absent worktree is created from the base branch."""
    wt = tmp_path / "wt-new"
    assert _key(wt) not in _registered_keys(git_repo)

    result = swm.resolve_worktree_map(
        [{"story_id": "s1", "worktree_path": str(wt)}],
        "master",
        create_missing=True,
        repo_root=git_repo,
    )

    # The created path is recorded in the output AND registered with git.
    assert Path(result[0]["worktree_path"]) == wt.resolve()
    assert wt.is_dir()
    assert _key(wt) in _registered_keys(git_repo)


def test_creation_is_idempotent_on_rerun(git_repo: Path, tmp_path: Path) -> None:
    """Re-running the resolver over an already-created worktree is a no-op."""
    wt = tmp_path / "wt-new"
    args = ([{"story_id": "s1", "worktree_path": str(wt)}], "master")

    first = swm.resolve_worktree_map(*args, create_missing=True, repo_root=git_repo)
    before = _registered_keys(git_repo)
    second = swm.resolve_worktree_map(*args, create_missing=True, repo_root=git_repo)
    after = _registered_keys(git_repo)

    assert first == second
    # No duplicate registration, no error on the second pass.
    assert before == after
    assert _key(wt) in after


def test_missing_worktree_without_create_raises(git_repo: Path, tmp_path: Path) -> None:
    """create_missing=False over an absent worktree raises MissingWorktreeError."""
    wt = tmp_path / "wt-absent"
    with pytest.raises(swm.MissingWorktreeError):
        swm.resolve_worktree_map(
            [{"story_id": "s1", "worktree_path": str(wt)}],
            "master",
            create_missing=False,
            repo_root=git_repo,
        )
    # Nothing was created as a side effect.
    assert not wt.exists()


# ---------------------------------------------------------------------------
# resolve_worktree_map -- collision + base-branch rejection
# ---------------------------------------------------------------------------


def test_same_path_collision_rejected_names_stories(git_repo: Path, tmp_path: Path) -> None:
    """Two stories on the same path raise and name both colliding stories."""
    wt = tmp_path / "wt-shared"
    with pytest.raises(swm.WorktreeCollisionError) as excinfo:
        swm.resolve_worktree_map(
            [
                {"story_id": "alpha", "worktree_path": str(wt)},
                {"story_id": "beta", "worktree_path": str(wt)},
            ],
            "master",
            repo_root=git_repo,
        )
    message = str(excinfo.value)
    assert "alpha" in message
    assert "beta" in message


def test_base_branch_mismatch_rejected(git_repo: Path, tmp_path: Path) -> None:
    """A record base_branch differing from the cohort base raises."""
    wt = tmp_path / "wt-a"
    with pytest.raises(swm.BaseBranchMismatchError) as excinfo:
        swm.resolve_worktree_map(
            [{"story_id": "s1", "worktree_path": str(wt), "base_branch": "develop"}],
            "master",
            repo_root=git_repo,
        )
    message = str(excinfo.value)
    assert "develop" in message
    assert "master" in message


def test_duplicate_story_id_rejected_names_paths(git_repo: Path, tmp_path: Path) -> None:
    """Two records with the same story_id (distinct paths) are rejected.

    Guards against the launch engine receiving two C3 records for one story
    and dispatching it twice.
    """
    wt_a = tmp_path / "wt-a"
    wt_b = tmp_path / "wt-b"
    with pytest.raises(swm.DuplicateStoryError) as excinfo:
        swm.resolve_worktree_map(
            [
                {"story_id": "dup", "worktree_path": str(wt_a)},
                {"story_id": "dup", "worktree_path": str(wt_b)},
            ],
            "master",
            repo_root=git_repo,
        )
    message = str(excinfo.value)
    assert "dup" in message
    # Nothing should have been created before the validation failure.
    assert not wt_a.exists()
    assert not wt_b.exists()


def test_base_branch_mismatch_is_a_validation_error(git_repo: Path, tmp_path: Path) -> None:
    """BaseBranchMismatchError is a WorktreeMapError (exit-1 family), not config."""
    assert issubclass(swm.BaseBranchMismatchError, swm.WorktreeMapError)
    assert issubclass(swm.WorktreeCollisionError, swm.WorktreeMapError)
    assert issubclass(swm.MissingWorktreeError, swm.WorktreeMapError)
    assert issubclass(swm.DuplicateStoryError, swm.WorktreeMapError)


# ---------------------------------------------------------------------------
# resolve_worktree_map -- normalized output + malformed input
# ---------------------------------------------------------------------------


def test_normalized_output_has_exactly_c3_keys(git_repo: Path, tmp_path: Path) -> None:
    """Returned records carry exactly story_id/worktree_path/base_branch."""
    wt = tmp_path / "wt-a"
    result = swm.resolve_worktree_map(
        [{"story_id": "s1", "worktree_path": str(wt)}],
        "master",
        repo_root=git_repo,
    )
    assert set(result[0].keys()) == set(swm.C3_FIELDS)
    # Internal carry fields must not leak into the normalized output.
    assert "_key" not in result[0]
    assert "_abs" not in result[0]
    # worktree_path is an absolute POSIX path.
    assert "\\" not in result[0]["worktree_path"]
    assert Path(result[0]["worktree_path"]).is_absolute()


def test_output_order_mirrors_input(git_repo: Path, tmp_path: Path) -> None:
    result = swm.resolve_worktree_map(
        [
            {"story_id": "s1", "worktree_path": str(tmp_path / "wt-1")},
            {"story_id": "s2", "worktree_path": str(tmp_path / "wt-2")},
        ],
        "master",
        repo_root=git_repo,
    )
    assert [r["story_id"] for r in result] == ["s1", "s2"]


@pytest.mark.parametrize(
    "mapping",
    [
        [{"worktree_path": "wt-a"}],  # missing story_id
        [{"story_id": "s1"}],  # missing worktree_path
        [{"story_id": "", "worktree_path": "wt-a"}],  # blank story_id
        [{"story_id": "s1", "worktree_path": ""}],  # blank worktree_path
        [{"story_id": "s1", "worktree_path": "wt", "base_branch": ""}],  # blank base
        ["not-an-object"],  # record is not a dict
    ],
)
def test_malformed_record_raises_config_error(
    git_repo: Path, mapping: list
) -> None:
    with pytest.raises(swm.WorktreeMapConfigError):
        swm.resolve_worktree_map(mapping, "master", repo_root=git_repo)


def test_non_list_mapping_raises_config_error(git_repo: Path) -> None:
    with pytest.raises(swm.WorktreeMapConfigError):
        swm.resolve_worktree_map({"story_id": "s1"}, "master", repo_root=git_repo)  # type: ignore[arg-type]


def test_blank_base_branch_raises_config_error(git_repo: Path) -> None:
    with pytest.raises(swm.WorktreeMapConfigError):
        swm.resolve_worktree_map([], "  ", repo_root=git_repo)


# ---------------------------------------------------------------------------
# parse_worktree_porcelain unit
# ---------------------------------------------------------------------------


def test_parse_worktree_porcelain_branch_and_detached() -> None:
    text = (
        "worktree /tmp/main\n"
        "HEAD 1111111111111111111111111111111111111111\n"
        "branch refs/heads/master\n"
        "\n"
        "worktree /tmp/wt-a\n"
        "HEAD 2222222222222222222222222222222222222222\n"
        "detached\n"
    )
    parsed = swm.parse_worktree_porcelain(text)
    assert parsed[swm._compare_key(Path("/tmp/main").resolve())] == "master"
    assert parsed[swm._compare_key(Path("/tmp/wt-a").resolve())] is None


# ---------------------------------------------------------------------------
# CLI -- three-state exit
# ---------------------------------------------------------------------------


def _write_map(tmp_path: Path, mapping: list) -> Path:
    map_path = tmp_path / "worktree-map.json"
    map_path.write_text(json.dumps(mapping), encoding="utf-8")
    return map_path


def test_cli_resolves_and_prints_json(git_repo: Path, tmp_path: Path, capsys) -> None:
    wt = tmp_path / "wt-a"
    map_path = _write_map(tmp_path, [{"story_id": "s1", "worktree_path": str(wt)}])

    rc = swm.main(
        ["--map", str(map_path), "--base-branch", "master", "--repo-root", str(git_repo)]
    )

    assert rc == swm.EXIT_OK
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["story_id"] == "s1"
    assert payload[0]["base_branch"] == "master"
    assert wt.is_dir()


def test_cli_collision_exits_1(git_repo: Path, tmp_path: Path, capsys) -> None:
    wt = tmp_path / "wt-shared"
    map_path = _write_map(
        tmp_path,
        [
            {"story_id": "alpha", "worktree_path": str(wt)},
            {"story_id": "beta", "worktree_path": str(wt)},
        ],
    )
    rc = swm.main(
        ["--map", str(map_path), "--base-branch", "master", "--repo-root", str(git_repo)]
    )
    assert rc == swm.EXIT_VALIDATION_ERROR
    assert "collision" in capsys.readouterr().err.lower()


def test_cli_base_mismatch_exits_1(git_repo: Path, tmp_path: Path, capsys) -> None:
    wt = tmp_path / "wt-a"
    map_path = _write_map(
        tmp_path, [{"story_id": "s1", "worktree_path": str(wt), "base_branch": "develop"}]
    )
    rc = swm.main(
        ["--map", str(map_path), "--base-branch", "master", "--repo-root", str(git_repo)]
    )
    assert rc == swm.EXIT_VALIDATION_ERROR


def test_cli_missing_no_create_exits_1(git_repo: Path, tmp_path: Path) -> None:
    wt = tmp_path / "wt-absent"
    map_path = _write_map(tmp_path, [{"story_id": "s1", "worktree_path": str(wt)}])
    rc = swm.main(
        [
            "--map",
            str(map_path),
            "--base-branch",
            "master",
            "--repo-root",
            str(git_repo),
            "--no-create-missing",
        ]
    )
    assert rc == swm.EXIT_VALIDATION_ERROR


def test_cli_bad_json_exits_2(git_repo: Path, tmp_path: Path, capsys) -> None:
    map_path = tmp_path / "bad.json"
    map_path.write_text("{not json", encoding="utf-8")
    rc = swm.main(
        ["--map", str(map_path), "--base-branch", "master", "--repo-root", str(git_repo)]
    )
    assert rc == swm.EXIT_CONFIG_ERROR
    assert "config error" in capsys.readouterr().err.lower()


def test_cli_non_array_json_exits_2(git_repo: Path, tmp_path: Path) -> None:
    map_path = tmp_path / "obj.json"
    map_path.write_text(json.dumps({"story_id": "s1"}), encoding="utf-8")
    rc = swm.main(
        ["--map", str(map_path), "--base-branch", "master", "--repo-root", str(git_repo)]
    )
    assert rc == swm.EXIT_CONFIG_ERROR
