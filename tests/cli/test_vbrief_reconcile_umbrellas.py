"""Acceptance tests for ``task vbrief:reconcile:umbrellas`` (#1289).

The umbrella reconciler walks every ``kind == "epic"`` vBRIEF, resolves
its children from its ``x-vbrief/plan`` references, computes the wave
structure, and edits the linked SCM umbrella's canonical *current-shape*
comment in place (AGENTS.md "Umbrella current-shape convention (#1152)").

These tests inject a fake comment client so the suite never makes a live
``gh`` call, and they import the module in-process so the body generator,
the scm-shim edit path, the idempotency no-op, dry-run, ``--json``, and
the three-state exit codes are all attributed to coverage (the #1284
cohort regressed master coverage by exercising new scripts via subprocess
only -- subprocess invocation is NOT attributed to coverage).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "vbrief_reconcile_umbrellas.py"

sys.path.insert(0, str(REPO_ROOT / "scripts"))

import vbrief_reconcile_umbrellas as mod  # noqa: E402

_STATUS_FOR_FOLDER = {
    "proposed": "proposed",
    "pending": "pending",
    "active": "running",
    "completed": "completed",
    "cancelled": "cancelled",
}

FIXED_NOW = "2026-06-14T20:00:00Z"


class FakeUmbrellaClient:
    """In-memory stand-in for the scm-backed comment client.

    ``comments`` maps ``(repo, issue_number)`` -> list of comment dicts
    (``{"id": int, "body": str}``). ``edit_comment`` / ``create_comment``
    mutate that state so a second reconcile run is a genuine no-op,
    exactly as the live forge would behave.
    """

    def __init__(
        self, comments: dict[tuple[str, int], list[dict]] | None = None
    ) -> None:
        self.comments: dict[tuple[str, int], list[dict]] = {
            key: [dict(c) for c in value] for key, value in (comments or {}).items()
        }
        self.edit_calls: list[tuple[str, int, str]] = []
        self.create_calls: list[tuple[str, int, str]] = []
        self._next_id = 1000

    def fetch_comments(self, repo: str, issue_number: int) -> list[dict]:
        return [dict(c) for c in self.comments.get((repo, issue_number), [])]

    def edit_comment(self, repo: str, comment_id: int, body: str) -> None:
        self.edit_calls.append((repo, comment_id, body))
        for bucket in self.comments.values():
            for comment in bucket:
                if comment["id"] == comment_id:
                    comment["body"] = body
                    return

    def create_comment(self, repo: str, issue_number: int, body: str) -> int | None:
        self.create_calls.append((repo, issue_number, body))
        new_id = self._next_id
        self._next_id += 1
        self.comments.setdefault((repo, issue_number), []).append(
            {"id": new_id, "body": body}
        )
        return new_id


def _write_brief(
    project: Path,
    story_id: str,
    *,
    folder: str = "active",
    kind: str = "story",
    title: str | None = None,
    depends_on: list[str] | None = None,
    references: list[dict] | None = None,
    issue_number: int | None = None,
    repo: str = "deftai/directive",
) -> Path:
    """Write a minimal but schema-plausible vBRIEF into *folder*."""
    path = project / "vbrief" / folder / f"2026-05-21-{story_id}.vbrief.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    refs = list(references or [])
    if issue_number is not None:
        refs.append(
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
            "title": title or story_id,
            "status": _STATUS_FOR_FOLDER[folder],
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
            "references": refs,
        },
    }
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _child_ref(child_id: str, folder: str, *, title: str | None = None) -> dict:
    return {
        "uri": f"{folder}/2026-05-21-{child_id}.vbrief.json",
        "type": "x-vbrief/plan",
        "title": title or child_id,
    }


def _write_epic(
    project: Path,
    epic_id: str,
    *,
    folder: str = "active",
    issue_number: int = 1284,
    child_refs: list[dict] | None = None,
    repo: str = "deftai/directive",
) -> Path:
    return _write_brief(
        project,
        epic_id,
        folder=folder,
        kind="epic",
        references=list(child_refs or []),
        issue_number=issue_number,
        repo=repo,
    )


def _run_cli(project: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--project-root", str(project), *extra],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


# ---------------------------------------------------------------------------
# Body render + parse unit coverage
# ---------------------------------------------------------------------------


def _child(story_id, *, kind="story", folder="active", title=None, deps=None):
    return mod.Child(
        story_id=story_id,
        title=title or story_id,
        kind=kind,
        folder=folder,
        depends_on=deps or [],
    )


def test_render_body_all_sections() -> None:
    body = mod.render_body(
        pass_n=2,
        last_pass_type="additive",
        last_updated=FIXED_NOW,
        open_children=[_child("b", title="Beta")],
        closed_children=[_child("a", folder="completed", title="Alpha")],
        waves=[["a"], ["b"]],
        history=[(1, 1), (2, 2)],
    )
    assert "## Current shape (as of pass-2)" in body
    assert f"Last updated: {FIXED_NOW}" in body
    assert "Last pass type: additive" in body
    assert "Child count: 2 (1/1)" in body
    assert "Child-count history: pass-1: 1, pass-2: 2" in body
    assert "- b: Beta (story)" in body
    assert "- a: Alpha (completed)" in body
    assert "- Wave 1: a" in body
    assert "- Wave 2: b" in body
    assert "### Open questions" in body
    assert "Read the umbrella issue body." in body


def test_render_body_empty_children() -> None:
    body = mod.render_body(
        pass_n=1,
        last_pass_type="additive",
        last_updated=FIXED_NOW,
        open_children=[],
        closed_children=[],
        waves=[],
        history=[(1, 0)],
    )
    assert "Child count: 0 (0/0)" in body
    # Each of Open / Closed / Wave sections renders the "- none" sentinel.
    assert body.count("- none") >= 3


def test_parse_current_shape_round_trips() -> None:
    body = mod.render_body(
        pass_n=3,
        last_pass_type="refactor",
        last_updated=FIXED_NOW,
        open_children=[_child("b")],
        closed_children=[_child("a", folder="cancelled")],
        waves=[["a", "b"]],
        history=[(1, 2), (2, 2), (3, 2)],
    )
    parsed = mod.parse_current_shape(body)
    assert parsed.pass_n == 3
    assert parsed.history == [(1, 2), (2, 2), (3, 2)]
    assert parsed.last_updated == FIXED_NOW
    assert parsed.last_pass_type == "refactor"


def test_parse_current_shape_no_header() -> None:
    parsed = mod.parse_current_shape("just an amendment comment, no header")
    assert parsed.pass_n is None
    assert parsed.history == []
    assert parsed.last_updated is None


def test_classify_pass_type() -> None:
    assert mod._classify_pass_type(None, 3) == "refactor"
    assert mod._classify_pass_type(2, 3) == "additive"
    assert mod._classify_pass_type(3, 2) == "subtractive"
    assert mod._classify_pass_type(2, 2) == "refactor"


def test_compute_waves_layers_and_cycle() -> None:
    children = [
        _child("a"),
        _child("b", deps=["a"]),
        _child("c", deps=["b"]),
        _child("d", deps=["external-not-in-set"]),
    ]
    waves = mod.compute_waves(children)
    assert waves[0] == ["a", "d"]  # d's only dep is outside the set -> wave 1
    assert waves[1] == ["b"]
    assert waves[2] == ["c"]

    # Cycle: x <-> y -> degrades to a single trailing wave, no hang.
    cyc = [_child("x", deps=["y"]), _child("y", deps=["x"])]
    cyc_waves = mod.compute_waves(cyc)
    assert cyc_waves == [["x", "y"]]


def test_compute_children_resolves_moved_child(tmp_path: Path) -> None:
    # Epic ref URI says pending/, but the child has since moved to active/.
    _write_brief(tmp_path, "child-a", folder="active")
    epic = _write_epic(
        tmp_path,
        "epic-x",
        child_refs=[_child_ref("child-a", "pending")],
    )
    index = mod.build_child_index(tmp_path / "vbrief")
    epic_data = json.loads(epic.read_text(encoding="utf-8"))
    children = mod.compute_children(epic_data, index)
    assert [c.story_id for c in children] == ["child-a"]
    assert children[0].folder == "active"


# ---------------------------------------------------------------------------
# reconcile_umbrellas end-to-end (injected client)
# ---------------------------------------------------------------------------


def test_creates_comment_when_absent(tmp_path: Path) -> None:
    _write_brief(tmp_path, "child-a", folder="active", title="Child A")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    client = FakeUmbrellaClient()

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now=FIXED_NOW
    )

    assert exit_code == 0
    assert len(client.create_calls) == 1
    assert outcome.changed and outcome.changed[0].action == "created"
    assert outcome.changed[0].pass_n == 1
    body = client.comments[("deftai/directive", 1284)][0]["body"]
    assert "## Current shape (as of pass-1)" in body
    assert "- child-a: Child A (story)" in body


def test_idempotent_second_run_noop(tmp_path: Path) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    client = FakeUmbrellaClient()

    first_code, _ = mod.reconcile_umbrellas(tmp_path, client=client, now=FIXED_NOW)
    assert first_code == 0
    assert len(client.create_calls) == 1

    # A different "now" must NOT trigger a re-stamp when nothing changed.
    second_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now="2026-12-31T23:59:59Z"
    )
    assert second_code == 0
    assert client.edit_calls == []
    assert len(client.create_calls) == 1
    assert outcome.unchanged and outcome.unchanged[0].action == "unchanged"
    assert outcome.changed == []


def test_child_added_bumps_pass_additive(tmp_path: Path) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    client = FakeUmbrellaClient()
    mod.reconcile_umbrellas(tmp_path, client=client, now=FIXED_NOW)

    # Add a second child to the epic and re-run.
    _write_brief(tmp_path, "child-b", folder="active")
    epic_path = tmp_path / "vbrief" / "active" / "2026-05-21-epic-x.vbrief.json"
    data = json.loads(epic_path.read_text(encoding="utf-8"))
    data["plan"]["references"].append(_child_ref("child-b", "active"))
    epic_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now="2026-07-01T00:00:00Z"
    )

    assert exit_code == 0
    assert len(client.edit_calls) == 1
    change = outcome.changed[0]
    assert change.action == "edited"
    assert change.pass_n == 2
    body = client.comments[("deftai/directive", 1284)][0]["body"]
    assert "## Current shape (as of pass-2)" in body
    assert "Last pass type: additive" in body
    assert "Child-count history: pass-1: 1, pass-2: 2" in body
    assert "Last updated: 2026-07-01T00:00:00Z" in body


def test_child_closed_bumps_pass_refactor(tmp_path: Path) -> None:
    # Two open children at pass-1; then one moves to completed/ -> total
    # unchanged, open/closed split changes -> refactor pass bump.
    _write_brief(tmp_path, "child-a", folder="active")
    _write_brief(tmp_path, "child-b", folder="active")
    _write_epic(
        tmp_path,
        "epic-x",
        child_refs=[_child_ref("child-a", "active"), _child_ref("child-b", "active")],
    )
    client = FakeUmbrellaClient()
    mod.reconcile_umbrellas(tmp_path, client=client, now=FIXED_NOW)

    # Move child-a from active/ to completed/.
    active = tmp_path / "vbrief" / "active" / "2026-05-21-child-a.vbrief.json"
    completed_dir = tmp_path / "vbrief" / "completed"
    completed_dir.mkdir(parents=True, exist_ok=True)
    active.rename(completed_dir / active.name)

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now="2026-07-01T00:00:00Z"
    )

    assert exit_code == 0
    change = outcome.changed[0]
    assert change.action == "edited"
    assert change.pass_n == 2
    body = client.comments[("deftai/directive", 1284)][0]["body"]
    assert "Last pass type: refactor" in body
    assert "Child count: 2 (1/1)" in body
    assert "- child-a: child-a (completed)" in body


def test_child_removed_bumps_pass_subtractive(tmp_path: Path) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_brief(tmp_path, "child-b", folder="active")
    _write_epic(
        tmp_path,
        "epic-x",
        child_refs=[_child_ref("child-a", "active"), _child_ref("child-b", "active")],
    )
    client = FakeUmbrellaClient()
    mod.reconcile_umbrellas(tmp_path, client=client, now=FIXED_NOW)

    # Drop child-b from the epic references.
    epic_path = tmp_path / "vbrief" / "active" / "2026-05-21-epic-x.vbrief.json"
    data = json.loads(epic_path.read_text(encoding="utf-8"))
    data["plan"]["references"] = [
        r for r in data["plan"]["references"] if "child-b" not in str(r.get("uri", ""))
    ]
    epic_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    _, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now="2026-07-01T00:00:00Z"
    )
    body = client.comments[("deftai/directive", 1284)][0]["body"]
    assert "Last pass type: subtractive" in body
    assert outcome.changed[0].pass_n == 2


def test_legacy_comment_without_header_treated_as_change(tmp_path: Path) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    # A current-shape comment exists but uses the header marker; a stray
    # amendment comment without the header must be ignored, and the real
    # current-shape comment edited.
    client = FakeUmbrellaClient(
        {
            ("deftai/directive", 1284): [
                {"id": 1, "body": "just an amendment, no header"},
                {"id": 2, "body": "## Current shape (as of pass-5)\n\n(stale hand body)"},
            ]
        }
    )

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now=FIXED_NOW
    )

    assert exit_code == 0
    # The pass-5 comment (id=2) is the one edited, bumped to pass-6.
    assert client.edit_calls and client.edit_calls[0][1] == 2
    assert outcome.changed[0].pass_n == 6


def test_dry_run_makes_no_mutation(tmp_path: Path) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    client = FakeUmbrellaClient()

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, dry_run=True, now=FIXED_NOW
    )

    assert exit_code == 0
    assert client.create_calls == []
    assert client.edit_calls == []
    assert outcome.dry_run is True
    assert outcome.changed and outcome.changed[0].action == "created"


def test_epic_without_issue_ref_skipped(tmp_path: Path) -> None:
    _write_brief(
        tmp_path, "epic-x", folder="active", kind="epic", references=[]
    )  # no github-issue ref
    client = FakeUmbrellaClient()

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now=FIXED_NOW
    )

    assert exit_code == 0
    assert "epic-x" in outcome.skipped_no_ref
    assert client.create_calls == []


def test_non_epic_briefs_ignored(tmp_path: Path) -> None:
    _write_brief(tmp_path, "story-a", folder="active", issue_number=10)
    client = FakeUmbrellaClient()

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=client, now=FIXED_NOW
    )

    assert exit_code == 0
    assert outcome.changed == []
    assert outcome.skipped_no_ref == []


def test_duplicate_issue_deduped(tmp_path: Path) -> None:
    _write_epic(tmp_path, "epic-x", folder="active", issue_number=99)
    _write_epic(tmp_path, "epic-y", folder="pending", issue_number=99)
    client = FakeUmbrellaClient()

    exit_code, _ = mod.reconcile_umbrellas(tmp_path, client=client, now=FIXED_NOW)

    assert exit_code == 0
    # The shared issue is touched exactly once despite two epics referencing it.
    assert len(client.create_calls) == 1


def test_repo_fallback_used(tmp_path: Path) -> None:
    # Reference URI lacks owner/repo -> --repo fallback resolves it.
    epic = _write_epic(tmp_path, "epic-x", folder="active", issue_number=7)
    data = json.loads(epic.read_text(encoding="utf-8"))
    for ref in data["plan"]["references"]:
        if ref["type"] == "x-vbrief/github-issue":
            ref["uri"] = "https://github.com/issues/7"  # no owner/repo
    epic.write_text(json.dumps(data, indent=2), encoding="utf-8")
    client = FakeUmbrellaClient()

    exit_code, _ = mod.reconcile_umbrellas(
        tmp_path, client=client, repo="acme/widgets", now=FIXED_NOW
    )

    assert exit_code == 0
    assert ("acme/widgets", 7) in client.comments


def test_malformed_brief_skipped(tmp_path: Path) -> None:
    _write_epic(tmp_path, "epic-x", folder="active", issue_number=11)
    active = tmp_path / "vbrief" / "active"
    (active / "2026-05-21-broken.vbrief.json").write_text("{not json", encoding="utf-8")
    (active / "2026-05-21-list.vbrief.json").write_text("[1, 2]", encoding="utf-8")
    client = FakeUmbrellaClient()

    exit_code, _ = mod.reconcile_umbrellas(tmp_path, client=client, now=FIXED_NOW)

    assert exit_code == 0
    assert ("deftai/directive", 11) in client.comments


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


class _RaisingClient:
    """Client whose fetch / create raise to drive the error arm."""

    def __init__(self, *, on_fetch: bool) -> None:
        self.on_fetch = on_fetch

    def fetch_comments(self, repo: str, issue_number: int) -> list[dict]:
        if self.on_fetch:
            raise mod.UmbrellaScmError("list comments boom")
        return []

    def edit_comment(self, repo: str, comment_id: int, body: str) -> None:
        raise mod.UmbrellaScmError("edit boom")

    def create_comment(self, repo: str, issue_number: int, body: str) -> int | None:
        raise mod.UmbrellaScmError("create boom")


def test_fetch_error_records_error_exit1(tmp_path: Path) -> None:
    _write_epic(tmp_path, "epic-x", folder="active", issue_number=12)

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=_RaisingClient(on_fetch=True), now=FIXED_NOW
    )

    assert exit_code == 1
    assert outcome.errors and outcome.errors[0][0] == "epic-x"


def test_create_error_records_error_exit1(tmp_path: Path) -> None:
    _write_epic(tmp_path, "epic-x", folder="active", issue_number=13)

    exit_code, outcome = mod.reconcile_umbrellas(
        tmp_path, client=_RaisingClient(on_fetch=False), now=FIXED_NOW
    )

    assert exit_code == 1
    assert outcome.errors and outcome.errors[0][0] == "epic-x"


def test_missing_vbrief_dir_exit2(tmp_path: Path) -> None:
    exit_code, outcome = mod.reconcile_umbrellas(tmp_path, client=FakeUmbrellaClient())
    assert exit_code == 2


# ---------------------------------------------------------------------------
# ScmUmbrellaClient (real forge client, scm.call monkeypatched -- no live gh)
# ---------------------------------------------------------------------------


def test_scm_client_fetch_comments_parses(monkeypatch) -> None:
    def fake_call(source, verb, args, **kwargs):
        assert source == mod.SCM_SOURCE
        assert verb == "api"
        assert "comments" in args[0]
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                [
                    {"id": 1, "body": "hello"},
                    {"id": "bad", "body": "x"},  # non-int id -> dropped
                    {"id": 2},  # no body -> dropped
                    {"id": 3, "body": "world"},
                ]
            ),
            stderr="",
        )

    monkeypatch.setattr(mod.scm, "call", fake_call)
    client = mod.ScmUmbrellaClient()
    comments = client.fetch_comments("deftai/directive", 5)
    assert comments == [{"id": 1, "body": "hello"}, {"id": 3, "body": "world"}]


def test_scm_client_fetch_comments_nonzero_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="boom"),
    )
    client = mod.ScmUmbrellaClient()
    with pytest.raises(mod.UmbrellaScmError, match="list comments"):
        client.fetch_comments("deftai/directive", 6)


def test_scm_client_fetch_comments_non_json_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout="not-json", stderr=""),
    )
    client = mod.ScmUmbrellaClient()
    with pytest.raises(mod.UmbrellaScmError, match="non-JSON"):
        client.fetch_comments("deftai/directive", 7)


def test_scm_client_fetch_comments_non_list_returns_empty(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(
            returncode=0, stdout=json.dumps({"not": "a list"}), stderr=""
        ),
    )
    client = mod.ScmUmbrellaClient()
    assert client.fetch_comments("deftai/directive", 8) == []


def test_scm_client_edit_comment_builds_args(monkeypatch) -> None:
    captured: dict = {}

    def fake_call(source, verb, args, **kwargs):
        captured["args"] = list(args)
        captured["input"] = kwargs.get("input")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(mod.scm, "call", fake_call)
    client = mod.ScmUmbrellaClient()
    client.edit_comment("deftai/directive", 42, "body text")

    assert captured["args"] == [
        "-X",
        "PATCH",
        "repos/deftai/directive/issues/comments/42",
        "--input",
        "-",
    ]
    assert json.loads(captured["input"]) == {"body": "body text"}


def test_scm_client_edit_comment_nonzero_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="denied"),
    )
    client = mod.ScmUmbrellaClient()
    with pytest.raises(mod.UmbrellaScmError, match="edit comment"):
        client.edit_comment("deftai/directive", 9, "x")


def test_scm_client_create_comment_returns_id(monkeypatch) -> None:
    def fake_call(source, verb, args, **kwargs):
        assert args[1] == "POST"
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({"id": 555}), stderr=""
        )

    monkeypatch.setattr(mod.scm, "call", fake_call)
    client = mod.ScmUmbrellaClient()
    assert client.create_comment("deftai/directive", 1, "body") == 555


def test_scm_client_create_comment_non_json_returns_none(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout="not-json", stderr=""),
    )
    client = mod.ScmUmbrellaClient()
    assert client.create_comment("deftai/directive", 1, "body") is None


def test_scm_client_create_comment_no_id_returns_none(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(
            returncode=0, stdout=json.dumps({"no": "id"}), stderr=""
        ),
    )
    client = mod.ScmUmbrellaClient()
    assert client.create_comment("deftai/directive", 1, "body") is None


def test_scm_client_create_comment_nonzero_raises(monkeypatch) -> None:
    monkeypatch.setattr(
        mod.scm,
        "call",
        lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="nope"),
    )
    client = mod.ScmUmbrellaClient()
    with pytest.raises(mod.UmbrellaScmError, match="create comment"):
        client.create_comment("deftai/directive", 1, "body")


# ---------------------------------------------------------------------------
# _render_report branch coverage
# ---------------------------------------------------------------------------


def test_render_report_all_sections() -> None:
    outcome = mod.ReconcileUmbrellasOutcome(dry_run=True)
    outcome.changed.append(
        mod.UmbrellaChange("epic-x", "deftai/directive", 10, "created", 1, "body")
    )
    outcome.unchanged.append(
        mod.UmbrellaChange("epic-y", "deftai/directive", 11, "unchanged", 3, "body")
    )
    outcome.skipped_no_ref.append("epic-z")
    outcome.errors.append(("epic-e", "list comments failed"))

    report = mod._render_report(outcome)
    assert "Changed (dry-run):" in report
    assert "#10 (deftai/directive) [epic-x]: created -> pass-1" in report
    assert "#11 (deftai/directive) [epic-y]: pass-3" in report
    assert "Skipped (no github-issue reference / repo):" in report
    assert "- epic-z" in report
    assert "Errors:" in report
    assert "- epic-e: list comments failed" in report


def test_render_report_empty_sections() -> None:
    report = mod._render_report(mod.ReconcileUmbrellasOutcome())
    assert "Changed:" in report
    assert "- none" in report
    assert "Unchanged:" in report


def test_change_to_json() -> None:
    change = mod.UmbrellaChange("epic-x", "deftai/directive", 10, "edited", 2, "body")
    payload = change.to_json()
    assert payload == {
        "story_id": "epic-x",
        "repo": "deftai/directive",
        "issue_number": 10,
        "action": "edited",
        "pass_n": 2,
    }
    assert "body" not in payload


# ---------------------------------------------------------------------------
# main() in-process (covers parse_args + main + render, no live gh)
# ---------------------------------------------------------------------------


def _fake_scm_comment_state(state: dict[tuple[str, int], list[dict]]):
    next_id = {"value": 2000}

    def _call(source, verb, args, **kwargs):
        path_or_flag = args[0]
        if path_or_flag.startswith("repos/") and "comments" in path_or_flag:
            # list comments: repos/{repo}/issues/{n}/comments?...
            segs = path_or_flag.split("?")[0].split("/")
            repo = f"{segs[1]}/{segs[2]}"
            number = int(segs[4])
            bucket = state.get((repo, number), [])
            return SimpleNamespace(
                returncode=0, stdout=json.dumps(bucket), stderr=""
            )
        # mutation: -X POST/PATCH ...
        method = args[1]
        target = args[2]
        body = json.loads(kwargs.get("input") or "{}").get("body", "")
        if method == "POST":
            segs = target.split("/")
            repo = f"{segs[1]}/{segs[2]}"
            number = int(segs[4])
            new_id = next_id["value"]
            next_id["value"] += 1
            state.setdefault((repo, number), []).append({"id": new_id, "body": body})
            return SimpleNamespace(
                returncode=0, stdout=json.dumps({"id": new_id}), stderr=""
            )
        # PATCH repos/{repo}/issues/comments/{id}
        comment_id = int(target.split("/")[-1])
        for bucket in state.values():
            for comment in bucket:
                if comment["id"] == comment_id:
                    comment["body"] = body
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return _call


def test_main_text_report_inprocess(tmp_path: Path, monkeypatch, capsys) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    state: dict[tuple[str, int], list[dict]] = {}
    monkeypatch.setattr(mod.scm, "call", _fake_scm_comment_state(state))

    rc = mod.main(["--project-root", str(tmp_path)])

    assert rc == 0
    out = capsys.readouterr().out
    assert "vBRIEF reconcile umbrellas" in out
    assert "created -> pass-1" in out
    assert state[("deftai/directive", 1284)]


def test_main_json_inprocess(tmp_path: Path, monkeypatch, capsys) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    state: dict[tuple[str, int], list[dict]] = {}
    monkeypatch.setattr(mod.scm, "call", _fake_scm_comment_state(state))

    rc = mod.main(["--project-root", str(tmp_path), "--json"])

    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["dry_run"] is False
    assert any(c["issue_number"] == 1284 for c in payload["changed"])


def test_main_dry_run_inprocess(tmp_path: Path, monkeypatch, capsys) -> None:
    _write_brief(tmp_path, "child-a", folder="active")
    _write_epic(tmp_path, "epic-x", child_refs=[_child_ref("child-a", "active")])
    state: dict[tuple[str, int], list[dict]] = {}
    monkeypatch.setattr(mod.scm, "call", _fake_scm_comment_state(state))

    rc = mod.main(["--project-root", str(tmp_path), "--dry-run"])

    assert rc == 0
    assert "(dry-run)" in capsys.readouterr().out
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
# CLI smoke (subprocess -- additive, not the only coverage)
# ---------------------------------------------------------------------------


def test_cli_missing_vbrief_dir_exit2(tmp_path: Path) -> None:
    result = _run_cli(tmp_path)
    assert result.returncode == 2, result.stdout + result.stderr


def test_cli_missing_vbrief_dir_json_exit2(tmp_path: Path) -> None:
    result = _run_cli(tmp_path, "--json")
    assert result.returncode == 2, result.stdout + result.stderr
    assert "error" in json.loads(result.stdout)
