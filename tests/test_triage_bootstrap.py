"""tests/test_triage_bootstrap.py -- triage v1 bootstrap (#845 Story 6).

Six cases per the vBRIEF Test narrative:

1. Fresh-project end-to-end: empty project, bootstrap creates .gitignore
   with the cache line, no-op for backfill (no vbrief/), gitcrawl-skipped.
2. Re-run idempotent: re-running bootstrap twice produces zero duplicate
   audit entries and zero gitignore drift.
3. Backfill respects existing lifecycle folders: vBRIEFs in proposed/,
   pending/, active/ get one accepted entry each (one entry per issue
   number).
4. Cancelled/ skipped: vBRIEFs in cancelled/ are NOT reanimated; the
   diagnostic count of skipped-cancelled is surfaced for transparency.
5. Gitcrawl-already-installed no-op: when shutil.which returns a path,
   the gitcrawl step is a no-op.
6. Taskfile includes wired correctly: parent Taskfile.yml carries the
   `includes:` entries for all four triage v1 fragment files.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

# ---------------------------------------------------------------------------
# Module loader -- mirrors the conftest pattern of importing extension-less
# scripts via importlib.spec_from_file_location.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "triage_bootstrap.py"


def _load_bootstrap_module() -> Any:
    """Load scripts/triage_bootstrap.py into the test session.

    Loaded fresh per session so test fixtures don't share global state with
    any other test module (the script touches sys.path which can leak).
    """
    if "triage_bootstrap" in sys.modules:
        return sys.modules["triage_bootstrap"]
    spec = importlib.util.spec_from_file_location(
        "triage_bootstrap", SCRIPT_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["triage_bootstrap"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def bootstrap():
    """Module-scoped triage_bootstrap import."""
    return _load_bootstrap_module()


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

def _write_vbrief(folder: Path, slug: str, issue_number: int, status: str = "proposed") -> Path:
    """Write a minimal scope vBRIEF that traces to a GitHub issue."""
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"2026-05-03-{issue_number}-{slug}.vbrief.json"
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "title": f"Test brief for #{issue_number}",
            "status": status,
            "items": [],
            "references": [
                {
                    "uri": f"https://github.com/deftai/directive/issues/{issue_number}",
                    "type": "x-vbrief/github-issue",
                    "title": f"Issue #{issue_number}",
                }
            ],
        },
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def _read_audit_entries(audit_path: Path) -> list[dict[str, Any]]:
    """Read the JSONL audit log into a list of dicts."""
    if not audit_path.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in audit_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        entries.append(json.loads(line))
    return entries


# ---------------------------------------------------------------------------
# Case 1 -- fresh-project end-to-end
# ---------------------------------------------------------------------------


def test_fresh_project_end_to_end(bootstrap, tmp_path: Path) -> None:
    """Bootstrap on an empty project root creates .gitignore + skips other steps gracefully."""
    # Force gitcrawl absent + pipx absent so the gitcrawl step takes the
    # deferred-no-pipx path (no subprocess interaction).
    with mock.patch.object(bootstrap.shutil, "which", return_value=None):
        result = bootstrap.run_bootstrap(
            project_root=tmp_path, repo=None, skip_gitcrawl=False
        )

    assert result.exit_code == 0
    step_names = [s.name for s in result.steps]
    assert step_names == [
        "populate_cache",
        "backfill_audit_log",
        "ensure_gitignore_entry",
        "ensure_gitcrawl",
    ]
    # Steps without --repo should skip-with-OK.
    populate = result.steps[0]
    assert populate.ok and populate.details.get("skipped") == "no-repo"
    backfill = result.steps[1]
    assert backfill.ok and backfill.details.get("skipped") == "no-repo"
    # Gitignore created.
    gitignore = tmp_path / ".gitignore"
    assert gitignore.exists()
    assert ".deft-cache/" in gitignore.read_text(encoding="utf-8")
    # Gitcrawl deferred.
    gitcrawl = result.steps[3]
    assert gitcrawl.ok
    assert gitcrawl.details.get("action") == "deferred-no-pipx"


# ---------------------------------------------------------------------------
# Case 2 -- re-run idempotent (no duplicate audit entries)
# ---------------------------------------------------------------------------


def test_rerun_is_idempotent(bootstrap, tmp_path: Path) -> None:
    """Two consecutive bootstrap calls must produce zero new audit entries on the second pass."""
    vbrief_root = tmp_path / "vbrief"
    _write_vbrief(vbrief_root / "proposed", "alpha", issue_number=101)
    _write_vbrief(vbrief_root / "pending", "beta", issue_number=102)
    _write_vbrief(vbrief_root / "active", "gamma", issue_number=103)

    with mock.patch.object(bootstrap.shutil, "which", return_value=None):
        first = bootstrap.run_bootstrap(
            project_root=tmp_path, repo="deftai/directive", skip_gitcrawl=True
        )
        second = bootstrap.run_bootstrap(
            project_root=tmp_path, repo="deftai/directive", skip_gitcrawl=True
        )

    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    assert audit_path.exists()
    entries = _read_audit_entries(audit_path)
    # Exactly three entries -- one per issue, no duplicates.
    assert len(entries) == 3
    issue_numbers = sorted(e["issue_number"] for e in entries)
    assert issue_numbers == [101, 102, 103]
    # Every entry is an `accept` decision.
    assert all(e["decision"] == "accept" for e in entries)
    # First run appended 3, second run appended 0.
    assert first.steps[1].details["appended"] == 3
    assert second.steps[1].details["appended"] == 0
    assert second.steps[1].details["skipped_existing"] == 3
    # Gitignore did not double-append.
    gitignore_text = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert gitignore_text.count(".deft-cache/\n") == 1


# ---------------------------------------------------------------------------
# Case 3 -- backfill respects existing lifecycle folders
# ---------------------------------------------------------------------------


def test_backfill_respects_existing_lifecycle_folders(
    bootstrap, tmp_path: Path
) -> None:
    """Each of proposed/, pending/, active/ contributes; completed/ does not."""
    vbrief_root = tmp_path / "vbrief"
    _write_vbrief(vbrief_root / "proposed", "p1", issue_number=201)
    _write_vbrief(vbrief_root / "proposed", "p2", issue_number=202)
    _write_vbrief(vbrief_root / "pending", "q1", issue_number=203)
    _write_vbrief(vbrief_root / "active", "r1", issue_number=204)
    # completed/ exists but is excluded from backfill (work no longer in the
    # triage funnel; the bootstrap docstring spells this out).
    _write_vbrief(vbrief_root / "completed", "c1", issue_number=205)

    with mock.patch.object(bootstrap.shutil, "which", return_value=None):
        result = bootstrap.run_bootstrap(
            project_root=tmp_path,
            repo="deftai/directive",
            skip_gitcrawl=True,
        )

    assert result.exit_code == 0
    backfill = result.steps[1]
    assert backfill.ok
    assert backfill.details["appended"] == 4
    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    issue_numbers = sorted(
        e["issue_number"] for e in _read_audit_entries(audit_path)
    )
    assert issue_numbers == [201, 202, 203, 204]


# ---------------------------------------------------------------------------
# Case 4 -- cancelled/ skipped (no reanimation)
# ---------------------------------------------------------------------------


def test_cancelled_folder_is_not_reanimated(bootstrap, tmp_path: Path) -> None:
    """vBRIEFs in vbrief/cancelled/ MUST NOT receive backfill entries."""
    vbrief_root = tmp_path / "vbrief"
    _write_vbrief(vbrief_root / "proposed", "live", issue_number=300)
    _write_vbrief(vbrief_root / "cancelled", "rejected1", issue_number=301)
    _write_vbrief(vbrief_root / "cancelled", "rejected2", issue_number=302)

    with mock.patch.object(bootstrap.shutil, "which", return_value=None):
        result = bootstrap.run_bootstrap(
            project_root=tmp_path,
            repo="deftai/directive",
            skip_gitcrawl=True,
        )

    backfill = result.steps[1]
    assert backfill.ok
    assert backfill.details["appended"] == 1, (
        "Only the proposed/ entry should be appended; cancelled/ items "
        "must NOT be reanimated."
    )
    # Diagnostic count surfaces the cancelled-skip transparency.
    assert backfill.details["skipped_cancelled"] == 2

    audit_path = tmp_path / "vbrief" / ".eval" / "candidates.jsonl"
    issue_numbers = {
        e["issue_number"] for e in _read_audit_entries(audit_path)
    }
    assert issue_numbers == {300}
    # Defence-in-depth: explicitly assert the cancelled issue numbers do
    # NOT appear in the audit log.
    assert 301 not in issue_numbers
    assert 302 not in issue_numbers


# ---------------------------------------------------------------------------
# Case 5 -- gitcrawl-already-installed no-op
# ---------------------------------------------------------------------------


def test_gitcrawl_already_installed_is_noop(bootstrap, tmp_path: Path) -> None:
    """When shutil.which finds gitcrawl on PATH, the step must be a no-op."""
    fake_path = "/usr/local/bin/gitcrawl"

    def _fake_which(cmd: str) -> str | None:
        # Only gitcrawl resolves; everything else is missing so the test
        # does not accidentally trip on pipx detection.
        return fake_path if cmd == "gitcrawl" else None

    with mock.patch.object(bootstrap.shutil, "which", side_effect=_fake_which):
        outcome = bootstrap.step_ensure_gitcrawl(skip=False)

    assert outcome.ok
    assert outcome.details.get("installed") is True
    assert outcome.details.get("action") == "noop"
    assert "already on PATH" in outcome.message


# ---------------------------------------------------------------------------
# Greptile P2 regression guard -- _is_commented_gitignore_line tightening
# ---------------------------------------------------------------------------


class TestIsCommentedGitignoreLine:
    """Regression coverage for the NFR-2 opt-in detection (#877 Greptile P2).

    The original implementation used a loose substring check
    (``GITIGNORE_LINE in raw``), which would silently treat *any* comment
    that mentioned ``.deft-cache/`` -- e.g. a documentation note --
    as the consumer's explicit opt-in to commit the cache. That would
    suppress the bootstrap's gitignore append and silently leave the
    cache unprotected. The tightened helper anchors on the literal
    commented-out form. These tests pin both the accept set and the
    reject set so a future loosening cannot regress the behaviour.
    """

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("# .deft-cache/", True),
            ("#.deft-cache/", True),
            ("  # .deft-cache/  ", True),
            ("\t# .deft-cache/\t", True),
            ("## .deft-cache/", True),
            ("### .deft-cache/", True),
            (".deft-cache/", False),
            ("# Do not track files under .deft-cache/ here", False),
            ("# anything-else.deft-cache/", False),
            ("# .deft-cache/something", False),
            ("", False),
            ("   ", False),
            ("# unrelated comment", False),
            ("node_modules/", False),
        ],
    )
    def test_match_set(self, bootstrap, raw: str, expected: bool) -> None:
        assert (
            bootstrap._is_commented_gitignore_line(raw, ".deft-cache/")
            is expected
        ), f"Expected {expected} for {raw!r}"

    def test_loose_mention_does_not_trigger_optin(
        self, bootstrap, tmp_path: Path
    ) -> None:
        """A comment that merely mentions the cache must NOT be treated as opt-in.

        End-to-end through the gitignore step: a .gitignore that contains a
        documentation comment mentioning .deft-cache/ but no active rule
        and no commented-out form MUST result in the bootstrap appending
        the active line (NFR-1 default-on remains in force).
        """
        gitignore = tmp_path / ".gitignore"
        gitignore.write_text(
            "# Do not track files under .deft-cache/ here.\n"
            "node_modules/\n",
            encoding="utf-8",
        )
        outcome = bootstrap.step_ensure_gitignore_entry(tmp_path)
        assert outcome.ok
        assert outcome.details["appended"] is True, (
            "Loose mention of .deft-cache/ in a comment must not be "
            "treated as the NFR-2 opt-in; the active rule must be added."
        )
        assert "\n.deft-cache/\n" in gitignore.read_text(encoding="utf-8")

    def test_literal_commented_out_form_is_optin(
        self, bootstrap, tmp_path: Path
    ) -> None:
        """The exact `# .deft-cache/` form IS the NFR-2 opt-in."""
        gitignore = tmp_path / ".gitignore"
        gitignore.write_text(
            "node_modules/\n# .deft-cache/\n", encoding="utf-8"
        )
        outcome = bootstrap.step_ensure_gitignore_entry(tmp_path)
        assert outcome.ok
        assert outcome.details.get("opt_in_commit_cache") is True
        assert outcome.details["appended"] is False
        # The active rule MUST NOT be appended in this case.
        assert (
            "\n.deft-cache/\n"
            not in gitignore.read_text(encoding="utf-8")
        )


# ---------------------------------------------------------------------------
# Recap regression -- Greptile P1 on PR #877: don't print non-existent aliases
# ---------------------------------------------------------------------------


class TestRecapNamespacedForms:
    """Pin the BootstrapResult.summary() recap to namespaced forms.

    Greptile flagged a P1 on PR #877 because the original recap printed
    `task triage:cache`, `task triage:show <N>`, etc. -- shorthand forms
    that are NOT wired by Story 6 (only `task triage:bootstrap` is wired
    as a top-level alias; the rest live under their fragment include
    namespace). A user copy-pasting from the recap would have hit
    `task: No such task "triage:cache"`. The recap was updated to use
    the namespaced forms (`task triage-cache:cache`, etc.) plus an
    explicit deferral note. These tests pin both the positive (namespaced
    forms present) and the negative (shorthand forms absent) so a future
    well-meaning revert cannot regress the user surface.
    """

    def _ok_recap(self, bootstrap):
        """Construct a successful BootstrapResult for assertion."""
        result = bootstrap.BootstrapResult(
            project_root=Path("."),
            repo="deftai/directive",
        )
        result.steps.append(
            bootstrap.StepOutcome(
                name="populate_cache", ok=True, message="stub"
            )
        )
        result.steps.append(
            bootstrap.StepOutcome(
                name="backfill_audit_log", ok=True, message="stub"
            )
        )
        result.steps.append(
            bootstrap.StepOutcome(
                name="ensure_gitignore_entry", ok=True, message="stub"
            )
        )
        result.steps.append(
            bootstrap.StepOutcome(
                name="ensure_gitcrawl", ok=True, message="stub"
            )
        )
        result.exit_code = 0
        return result.summary()

    @pytest.mark.parametrize(
        "namespaced_form",
        [
            "task triage-cache:cache",
            "task triage-cache:show <N>",
            "task triage-actions:accept <N>",
            "task triage-actions:reject <N>",
            "task triage-bulk:bulk-accept",
            "task triage-bulk:refresh-active",
        ],
    )
    def test_namespaced_forms_present(self, bootstrap, namespaced_form: str) -> None:
        """Every documented next-step command MUST use the namespaced form."""
        recap = self._ok_recap(bootstrap)
        assert namespaced_form in recap, (
            f"Recap missing the namespaced form {namespaced_form!r}; the "
            "shorthand `task triage:<verb>` aliases are NOT wired by "
            "Story 6."
        )

    @pytest.mark.parametrize(
        "shorthand",
        [
            "task triage:cache ",
            "task triage:show ",
            "task triage:accept ",
            "task triage:reject ",
            "task triage:bulk-accept ",
            "task triage:refresh-active",
        ],
    )
    def test_shorthand_forms_not_advertised(
        self, bootstrap, shorthand: str
    ) -> None:
        """Shorthand `task triage:<verb>` forms MUST NOT appear in the recap.

        Story 6 only wires `task triage:bootstrap`; the other shorthand
        forms are deferred to a follow-up cleanup PR. The recap MUST NOT
        advertise commands that don't exist.
        """
        recap = self._ok_recap(bootstrap)
        assert shorthand not in recap, (
            f"Recap advertises non-existent command {shorthand!r}; "
            "only `task triage:bootstrap` is wired by Story 6, all "
            "other forms must use the `task <namespace>:<task>` shape."
        )

    def test_recap_carries_deferral_note(self, bootstrap) -> None:
        """Recap MUST include the deferral note pointing at UPGRADING.md."""
        recap = self._ok_recap(bootstrap)
        assert "shorthand" in recap.lower()
        assert "UPGRADING.md" in recap


# ---------------------------------------------------------------------------
# Case 6 -- Taskfile includes wired correctly
# ---------------------------------------------------------------------------


def test_taskfile_includes_wired_for_four_fragments() -> None:
    """The parent Taskfile.yml MUST include all four triage v1 fragments.

    Two-pronged check (parse + grep) per the vBRIEF Test narrative:

    1. Parse: Taskfile.yml is valid YAML and the `includes` key exists.
    2. Grep: every fragment file path is referenced under `includes:`.

    The parse step uses PyYAML when available (already a project test
    dependency per other content tests), with a regex fallback so the test
    is hermetic if PyYAML is not yet installed in a fresh checkout.
    """
    parent = REPO_ROOT / "Taskfile.yml"
    text = parent.read_text(encoding="utf-8")

    # Parse pass.
    try:
        import yaml  # type: ignore[import-untyped]

        parsed = yaml.safe_load(text)
        assert isinstance(parsed, dict)
        includes = parsed.get("includes") or {}
        assert isinstance(includes, dict), "Taskfile.yml `includes:` is not a mapping"
        # Each fragment is wired with a unique key (see the parent Taskfile
        # comment block explaining why same-namespace shared keys are not
        # supported by go-task v3).
        for key in (
            "triage-cache",
            "triage-actions",
            "triage-bulk",
            "triage-bootstrap",
        ):
            assert key in includes, (
                f"Taskfile.yml `includes:` block is missing the {key!r} entry "
                f"(required by #845 Story 6 wiring)."
            )
            entry = includes[key]
            # go-task accepts string-form short includes too; normalize.
            taskfile_path = (
                entry.get("taskfile") if isinstance(entry, dict) else entry
            )
            assert taskfile_path == f"./tasks/{key}.yml", (
                f"include `{key}` taskfile path should be ./tasks/{key}.yml, "
                f"got {taskfile_path!r}"
            )
    except ImportError:
        # Fallback grep: confirm the four fragment paths are mentioned at
        # all in the parent Taskfile. This is weaker than the parse check
        # but suffices for the hermetic-no-pyyaml case.
        for path in (
            "./tasks/triage-cache.yml",
            "./tasks/triage-actions.yml",
            "./tasks/triage-bulk.yml",
            "./tasks/triage-bootstrap.yml",
        ):
            assert path in text, (
                f"Taskfile.yml does not reference {path} (#845 Story 6)."
            )

    # Defence-in-depth grep: regardless of which path the parse pass took,
    # confirm the four fragment file paths physically appear in the parent
    # Taskfile. This pins the test against future YAML refactors that might
    # alter the in-memory structure but lose a reference.
    for fragment_relpath in (
        "./tasks/triage-cache.yml",
        "./tasks/triage-actions.yml",
        "./tasks/triage-bulk.yml",
        "./tasks/triage-bootstrap.yml",
    ):
        assert fragment_relpath in text, (
            f"Taskfile.yml lost reference to {fragment_relpath} "
            "(parent-Taskfile-wiring guard, #845 Story 6)."
        )

    # Additional sanity: the bootstrap fragment file MUST exist (this story
    # owns it). The other three are owned by upstream stories and may not
    # be on master at PR-creation time -- the include is `optional: true`
    # so they materialize as the cascade lands.
    bootstrap_fragment = REPO_ROOT / "tasks" / "triage-bootstrap.yml"
    assert bootstrap_fragment.is_file(), (
        f"{bootstrap_fragment} is missing -- Story 6 owns this file."
    )
    fragment_text = bootstrap_fragment.read_text(encoding="utf-8")
    assert re.search(r"^\s*bootstrap:", fragment_text, re.MULTILINE), (
        "triage-bootstrap.yml must define an inner `bootstrap:` task."
    )
