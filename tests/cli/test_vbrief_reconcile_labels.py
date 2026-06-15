"""Acceptance tests for ``task vbrief:reconcile:labels`` (#1288).

The label reconciler walks the in-flight vBRIEF lifecycle folders
(``proposed/`` / ``pending/`` / ``active/``), resolves each brief's linked
GitHub issue from its ``x-vbrief/github-issue`` reference, and applies /
removes a fixed set of *managed* SCM labels so the forge surface mirrors
canonical vBRIEF state:

- ``plan.status == "blocked"`` OR an unresolved
  ``plan.metadata.swarm.depends_on[]`` entry -> ``status:blocked``
- ``plan.metadata.kind == "epic"``     -> ``epic`` + ``status:tracker``
- ``plan.metadata.kind == "research"`` -> ``rfc``

The verb is idempotent (a second run makes no forge mutation), never
touches labels outside the managed set, and routes every forge call
through ``scripts/scm.py`` (#1145). These tests inject a fake SCM label
client so the suite never makes a live ``gh`` call.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "vbrief_reconcile_labels.py"

sys.path.insert(0, str(REPO_ROOT / "scripts"))

import vbrief_reconcile_labels as mod  # noqa: E402

_STATUS_FOR_FOLDER = {
    "proposed": "proposed",
    "pending": "pending",
    "active": "running",
    "completed": "completed",
    "cancelled": "cancelled",
}


class FakeLabelClient:
    """In-memory stand-in for the scm-backed label client.

    ``labels`` maps ``(repo, issue_number)`` -> current label name list.
    ``apply`` mutates that state so a second reconcile run is a genuine
    no-op, exactly as the live forge would behave.
    """

    def __init__(self, labels: dict[tuple[str, int], list[str]] | None = None) -> None:
        self.labels: dict[tuple[str, int], list[str]] = {
            key: list(value) for key, value in (labels or {}).items()
        }
        self.apply_calls: list[tuple[str, int, list[str], list[str]]] = []

    def fetch_labels(self, repo: str, issue_number: int) -> list[str]:
        return list(self.labels.get((repo, issue_number), []))

    def apply(
        self,
        repo: str,
        issue_number: int,
        add,
        remove,
    ) -> None:
        add = list(add)
        remove = list(remove)
        self.apply_calls.append((repo, issue_number, add, remove))
        current = set(self.labels.get((repo, issue_number), []))
        current |= set(add)
        current -= set(remove)
        self.labels[(repo, issue_number)] = sorted(current)


def _write_brief(
    project: Path,
    story_id: str,
    *,
    folder: str = "active",
    status: str | None = None,
    kind: str = "story",
    depends_on: list[str] | None = None,
    issue_number: int | None = None,
    repo: str = "deftai/directive",
    with_reference: bool = True,
) -> Path:
    """Write a minimal but schema-plausible story vBRIEF into *folder*."""
    path = project / "vbrief" / folder / f"2026-05-21-{story_id}.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    references = []
    if with_reference and issue_number is not None:
        references.append(
            {
                "uri": f"https://github.com/{repo}/issues/{issue_number}",
                "type": "x-vbrief/github-issue",
                "title": f"Issue #{issue_number}",
            }
        )
    data = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": story_id,
            "title": story_id,
            "status": status or _STATUS_FOR_FOLDER[folder],
            "narratives": {
                "Description": f"{story_id} description.",
                "ImplementationPlan": f"1. Do {story_id}.",
                "UserStory": f"As a user, I want {story_id}.",
                "Traces": "FR-1",
            },
            "items": [
                {
                    "id": f"{story_id}-a1",
                    "title": "Acceptance item 1",
                    "status": "pending",
                    "narrative": {"Acceptance": f"Given X when {story_id} then Y."},
                }
            ],
            "metadata": {
                "kind": kind,
                "swarm": {
                    "readiness": "ready",
                    "parallel_safe": True,
                    "file_scope": [f"src/{story_id}.py"],
                    "verify_commands": [f"pytest {story_id}"],
                    "expected_outputs": ["tests pass"],
                    "depends_on": depends_on or [],
                    "conflict_group": "reconcile-suite",
                    "size": "small",
                    "file_scope_confidence": "high",
                    "model_tier": "standard",
                },
            },
            "references": references,
        },
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _run_cli(project: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--project-root", str(project), *extra],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


# ---------------------------------------------------------------------------
# compute_desired_labels unit coverage
# ---------------------------------------------------------------------------


def test_desired_blocked_status() -> None:
    plan = {"status": "blocked", "metadata": {"kind": "story"}}
    assert mod.compute_desired_labels(plan, unresolved_deps=False) == {"status:blocked"}


def test_desired_unresolved_deps_blocks() -> None:
    plan = {"status": "running", "metadata": {"kind": "story"}}
    assert mod.compute_desired_labels(plan, unresolved_deps=True) == {"status:blocked"}


def test_desired_epic() -> None:
    plan = {"status": "running", "metadata": {"kind": "epic"}}
    assert mod.compute_desired_labels(plan, unresolved_deps=False) == {
        "epic",
        "status:tracker",
    }


def test_desired_research() -> None:
    plan = {"status": "running", "metadata": {"kind": "research"}}
    assert mod.compute_desired_labels(plan, unresolved_deps=False) == {"rfc"}


def test_desired_plain_story_empty() -> None:
    plan = {"status": "running", "metadata": {"kind": "story"}}
    assert mod.compute_desired_labels(plan, unresolved_deps=False) == set()


# ---------------------------------------------------------------------------
# reconcile_labels end-to-end (injected client)
# ---------------------------------------------------------------------------


def test_blocked_status_adds_label(tmp_path: Path) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=10)
    client = FakeLabelClient()

    exit_code, outcome = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert ("deftai/directive", 10, ["status:blocked"], []) in client.apply_calls
    assert client.labels[("deftai/directive", 10)] == ["status:blocked"]


def test_unresolved_dep_adds_blocked(tmp_path: Path) -> None:
    # dep lives in pending/ (not terminal) -> unresolved -> blocked.
    _write_brief(tmp_path, "dep-a", folder="pending", issue_number=1)
    _write_brief(
        tmp_path,
        "child-b",
        folder="active",
        depends_on=["dep-a"],
        issue_number=20,
    )
    client = FakeLabelClient()

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert client.labels[("deftai/directive", 20)] == ["status:blocked"]


def test_resolved_dep_no_blocked(tmp_path: Path) -> None:
    # dep lives in completed/ -> resolved -> NOT blocked.
    _write_brief(tmp_path, "dep-a", folder="completed", issue_number=1)
    _write_brief(
        tmp_path,
        "child-b",
        folder="active",
        depends_on=["dep-a"],
        issue_number=21,
    )
    client = FakeLabelClient()

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert client.apply_calls == []
    assert ("deftai/directive", 21) not in client.labels


def test_epic_adds_epic_and_tracker(tmp_path: Path) -> None:
    _write_brief(tmp_path, "epic-x", folder="active", kind="epic", issue_number=30)
    client = FakeLabelClient()

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert client.labels[("deftai/directive", 30)] == ["epic", "status:tracker"]


def test_research_adds_rfc(tmp_path: Path) -> None:
    _write_brief(tmp_path, "rfc-y", folder="active", kind="research", issue_number=40)
    client = FakeLabelClient()

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert client.labels[("deftai/directive", 40)] == ["rfc"]


def test_removes_stale_managed_label(tmp_path: Path) -> None:
    # Issue currently carries status:blocked but the brief is no longer
    # blocked -> the stale managed label is removed.
    _write_brief(tmp_path, "ok", folder="active", status="running", issue_number=50)
    client = FakeLabelClient({("deftai/directive", 50): ["status:blocked"]})

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert ("deftai/directive", 50, [], ["status:blocked"]) in client.apply_calls
    assert client.labels[("deftai/directive", 50)] == []


def test_preserves_unmanaged_labels(tmp_path: Path) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=60)
    client = FakeLabelClient({("deftai/directive", 60): ["bug", "priority:high"]})

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert set(client.labels[("deftai/directive", 60)]) == {
        "bug",
        "priority:high",
        "status:blocked",
    }


def test_idempotent_second_run_noop(tmp_path: Path) -> None:
    _write_brief(tmp_path, "epic-x", folder="active", kind="epic", issue_number=70)
    client = FakeLabelClient()

    first_code, _ = mod.reconcile_labels(tmp_path, client=client)
    assert first_code == 0
    first_apply_count = len(client.apply_calls)
    assert first_apply_count == 1

    second_code, outcome = mod.reconcile_labels(tmp_path, client=client)
    assert second_code == 0
    # No further mutations on the second pass.
    assert len(client.apply_calls) == first_apply_count
    assert outcome.changed == []


def test_dry_run_makes_no_mutation(tmp_path: Path) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=80)
    client = FakeLabelClient()

    exit_code, outcome = mod.reconcile_labels(tmp_path, client=client, dry_run=True)

    assert exit_code == 0
    assert client.apply_calls == []
    assert outcome.dry_run is True
    assert any(c.issue_number == 80 for c in outcome.changed)


def test_brief_without_reference_skipped(tmp_path: Path) -> None:
    _write_brief(
        tmp_path,
        "noref",
        folder="active",
        status="blocked",
        with_reference=False,
    )
    client = FakeLabelClient()

    exit_code, outcome = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert client.apply_calls == []
    assert "noref" in outcome.skipped_no_ref


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def test_cli_missing_vbrief_dir_exit2(tmp_path: Path) -> None:
    result = _run_cli(tmp_path)
    assert result.returncode == 2, result.stdout + result.stderr


def test_cli_missing_vbrief_dir_json_exit2(tmp_path: Path) -> None:
    result = _run_cli(tmp_path, "--json")
    assert result.returncode == 2, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert "error" in payload


# ---------------------------------------------------------------------------
# ScmLabelClient (real forge client, scm.call monkeypatched -- no live gh)
# ---------------------------------------------------------------------------


def test_scm_client_fetch_labels_parses_dict_and_str(monkeypatch) -> None:
    def fake_call(source, verb, args, **kwargs):
        assert source == mod.SCM_SOURCE
        assert args[0] == "view"
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {"labels": [{"name": "bug"}, "rfc", {"no_name": 1}, 42]}
            ),
            stderr="",
        )

    monkeypatch.setattr(mod.scm, "call", fake_call)
    client = mod.ScmLabelClient()
    assert client.fetch_labels("deftai/directive", 5) == ["bug", "rfc"]


def test_scm_client_fetch_labels_nonzero_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="boom"),
    )
    client = mod.ScmLabelClient()
    with pytest.raises(mod.ScmLabelError, match="issue view"):
        client.fetch_labels("deftai/directive", 6)


def test_scm_client_fetch_labels_non_json_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout="not-json", stderr=""),
    )
    client = mod.ScmLabelClient()
    with pytest.raises(mod.ScmLabelError, match="non-JSON"):
        client.fetch_labels("deftai/directive", 7)


def test_scm_client_fetch_labels_non_list_returns_empty(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(
            returncode=0, stdout=json.dumps({"labels": "nope"}), stderr=""
        ),
    )
    client = mod.ScmLabelClient()
    assert client.fetch_labels("deftai/directive", 8) == []


def test_scm_client_apply_builds_args_and_succeeds(monkeypatch) -> None:
    captured: list[list[str]] = []

    def fake_call(source, verb, args, **kwargs):
        captured.append(list(args))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(mod.scm, "call", fake_call)
    client = mod.ScmLabelClient()
    client.apply("deftai/directive", 9, ["epic", "status:tracker"], ["rfc"])

    assert captured == [
        [
            "edit",
            "9",
            "--repo",
            "deftai/directive",
            "--add-label",
            "epic",
            "--add-label",
            "status:tracker",
            "--remove-label",
            "rfc",
        ]
    ]


def test_scm_client_apply_nonzero_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="denied"),
    )
    client = mod.ScmLabelClient()
    with pytest.raises(mod.ScmLabelError, match="issue edit"):
        client.apply("deftai/directive", 10, ["epic"], [])


# ---------------------------------------------------------------------------
# _render_report branch coverage
# ---------------------------------------------------------------------------


def test_render_report_all_sections() -> None:
    outcome = mod.ReconcileLabelsOutcome(dry_run=True)
    outcome.changed.append(
        mod.LabelChange(
            story_id="blk",
            repo="deftai/directive",
            issue_number=10,
            current=["bug"],
            desired=["status:blocked"],
            add=["status:blocked"],
            remove=["rfc"],
        )
    )
    outcome.unchanged.append(
        mod.LabelChange(
            story_id="ok",
            repo="deftai/directive",
            issue_number=11,
            current=["epic"],
            desired=["epic"],
            add=[],
            remove=[],
        )
    )
    outcome.skipped_no_ref.append("noref")
    outcome.errors.append(("bad", "issue view failed"))

    report = mod._render_report(outcome)
    assert "Changed (dry-run):" in report
    assert "+status:blocked" in report
    assert "-rfc" in report
    assert "#11 (deftai/directive) [ok]" in report
    assert "Skipped (no github-issue reference / repo):" in report
    assert "- noref" in report
    assert "Errors:" in report
    assert "- bad: issue view failed" in report


def test_render_report_empty_sections() -> None:
    report = mod._render_report(mod.ReconcileLabelsOutcome())
    assert "Changed:" in report
    assert "- none" in report
    assert "Unchanged:" in report


# ---------------------------------------------------------------------------
# main() in-process (covers parse_args + main + render, no live gh)
# ---------------------------------------------------------------------------


def _fake_scm_for_issue(state: dict[int, list[str]]):
    def _call(source, verb, args, **kwargs):
        if args and args[0] == "view":
            number = int(args[1])
            names = state.get(number, [])
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"labels": [{"name": n} for n in names]}),
                stderr="",
            )
        # edit
        number = int(args[1])
        current = set(state.get(number, []))
        i = 2
        while i < len(args):
            if args[i] == "--add-label":
                current.add(args[i + 1])
                i += 2
            elif args[i] == "--remove-label":
                current.discard(args[i + 1])
                i += 2
            else:
                i += 1
        state[number] = sorted(current)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return _call


def test_main_text_report_inprocess(tmp_path: Path, monkeypatch, capsys) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=100)
    state: dict[int, list[str]] = {}
    monkeypatch.setattr(mod.scm, "call", _fake_scm_for_issue(state))

    rc = mod.main(["--project-root", str(tmp_path)])

    assert rc == 0
    out = capsys.readouterr().out
    assert "vBRIEF reconcile labels" in out
    assert "+status:blocked" in out
    assert state[100] == ["status:blocked"]


def test_main_json_inprocess(tmp_path: Path, monkeypatch, capsys) -> None:
    _write_brief(tmp_path, "epic-x", folder="active", kind="epic", issue_number=101)
    state: dict[int, list[str]] = {}
    monkeypatch.setattr(mod.scm, "call", _fake_scm_for_issue(state))

    rc = mod.main(["--project-root", str(tmp_path), "--json"])

    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is False
    assert any(c["issue_number"] == 101 for c in payload["changed"])


def test_main_dry_run_inprocess(tmp_path: Path, monkeypatch, capsys) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=102)
    state: dict[int, list[str]] = {}
    monkeypatch.setattr(mod.scm, "call", _fake_scm_for_issue(state))

    rc = mod.main(["--project-root", str(tmp_path), "--dry-run"])

    assert rc == 0
    assert "(dry-run)" in capsys.readouterr().out
    # Dry-run mutates nothing.
    assert state == {}


def test_main_exit2_text_inprocess(tmp_path: Path, capsys) -> None:
    rc = mod.main(["--project-root", str(tmp_path)])
    assert rc == 2
    assert "no vbrief/ directory found" in capsys.readouterr().err


def test_main_exit2_json_inprocess(tmp_path: Path, capsys) -> None:
    rc = mod.main(["--project-root", str(tmp_path), "--json"])
    assert rc == 2
    assert "error" in json.loads(capsys.readouterr().out)


# ---------------------------------------------------------------------------
# reconcile_labels error / skip / dedup paths
# ---------------------------------------------------------------------------


class _RaisingClient:
    """Client whose fetch / apply raise ScmLabelError to drive the error arms."""

    def __init__(self, *, on_fetch: bool) -> None:
        self.on_fetch = on_fetch

    def fetch_labels(self, repo: str, issue_number: int) -> list[str]:
        if self.on_fetch:
            raise mod.ScmLabelError("issue view boom")
        return []

    def apply(self, repo, issue_number, add, remove) -> None:
        raise mod.ScmLabelError("issue edit boom")


def test_malformed_and_non_dict_briefs_skipped(tmp_path: Path) -> None:
    # Valid brief alongside a malformed-JSON file and a non-dict JSON file.
    _write_brief(tmp_path, "ok", folder="active", status="blocked", issue_number=200)
    active = tmp_path / "vbrief" / "active"
    (active / "2026-05-21-broken.vbrief.json").write_text("{not json", encoding="utf-8")
    (active / "2026-05-21-list.vbrief.json").write_text("[1, 2, 3]", encoding="utf-8")
    client = FakeLabelClient()

    exit_code, outcome = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    assert client.labels[("deftai/directive", 200)] == ["status:blocked"]


def test_duplicate_issue_ref_deduped(tmp_path: Path) -> None:
    _write_brief(tmp_path, "first", folder="active", status="blocked", issue_number=210)
    _write_brief(tmp_path, "second", folder="pending", status="blocked", issue_number=210)
    client = FakeLabelClient()

    exit_code, _ = mod.reconcile_labels(tmp_path, client=client)

    assert exit_code == 0
    # The shared issue is touched exactly once despite two briefs referencing it.
    assert len(client.apply_calls) == 1


def test_fetch_error_records_error_exit1(tmp_path: Path) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=220)

    exit_code, outcome = mod.reconcile_labels(
        tmp_path, client=_RaisingClient(on_fetch=True)
    )

    assert exit_code == 1
    assert outcome.errors and outcome.errors[0][0] == "blk"


def test_apply_error_records_error_exit1(tmp_path: Path) -> None:
    _write_brief(tmp_path, "blk", folder="active", status="blocked", issue_number=230)

    exit_code, outcome = mod.reconcile_labels(
        tmp_path, client=_RaisingClient(on_fetch=False)
    )

    assert exit_code == 1
    assert outcome.errors and outcome.errors[0][0] == "blk"
