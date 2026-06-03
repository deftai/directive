"""Tests for `vbrief/.eval/` tracking governance (#1144, N4 of #1119).

Two concerns under test:

1. The repo's actual governance files (`.gitignore`, `.gitattributes`,
   `vbrief/.eval/README.md`) carry the entries the Current Shape comment
   on #1144 mandates. These are static, deterministic content gates so a
   future edit that drops or rewrites the rule fails CI immediately.

2. A `merge=union` attribute on a `*.jsonl` glob auto-resolves the
   canonical append-branches-rebase scenario: branch A appends record X
   to a shared JSONL, branch B (from the same base) appends record Y,
   merging B into A produces both lines without a conflict marker. This
   is what the `.gitattributes` rule buys operators on rebase, so the
   contract is pinned with an actual git invocation rather than just
   trusting git's documented behaviour.

Both halves are pure-stdlib (`subprocess` + `pathlib`) so the test runs
under the same `task check` umbrella as the rest of the suite, with no
extra dependencies.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


# -- Section 1: repo-level governance content -------------------------------


def test_gitignore_has_selective_eval_entries() -> None:
    """The selective hybrid policy is encoded in the repo `.gitignore`."""
    body = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "vbrief/.eval/candidates.jsonl" in body, (
        "operator-private candidates.jsonl must be gitignored (#1144)"
    )
    assert "vbrief/.eval/summary-history.jsonl" in body, (
        "operator-private summary-history.jsonl must be gitignored (#1144)"
    )
    assert "vbrief/.eval/scope-lifecycle.jsonl" in body, (
        "operator-private scope-lifecycle.jsonl must be gitignored (#1144)"
    )
    assert "vbrief/.eval/decompositions/" in body, (
        "temporary decomposition proposal drafts must be gitignored"
    )
    assert "vbrief/.eval/doctor-state.json" in body, (
        "per-machine task doctor throttle state must be gitignored (#1464)"
    )


def test_gitignore_does_not_blanket_ignore_eval_directory() -> None:
    """Blanket `vbrief/.eval/` line MUST be gone -- `slices.jsonl` is tracked."""
    lines = [
        line.strip()
        for line in (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    # A bare `vbrief/.eval/` (with or without trailing slash) would ignore the
    # entire directory and defeat the hybrid policy. We explicitly forbid both.
    assert "vbrief/.eval/" not in lines, (
        "blanket gitignore of vbrief/.eval/ defeats the hybrid policy (#1144)"
    )
    assert "vbrief/.eval" not in lines


def test_gitattributes_declares_merge_union_for_eval_jsonl() -> None:
    """The repo `.gitattributes` declares the merge=union rule."""
    body = (REPO_ROOT / ".gitattributes").read_text(encoding="utf-8")
    # Look for the rule on a non-comment line. Whitespace between the path
    # pattern and the attribute is unspecified by git's parser, so we match
    # both with and without the canonical double-space form.
    rule_lines = [
        line.strip()
        for line in body.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    matched = [
        line
        for line in rule_lines
        if line.startswith("vbrief/.eval/*.jsonl") and "merge=union" in line
    ]
    assert matched, (
        ".gitattributes must carry `vbrief/.eval/*.jsonl  merge=union` (#1144); "
        f"non-comment lines were: {rule_lines!r}"
    )


def test_eval_readme_documents_policy() -> None:
    """`vbrief/.eval/README.md` exists and covers load-bearing policy claims."""
    readme = REPO_ROOT / "vbrief" / ".eval" / "README.md"
    assert readme.is_file(), "vbrief/.eval/README.md must exist (#1144)"
    body = readme.read_text(encoding="utf-8")
    # Tracking policy claims (the three files + their tracked/gitignored status)
    assert "slices.jsonl" in body
    assert "candidates.jsonl" in body
    assert "summary-history.jsonl" in body
    assert "scope-lifecycle.jsonl" in body
    assert "decompositions/" in body
    assert "Temporary story-decomposition proposal drafts" in body
    assert "not vBRIEFs" in body
    assert "doctor-state.json" in body  # #1464 per-machine doctor throttle state
    # Fresh-clone regeneration command
    assert "task triage:bootstrap" in body
    # merge=union policy + the load-bearing "no dedupe" qualifier so future
    # operators reading the README don't expect deduplication.
    assert "merge=union" in body
    assert "dedup" in body.lower(), (
        "README must document that merge=union does NOT dedupe (#1144)"
    )


# -- Section 2: append-merge behaviour pinned via a real git invocation -----


def _git(cwd: Path, *args: str, env: dict[str, str] | None = None) -> str:
    """Run a non-paginated git command in `cwd`, returning stdout."""
    base_env = os.environ.copy()
    base_env.update(
        {
            "GIT_AUTHOR_NAME": "deft-test",
            "GIT_AUTHOR_EMAIL": "deft-test@example.invalid",
            "GIT_COMMITTER_NAME": "deft-test",
            "GIT_COMMITTER_EMAIL": "deft-test@example.invalid",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    if env:
        base_env.update(env)
    result = subprocess.run(
        ["git", "--no-pager", *args],
        cwd=str(cwd),
        env=base_env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"git {args!r} failed in {cwd}: rc={result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result.stdout


def _have_git() -> bool:
    try:
        subprocess.run(
            ["git", "--version"], capture_output=True, check=True, text=True
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


@pytest.mark.skipif(not _have_git(), reason="git not on PATH")
def test_append_merge_union_produces_concatenation(tmp_path: Path) -> None:
    """Two append-only branches against a shared JSONL auto-merge via union.

    Reproduces the canonical single-operator rebase scenario the
    `.gitattributes` rule was designed for: branch A appends record X,
    branch B (forked from the same base) appends record Y, merging B
    into A produces a file containing BOTH appended lines plus the
    original base line, in some order, with no conflict markers.

    `merge=union` does NOT dedupe -- the test asserts that explicitly by
    counting line occurrences, not just substring presence.
    """
    repo = tmp_path / "merge-union-repo"
    repo.mkdir()
    _git(repo, "init", "--initial-branch=master", "-q")

    # Mirror the canonical glob the repo ships in `.gitattributes`. We
    # write the path with a literal `vbrief/.eval/` prefix so the rule
    # applies to the test file via the same pattern.
    (repo / ".gitattributes").write_text(
        "vbrief/.eval/*.jsonl  merge=union\n", encoding="utf-8"
    )
    eval_dir = repo / "vbrief" / ".eval"
    eval_dir.mkdir(parents=True)
    target = eval_dir / "slices.jsonl"
    target.write_text('{"id": "base", "n": 0}\n', encoding="utf-8")
    _git(repo, "add", ".gitattributes", "vbrief/.eval/slices.jsonl")
    _git(repo, "commit", "-q", "-m", "base: shared slices.jsonl")

    # Branch A: append record X.
    _git(repo, "checkout", "-q", "-b", "branch-a")
    with target.open("a", encoding="utf-8") as fh:
        fh.write('{"id": "a1", "n": 1}\n')
    _git(repo, "add", "vbrief/.eval/slices.jsonl")
    _git(repo, "commit", "-q", "-m", "branch-a: append a1")

    # Branch B: fork off master, append record Y.
    _git(repo, "checkout", "-q", "master")
    _git(repo, "checkout", "-q", "-b", "branch-b")
    with target.open("a", encoding="utf-8") as fh:
        fh.write('{"id": "b1", "n": 2}\n')
    _git(repo, "add", "vbrief/.eval/slices.jsonl")
    _git(repo, "commit", "-q", "-m", "branch-b: append b1")

    # Merge branch-b into branch-a. With merge=union, this must auto-resolve.
    _git(repo, "checkout", "-q", "branch-a")
    _git(repo, "merge", "--no-edit", "-q", "branch-b")

    merged = target.read_text(encoding="utf-8")

    # No conflict markers leaked through.
    for marker in ("<<<<<<<", "=======", ">>>>>>>"):
        assert marker not in merged, (
            f"merge=union must auto-resolve; found conflict marker {marker!r}\n"
            f"file body:\n{merged}"
        )

    # Both branches' appended lines AND the base line are present.
    lines = [line for line in merged.splitlines() if line.strip()]
    assert '{"id": "base", "n": 0}' in lines
    assert '{"id": "a1", "n": 1}' in lines
    assert '{"id": "b1", "n": 2}' in lines

    # Exactly three distinct lines -- merge=union is line-level concat, not
    # deduping the base line because both branches kept it.
    assert len(lines) == 3, (
        "merge=union should yield exactly 3 lines (base + a1 + b1); "
        f"got {len(lines)}: {lines!r}"
    )


@pytest.mark.skipif(not _have_git(), reason="git not on PATH")
def test_append_merge_union_preserves_distinct_records(
    tmp_path: Path,
) -> None:
    """Distinct records on both branches survive verbatim -- no smart dedup.

    Pins the load-bearing qualifier the README documents: `merge=union` is
    a line-level concat with no "semantic" deduplication. If branch A
    appends one record and branch B appends a similar-but-not-identical
    record (e.g. same `issue_number` but different `decision_id`),
    downstream readers see BOTH records and MUST tolerate multiple
    entries describing the same logical decision; git will not collapse
    them just because they look related.

    (Git's three-way merge DOES collapse byte-identical appends because
    they show up as the same diff hunk -- that is a property of the
    base merge algorithm, not of `merge=union`. The decision_id minted
    by `scripts/candidates_log.py` for each append makes that case
    vanishingly rare in practice.)
    """
    repo = tmp_path / "distinct-records-repo"
    repo.mkdir()
    _git(repo, "init", "--initial-branch=master", "-q")

    (repo / ".gitattributes").write_text(
        "vbrief/.eval/*.jsonl  merge=union\n", encoding="utf-8"
    )
    eval_dir = repo / "vbrief" / ".eval"
    eval_dir.mkdir(parents=True)
    target = eval_dir / "slices.jsonl"
    target.write_text("seed\n", encoding="utf-8")
    _git(repo, "add", ".gitattributes", "vbrief/.eval/slices.jsonl")
    _git(repo, "commit", "-q", "-m", "base")

    # Same `issue_number` but distinct `decision_id` -- the realistic
    # collision case the README warns downstream readers about.
    record_a = '{"issue_number": 42, "decision_id": "a-uuid"}\n'
    record_b = '{"issue_number": 42, "decision_id": "b-uuid"}\n'

    _git(repo, "checkout", "-q", "-b", "branch-a")
    with target.open("a", encoding="utf-8") as fh:
        fh.write(record_a)
    _git(repo, "add", "vbrief/.eval/slices.jsonl")
    _git(repo, "commit", "-q", "-m", "branch-a: append record_a")

    _git(repo, "checkout", "-q", "master")
    _git(repo, "checkout", "-q", "-b", "branch-b")
    with target.open("a", encoding="utf-8") as fh:
        fh.write(record_b)
    _git(repo, "add", "vbrief/.eval/slices.jsonl")
    _git(repo, "commit", "-q", "-m", "branch-b: append record_b")

    _git(repo, "checkout", "-q", "branch-a")
    _git(repo, "merge", "--no-edit", "-q", "branch-b")

    merged_lines = [
        line
        for line in target.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    # Both distinct records survive; git did not collapse them just
    # because they share `issue_number`. seed + record_a + record_b.
    assert record_a.strip() in merged_lines
    assert record_b.strip() in merged_lines
    assert "seed" in merged_lines
    assert len(merged_lines) == 3, (
        "merge=union must preserve distinct records verbatim, no smart "
        f"dedup. lines: {merged_lines!r}"
    )
