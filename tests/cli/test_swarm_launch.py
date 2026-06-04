"""test_swarm_launch.py -- tests for scripts/swarm_launch.py (#1387).

Covers the four acceptance paths from the launch-engine vBRIEF:

- ``swarm-launch-cli-a1`` story resolution -- issue numbers resolve to their
  vbrief/active story file; unresolved / ambiguous ids exit non-zero.
- ``swarm-launch-cli-a2`` gate enforcement -- a story that fails the #810
  preflight or swarm:readiness gate fails with a non-zero exit naming the
  FIRST failing story.
- ``swarm-launch-cli-a3`` manifest shape -- the emitted JSON is the C2
  contract (story_id / vbrief_path / worktree_path / branch /
  allocation_context) with the #1378 five-field token, and consumes the C3
  worktree map via the injected ``resolve_worktree_map`` seam.
- ``swarm-launch-cli-a4`` autonomous mode -- ``--autonomous`` records a
  non-null batching rationale in each envelope.

The module is loaded via importlib (mirroring
tests/cli/test_swarm_verify_review_clean.py) so the gate seams
(``run_preflight_gate`` / ``run_readiness_gate``) and the guarded C3
resolver (``resolve_worktree_map``) can be patched on the loaded module
without shelling out to ``task`` or depending on the sibling story.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_module():
    scripts_dir = REPO_ROOT / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(
        "swarm_launch",
        scripts_dir / "swarm_launch.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["swarm_launch"] = module
    spec.loader.exec_module(module)
    return module


sl = _load_module()


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _write_story(
    active_dir: Path,
    filename: str,
    *,
    story_id: str,
    issues: list[int],
    title: str = "A story",
) -> Path:
    refs = [
        {
            "uri": f"https://github.com/deftai/directive/issues/{n}",
            "type": "x-vbrief/github-issue",
        }
        for n in issues
    ]
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {
            "id": story_id,
            "title": title,
            "status": "running",
            "references": refs,
            "items": [],
        },
    }
    path = active_dir / filename
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A project root with an empty ``vbrief/active`` directory."""
    (tmp_path / "vbrief" / "active").mkdir(parents=True)
    return tmp_path


@pytest.fixture
def gates_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub both gate seams to pass so manifest paths can be exercised."""
    monkeypatch.setattr(sl, "run_preflight_gate", lambda path: (0, "OK"))
    monkeypatch.setattr(sl, "run_readiness_gate", lambda path, root: (0, "OK"))


# ---------------------------------------------------------------------------
# a1 -- story resolution
# ---------------------------------------------------------------------------


class TestStoryResolution:
    def test_resolves_issue_number_to_active_file(self, project: Path) -> None:
        path = _write_story(
            project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[612]
        )
        resolved, errors = sl.resolve_stories(project, ["612"])
        assert errors == []
        assert len(resolved) == 1
        assert resolved[0].story_id == "sA"
        assert resolved[0].path == path

    def test_resolves_multiple_issue_numbers(self, project: Path) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[612])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[547])
        resolved, errors = sl.resolve_stories(project, ["612", "547"])
        assert errors == []
        assert [s.story_id for s in resolved] == ["sA", "sB"]

    def test_unresolved_issue_records_error(self, project: Path) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[612])
        resolved, errors = sl.resolve_stories(project, ["999"])
        assert resolved == []
        assert len(errors) == 1
        assert "999" in errors[0]

    def test_ambiguous_issue_records_error(self, project: Path) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[500])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[500])
        resolved, errors = sl.resolve_stories(project, ["500"])
        assert resolved == []
        assert "ambiguous" in errors[0]

    def test_resolves_explicit_path(self, project: Path) -> None:
        path = _write_story(
            project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[1]
        )
        resolved, errors = sl.resolve_stories(project, [str(path)])
        assert errors == []
        assert resolved[0].story_id == "sA"

    def test_resolves_by_story_id(self, project: Path) -> None:
        _write_story(
            project / "vbrief" / "active", "a.vbrief.json", story_id="my-story-id", issues=[1]
        )
        resolved, errors = sl.resolve_stories(project, ["my-story-id"])
        assert errors == []
        assert resolved[0].story_id == "my-story-id"

    def test_dedupes_same_story_via_two_tokens(self, project: Path) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[612])
        resolved, errors = sl.resolve_stories(project, ["612", "sA"])
        assert errors == []
        assert len(resolved) == 1

    def test_duplicate_story_id_records_error(self, project: Path) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="dup", issues=[101])
        _write_story(active, "b.vbrief.json", story_id="dup", issues=[202])
        resolved, errors = sl.resolve_stories(project, ["dup"])
        assert resolved == []
        assert "ambiguous" in errors[0]

    def test_numeric_token_not_misclassified_as_path(self) -> None:
        # A bare numeric issue token must not be treated as a path even if a
        # same-named file exists in CWD (only *.vbrief.json names qualify).
        assert sl._looks_like_path("100") is False
        assert sl._looks_like_path("a.vbrief.json") is True
        assert sl._looks_like_path("vbrief/active/x.json") is True

    def test_main_unresolved_exits_gate_failed(self, project: Path, capsys) -> None:
        rc = sl.main(["--stories", "999", "--project-root", str(project)])
        assert rc == sl.EXIT_GATE_FAILED
        assert "999" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# a2 -- gate enforcement / first-failing-story exit codes
# ---------------------------------------------------------------------------


class TestGateEnforcement:
    def test_preflight_failure_names_first_failing_story(
        self, project: Path, monkeypatch, capsys
    ) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])

        def fake_preflight(path: Path):
            return (1, "not active") if str(path).endswith("b.vbrief.json") else (0, "OK")

        monkeypatch.setattr(sl, "run_preflight_gate", fake_preflight)
        monkeypatch.setattr(sl, "run_readiness_gate", lambda path, root: (0, "OK"))
        rc = sl.main(["--stories", "100,200", "--project-root", str(project)])
        assert rc == sl.EXIT_GATE_FAILED
        err = capsys.readouterr().err
        assert "sB" in err
        assert "preflight" in err
        assert "sA" not in err

    def test_readiness_failure_names_story(self, project: Path, monkeypatch, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        monkeypatch.setattr(sl, "run_preflight_gate", lambda path: (0, "OK"))
        monkeypatch.setattr(sl, "run_readiness_gate", lambda path, root: (1, "blocked story"))
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_GATE_FAILED
        err = capsys.readouterr().err
        assert "sA" in err
        assert "readiness" in err

    def test_all_gates_pass_exits_ok(self, project: Path, gates_pass, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        payload = json.loads(capsys.readouterr().out)
        assert len(payload) == 1


# ---------------------------------------------------------------------------
# a3 -- manifest shape (C2) + #1378 token + C3 worktree map
# ---------------------------------------------------------------------------


class TestManifestShape:
    def test_manifest_object_has_c2_fields(self, project: Path, gates_pass, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        entry = json.loads(capsys.readouterr().out)[0]
        assert set(entry) == {
            "story_id",
            "vbrief_path",
            "worktree_path",
            "branch",
            "allocation_context",
        }
        assert entry["story_id"] == "sA"
        assert entry["vbrief_path"].endswith("a.vbrief.json")
        assert entry["branch"] == "swarm/sA"

    def test_allocation_context_has_1378_fields(self, project: Path, gates_pass, capsys) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        rc = sl.main(
            ["--stories", "100,200", "--group", "cohort-x", "--project-root", str(project)]
        )
        assert rc == sl.EXIT_OK
        manifest = json.loads(capsys.readouterr().out)
        ctx = manifest[0]["allocation_context"]
        assert set(ctx) == {
            "dispatch_kind",
            "allocation_plan_id",
            "batching_rationale",
            "cohort_vbriefs",
            "operator_approval_evidence",
        }
        assert ctx["dispatch_kind"] == "swarm-cohort"
        assert ctx["allocation_plan_id"] == "cohort-x"
        # cohort_vbriefs lists every member, on every envelope.
        assert len(ctx["cohort_vbriefs"]) == 2
        assert manifest[1]["allocation_context"]["cohort_vbriefs"] == ctx["cohort_vbriefs"]
        # branch derivation includes the group label.
        assert manifest[0]["branch"] == "swarm/cohort-x/sA"

    def test_solo_dispatch_kind_for_single_story_without_group(
        self, project: Path, gates_pass, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(["--stories", "100", "--project-root", str(project)])
        ctx = json.loads(capsys.readouterr().out)[0]["allocation_context"]
        assert ctx["dispatch_kind"] == "solo"

    def test_default_worktree_path_when_no_map(self, project: Path, gates_pass, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(["--stories", "100", "--project-root", str(project)])
        entry = json.loads(capsys.readouterr().out)[0]
        assert ".deft-scratch/worktrees/sA" in entry["worktree_path"]

    def test_worktree_map_consumed_via_injected_resolver(
        self, project: Path, gates_pass, monkeypatch, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        map_path = tmp_path / "wt-map.json"
        map_path.write_text(
            json.dumps([{"story_id": "sA", "worktree_path": "/wt/sA", "base_branch": "develop"}]),
            encoding="utf-8",
        )
        captured: dict = {}

        def fake_resolver(mapping, base_branch, create_missing=True):
            captured["mapping"] = mapping
            captured["base_branch"] = base_branch
            captured["create_missing"] = create_missing
            return mapping

        monkeypatch.setattr(sl, "resolve_worktree_map", fake_resolver)
        rc = sl.main(
            [
                "--stories",
                "100",
                "--worktree-map",
                str(map_path),
                "--base-branch",
                "develop",
                "--project-root",
                str(project),
            ]
        )
        assert rc == sl.EXIT_OK
        entry = json.loads(capsys.readouterr().out)[0]
        assert entry["worktree_path"] == "/wt/sA"
        assert captured["base_branch"] == "develop"
        assert captured["create_missing"] is True

    def test_no_create_worktrees_flag_forwarded(
        self, project: Path, gates_pass, monkeypatch, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        map_path = tmp_path / "wt-map.json"
        map_path.write_text(
            json.dumps([{"story_id": "sA", "worktree_path": "/wt/sA", "base_branch": "master"}]),
            encoding="utf-8",
        )
        captured: dict = {}

        def fake_resolver(mapping, base_branch, create_missing=True):
            captured["create_missing"] = create_missing
            return mapping

        monkeypatch.setattr(sl, "resolve_worktree_map", fake_resolver)
        sl.main(
            [
                "--stories",
                "100",
                "--worktree-map",
                str(map_path),
                "--no-create-worktrees",
                "--project-root",
                str(project),
            ]
        )
        assert captured["create_missing"] is False

    def test_worktree_map_without_resolver_exits_config_error(
        self, project: Path, gates_pass, monkeypatch, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        map_path = tmp_path / "wt-map.json"
        map_path.write_text(json.dumps([]), encoding="utf-8")
        monkeypatch.setattr(sl, "resolve_worktree_map", None)
        rc = sl.main(
            ["--stories", "100", "--worktree-map", str(map_path), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "resolver" in capsys.readouterr().err

    def test_worktree_map_resolver_raising_exits_config_error(
        self, project: Path, gates_pass, monkeypatch, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        map_path = tmp_path / "wt-map.json"
        map_path.write_text(json.dumps([{"story_id": "sA"}]), encoding="utf-8")

        def boom(mapping, base_branch, create_missing=True):
            raise ValueError("same-path collision")

        monkeypatch.setattr(sl, "resolve_worktree_map", boom)
        rc = sl.main(
            ["--stories", "100", "--worktree-map", str(map_path), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "collision" in capsys.readouterr().err

    def test_output_file_written(self, project: Path, gates_pass, capsys, tmp_path: Path) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        out_path = tmp_path / "manifest.json"
        rc = sl.main(
            ["--stories", "100", "--output", str(out_path), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_OK
        written = json.loads(out_path.read_text(encoding="utf-8"))
        assert written[0]["story_id"] == "sA"

    def test_output_write_failure_exits_config_error(
        self, project: Path, gates_pass, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        # --output points at an existing directory, so write_text raises OSError.
        out_dir = tmp_path / "manifest.json"
        out_dir.mkdir()
        rc = sl.main(["--stories", "100", "--output", str(out_dir), "--project-root", str(project)])
        assert rc == sl.EXIT_CONFIG_ERROR
        captured = capsys.readouterr()
        assert "could not write" in captured.err
        # Manifest must NOT have been emitted to stdout on write failure.
        assert captured.out.strip() == ""

    def test_worktree_map_duplicate_story_id_exits_config_error(
        self, project: Path, gates_pass, monkeypatch, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        map_path = tmp_path / "wt-map.json"
        map_path.write_text(json.dumps([{"story_id": "sA"}]), encoding="utf-8")

        def dup_resolver(mapping, base_branch, create_missing=True):
            return [
                {"story_id": "sA", "worktree_path": "/wt/a"},
                {"story_id": "sA", "worktree_path": "/wt/b"},
            ]

        monkeypatch.setattr(sl, "resolve_worktree_map", dup_resolver)
        rc = sl.main(
            ["--stories", "100", "--worktree-map", str(map_path), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "duplicate" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# a4 -- autonomous mode
# ---------------------------------------------------------------------------


class TestAutonomousMode:
    def test_autonomous_records_batching_rationale(self, project: Path, gates_pass, capsys) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        rc = sl.main(["--stories", "100,200", "--autonomous", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        manifest = json.loads(capsys.readouterr().out)
        for entry in manifest:
            rationale = entry["allocation_context"]["batching_rationale"]
            assert rationale is not None
            assert rationale.strip() != ""

    def test_non_autonomous_leaves_rationale_null(self, project: Path, gates_pass, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(["--stories", "100", "--project-root", str(project)])
        ctx = json.loads(capsys.readouterr().out)[0]["allocation_context"]
        assert ctx["batching_rationale"] is None

    def test_explicit_batching_rationale_honored(self, project: Path, gates_pass, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(
            [
                "--stories",
                "100",
                "--batching-rationale",
                "frozen contracts enable parallel build",
                "--project-root",
                str(project),
            ]
        )
        ctx = json.loads(capsys.readouterr().out)[0]["allocation_context"]
        assert ctx["batching_rationale"] == "frozen contracts enable parallel build"


# ---------------------------------------------------------------------------
# config errors
# ---------------------------------------------------------------------------


class TestConfigErrors:
    def test_no_stories_exits_config_error(self, project: Path, capsys) -> None:
        rc = sl.main(["--project-root", str(project)])
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "no stories" in capsys.readouterr().err.lower()

    def test_missing_active_dir_exits_config_error(self, tmp_path: Path, capsys) -> None:
        # tmp_path deliberately has no vbrief/active directory (the `project`
        # fixture is not used here) -- a wrong --project-root must surface a
        # clear config error, not a misleading "no active story" / traceback.
        rc = sl.main(["--stories", "100", "--project-root", str(tmp_path)])
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "vbrief/active" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Cohort-fill selection ordering (#1419 Slice 2 / #987)
# ---------------------------------------------------------------------------
#
# order_cohort applies the same RFC Layer-3 lexicographic key the triage
# queue uses (continuation > deficit > rank > date). The continuation /
# deficit signal sources (triage_queue.continuation_by_issue_number /
# bucket_deficit_by_issue_number) are stubbed so the test isolates the
# ordering logic from the capacity-engine / filesystem derivation that is
# covered by tests/cli/test_triage_queue.py.


class TestCohortOrdering:
    def test_continuation_orders_first(
        self, project: Path, gates_pass, monkeypatch, capsys
    ) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])  # net-new
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])  # continuation
        monkeypatch.setattr(
            sl.triage_queue, "continuation_by_issue_number", lambda root: {200: "epic"}
        )
        monkeypatch.setattr(sl.triage_queue, "bucket_deficit_by_issue_number", lambda root: {})
        rc = sl.main(["--stories", "100,200", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        manifest = json.loads(capsys.readouterr().out)
        assert [m["story_id"] for m in manifest] == ["sB", "sA"]

    def test_deficit_orders_most_under_target_first(
        self, project: Path, gates_pass, monkeypatch, capsys
    ) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        monkeypatch.setattr(sl.triage_queue, "continuation_by_issue_number", lambda root: {})
        monkeypatch.setattr(
            sl.triage_queue,
            "bucket_deficit_by_issue_number",
            lambda root: {100: 0.1, 200: 0.9},
        )
        rc = sl.main(["--stories", "100,200", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        manifest = json.loads(capsys.readouterr().out)
        assert [m["story_id"] for m in manifest] == ["sB", "sA"]

    def test_continuation_beats_deficit(
        self, project: Path, gates_pass, monkeypatch, capsys
    ) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])  # net-new, big deficit
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])  # continuation
        monkeypatch.setattr(
            sl.triage_queue, "continuation_by_issue_number", lambda root: {200: "epic"}
        )
        monkeypatch.setattr(
            sl.triage_queue, "bucket_deficit_by_issue_number", lambda root: {100: 0.9}
        )
        sl.main(["--stories", "100,200", "--project-root", str(project)])
        manifest = json.loads(capsys.readouterr().out)
        assert [m["story_id"] for m in manifest] == ["sB", "sA"]

    def test_neutral_orders_by_filename_proxy(
        self, project: Path, gates_pass, monkeypatch, capsys
    ) -> None:
        # No continuation / deficit signal -> the date_key (relpath) proxy
        # orders deterministically by date-prefixed filename, regardless of
        # the operator's input token order.
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        monkeypatch.setattr(sl.triage_queue, "continuation_by_issue_number", lambda root: {})
        monkeypatch.setattr(sl.triage_queue, "bucket_deficit_by_issue_number", lambda root: {})
        sl.main(["--stories", "200,100", "--project-root", str(project)])
        manifest = json.loads(capsys.readouterr().out)
        assert [m["story_id"] for m in manifest] == ["sA", "sB"]

    def test_cohort_vbriefs_reflects_ordering(
        self, project: Path, gates_pass, monkeypatch, capsys
    ) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        monkeypatch.setattr(
            sl.triage_queue, "continuation_by_issue_number", lambda root: {200: "epic"}
        )
        monkeypatch.setattr(sl.triage_queue, "bucket_deficit_by_issue_number", lambda root: {})
        sl.main(["--stories", "100,200", "--group", "cohort", "--project-root", str(project)])
        manifest = json.loads(capsys.readouterr().out)
        cohort = manifest[0]["allocation_context"]["cohort_vbriefs"]
        # cohort_vbriefs follows the post-ordering sequence (sB before sA).
        assert cohort[0].endswith("b.vbrief.json")
        assert cohort[1].endswith("a.vbrief.json")

    def test_order_cohort_without_triage_queue_preserves_order(
        self, project: Path, monkeypatch
    ) -> None:
        active = project / "vbrief" / "active"
        _write_story(active, "a.vbrief.json", story_id="sA", issues=[100])
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        resolved, errors = sl.resolve_stories(project, ["200", "100"])
        assert errors == []
        monkeypatch.setattr(sl, "triage_queue", None)
        ordered = sl.order_cohort(resolved, project)
        assert [s.story_id for s in ordered] == [s.story_id for s in resolved]
