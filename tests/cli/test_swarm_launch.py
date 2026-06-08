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
    file_scope: list[str] | None = None,
) -> Path:
    refs = [
        {
            "uri": f"https://github.com/deftai/directive/issues/{n}",
            "type": "x-vbrief/github-issue",
        }
        for n in issues
    ]
    plan: dict = {
        "id": story_id,
        "title": title,
        "status": "running",
        "references": refs,
        "items": [],
    }
    if file_scope is not None:
        plan["metadata"] = {"swarm": {"file_scope": file_scope}}
    payload = {"vBRIEFInfo": {"version": "0.6"}, "plan": plan}
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


def _write_project_def(project: Path, policy: dict) -> None:
    """Write a minimal PROJECT-DEFINITION with the given plan.policy block."""
    payload = {
        "vBRIEFInfo": {"version": "0.6"},
        "plan": {"policy": policy},
    }
    path = project / "vbrief" / "PROJECT-DEFINITION.vbrief.json"
    path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def backend_ready(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a valid, probe-available sub-agent backend policy (#1531e)."""
    _write_project_def(project, {"swarmSubagentBackend": "grok-build"})
    monkeypatch.setenv("DEFT_PROBE_GROK_BUILD", "yes")


@pytest.fixture
def launch_ready(gates_pass, backend_ready) -> None:
    """Gates pass and sub-agent backend policy is ready for manifest emission."""


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

    def test_all_gates_pass_exits_ok(self, project: Path, launch_ready, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        payload = json.loads(capsys.readouterr().out)
        assert len(payload) == 1


# ---------------------------------------------------------------------------
# a3 -- manifest shape (C2) + #1378 token + C3 worktree map
# ---------------------------------------------------------------------------


class TestManifestShape:
    def test_manifest_object_has_c2_fields(self, project: Path, launch_ready, capsys) -> None:
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
            "subagent_backend",
            "dispatch_provider",
            "worker_role",
        }
        assert entry["story_id"] == "sA"
        assert entry["vbrief_path"].endswith("a.vbrief.json")
        assert entry["branch"] == "swarm/sA"

    def test_allocation_context_has_1378_fields(self, project: Path, launch_ready, capsys) -> None:
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
        self, project: Path, launch_ready, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(["--stories", "100", "--project-root", str(project)])
        ctx = json.loads(capsys.readouterr().out)[0]["allocation_context"]
        assert ctx["dispatch_kind"] == "solo"

    def test_default_worktree_path_when_no_map(self, project: Path, launch_ready, capsys) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(["--stories", "100", "--project-root", str(project)])
        entry = json.loads(capsys.readouterr().out)[0]
        assert ".deft-scratch/worktrees/sA" in entry["worktree_path"]

    def test_worktree_map_consumed_via_injected_resolver(
        self, project: Path, launch_ready, monkeypatch, capsys, tmp_path: Path
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
        self, project: Path, launch_ready, monkeypatch, capsys, tmp_path: Path
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
        self, project: Path, launch_ready, monkeypatch, capsys, tmp_path: Path
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
        self, project: Path, launch_ready, monkeypatch, capsys, tmp_path: Path
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

    def test_output_file_written(self, project: Path, launch_ready, capsys, tmp_path: Path) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        out_path = tmp_path / "manifest.json"
        rc = sl.main(
            ["--stories", "100", "--output", str(out_path), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_OK
        written = json.loads(out_path.read_text(encoding="utf-8"))
        assert written[0]["story_id"] == "sA"

    def test_output_write_failure_exits_config_error(
        self, project: Path, launch_ready, capsys, tmp_path: Path
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
        self, project: Path, launch_ready, monkeypatch, capsys, tmp_path: Path
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
    def test_autonomous_records_batching_rationale(
        self, project: Path, launch_ready, capsys
    ) -> None:
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

    def test_non_autonomous_leaves_rationale_null(
        self, project: Path, launch_ready, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        sl.main(["--stories", "100", "--project-root", str(project)])
        ctx = json.loads(capsys.readouterr().out)[0]["allocation_context"]
        assert ctx["batching_rationale"] is None

    def test_explicit_batching_rationale_honored(self, project: Path, launch_ready, capsys) -> None:
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
        self, project: Path, launch_ready, monkeypatch, capsys
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
        self, project: Path, launch_ready, monkeypatch, capsys
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
        self, project: Path, launch_ready, monkeypatch, capsys
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
        self, project: Path, launch_ready, monkeypatch, capsys
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
        self, project: Path, launch_ready, monkeypatch, capsys
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


# ---------------------------------------------------------------------------
# #1419 Slice 7 -- gate-clearance integration (a2) + block-gated-solo
# ---------------------------------------------------------------------------
#
# A file_scope of ["AGENTS.md"] trips the default-on universal
# ``agents-md-and-skills`` mechanical/block judgment gate, so such a story is a
# block-gated story. These tests drive the enforce posture (--enforce-gates)
# since the framework default is advisory.

GATE_ID = "agents-md-and-skills"
GATE_SCOPE_PATH = "AGENTS.md"


def _engine():
    if sl._gates is None:  # pragma: no cover - engine ships with the repo
        pytest.skip("verify_judgment_gates engine not importable")
    return sl._gates


def _clearance_file(tmp_path: Path, project: Path, *, paths: list[str]) -> Path:
    """Write a --gate-clearances file whose cleared_scope matches the engine's."""
    engine = _engine()
    report = engine.build_report(
        project,
        engine.Candidate(paths=tuple(paths)),
        posture="enforce",
        clearances=[],
    )
    outcome = report.outcome_for(GATE_ID)
    assert outcome is not None
    clearance = {
        "gate_id": GATE_ID,
        "vbrief_path": "vbrief/active/a.vbrief.json",
        "cleared_by": "operator",
        "rationale": "reviewed AGENTS.md change",
        "cleared_at": "2026-06-04T00:00:00Z",
        "cleared_scope": outcome.cleared_scope,
    }
    path = tmp_path / "clearances.json"
    path.write_text(json.dumps([clearance]), encoding="utf-8")
    return path


class TestGateClearanceEnforcement:
    def test_enforce_uncleared_block_gate_aborts(
        self, project: Path, launch_ready, capsys
    ) -> None:
        _engine()
        _write_story(
            project / "vbrief" / "active", "a.vbrief.json",
            story_id="sA", issues=[100], file_scope=[GATE_SCOPE_PATH],
        )
        rc = sl.main(
            ["--stories", "100", "--enforce-gates", "--project-root", str(project)]
        )
        assert rc == sl.EXIT_GATE_FAILED
        err = capsys.readouterr().err
        assert "sA" in err
        assert "block-gated" in err

    def test_enforce_cleared_block_gate_launches(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        """a2: a recorded clearance permits the gated (solo) story to launch."""
        _write_story(
            project / "vbrief" / "active", "a.vbrief.json",
            story_id="sA", issues=[100], file_scope=[GATE_SCOPE_PATH],
        )
        clearances = _clearance_file(tmp_path, project, paths=[GATE_SCOPE_PATH])
        rc = sl.main(
            [
                "--stories", "100",
                "--enforce-gates",
                "--gate-clearances", str(clearances),
                "--project-root", str(project),
            ]
        )
        assert rc == sl.EXIT_OK
        manifest = json.loads(capsys.readouterr().out)
        assert [m["story_id"] for m in manifest] == ["sA"]

    def test_advise_default_launches_uncleared_gated_story(
        self, project: Path, launch_ready, capsys
    ) -> None:
        """Advisory default surfaces the uncleared block gate but still launches."""
        _engine()
        _write_story(
            project / "vbrief" / "active", "a.vbrief.json",
            story_id="sA", issues=[100], file_scope=[GATE_SCOPE_PATH],
        )
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        captured = capsys.readouterr()
        assert len(json.loads(captured.out)) == 1
        assert "advisory" in captured.err.lower()

    def test_enforce_block_gated_story_in_cohort_must_ship_solo(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        """A cleared block-gated story still cannot ride a multi-story cohort (v1)."""
        active = project / "vbrief" / "active"
        _write_story(
            active, "a.vbrief.json", story_id="sA", issues=[100],
            file_scope=[GATE_SCOPE_PATH],
        )
        _write_story(active, "b.vbrief.json", story_id="sB", issues=[200])
        clearances = _clearance_file(tmp_path, project, paths=[GATE_SCOPE_PATH])
        rc = sl.main(
            [
                "--stories", "100,200",
                "--enforce-gates",
                "--gate-clearances", str(clearances),
                "--project-root", str(project),
            ]
        )
        assert rc == sl.EXIT_GATE_FAILED
        assert "solo" in capsys.readouterr().err.lower()

    def test_envelope_carries_gate_clearances(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        """The consent token gains a gate_clearances field when clearances are supplied."""
        _write_story(
            project / "vbrief" / "active", "a.vbrief.json",
            story_id="sA", issues=[100], file_scope=[GATE_SCOPE_PATH],
        )
        clearances = _clearance_file(tmp_path, project, paths=[GATE_SCOPE_PATH])
        sl.main(
            [
                "--stories", "100",
                "--gate-clearances", str(clearances),
                "--project-root", str(project),
            ]
        )
        ctx = json.loads(capsys.readouterr().out)[0]["allocation_context"]
        assert "gate_clearances" in ctx
        assert ctx["gate_clearances"][0]["gate_id"] == GATE_ID

    def test_malformed_gate_clearances_file_exits_config_error(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        bad = tmp_path / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        rc = sl.main(
            ["--stories", "100", "--gate-clearances", str(bad), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "gate-clearances" in capsys.readouterr().err

    def test_non_array_gate_clearances_file_exits_config_error(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        bad = tmp_path / "obj.json"
        bad.write_text(json.dumps({"gate_id": "x"}), encoding="utf-8")
        rc = sl.main(
            ["--stories", "100", "--gate-clearances", str(bad), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_CONFIG_ERROR
        assert "array" in capsys.readouterr().err.lower()


# ---------------------------------------------------------------------------
# #1419 Slice 7 -- durable authority-event audit log (a3)
# ---------------------------------------------------------------------------


class TestAuthorityAudit:
    def _audit_records(self, project: Path) -> list[dict]:
        log = project / "vbrief" / ".audit" / sl.AUTHORITY_LOG_NAME
        if not log.is_file():
            return []
        return [
            json.loads(line)
            for line in log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_successful_launch_appends_allocation_approved(
        self, project: Path, launch_ready, capsys
    ) -> None:
        """a3: a successful launch appends an allocation:approved authority event."""
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        records = self._audit_records(project)
        assert any(r["event_type"] == "allocation:approved" for r in records)
        approval = next(r for r in records if r["event_type"] == "allocation:approved")
        assert approval["cohort_vbriefs"]
        assert "event_id" in approval and "timestamp" in approval

    def test_consumed_clearance_appends_gate_cleared(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        _write_story(
            project / "vbrief" / "active", "a.vbrief.json",
            story_id="sA", issues=[100], file_scope=[GATE_SCOPE_PATH],
        )
        clearances = _clearance_file(tmp_path, project, paths=[GATE_SCOPE_PATH])
        rc = sl.main(
            [
                "--stories", "100",
                "--gate-clearances", str(clearances),
                "--project-root", str(project),
            ]
        )
        assert rc == sl.EXIT_OK
        records = self._audit_records(project)
        cleared = [r for r in records if r["event_type"] == "gate:cleared"]
        assert len(cleared) == 1
        assert cleared[0]["gate_id"] == GATE_ID

    def test_no_audit_flag_suppresses_audit(
        self, project: Path, launch_ready, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--no-audit", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        assert self._audit_records(project) == []

    def test_unconsumed_clearance_is_not_logged(
        self, project: Path, launch_ready, capsys, tmp_path: Path
    ) -> None:
        """A supplied clearance whose gate never matched is NOT recorded as consumed.

        The story has no file_scope, so no judgment gate matches and the
        clearance is never consumed -- only the allocation:approved event is
        written, never a (false) gate:cleared event.
        """
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        cf = tmp_path / "clearances.json"
        cf.write_text(
            json.dumps([{"gate_id": GATE_ID, "cleared_scope": "deadbeef"}]),
            encoding="utf-8",
        )
        rc = sl.main(
            ["--stories", "100", "--gate-clearances", str(cf), "--project-root", str(project)]
        )
        assert rc == sl.EXIT_OK
        records = self._audit_records(project)
        assert any(r["event_type"] == "allocation:approved" for r in records)
        assert not any(r["event_type"] == "gate:cleared" for r in records)


# ---------------------------------------------------------------------------
# #1531e -- sub-agent backend policy enforcement
# ---------------------------------------------------------------------------


class TestSubagentBackendPolicy:
    def test_missing_policy_exits_before_manifest(
        self, project: Path, gates_pass, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_GATE_FAILED
        captured = capsys.readouterr()
        assert captured.out.strip() == ""
        err = captured.err
        assert "Select a coding sub-agent backend" in err
        assert "composer" in err
        assert "grok-build" in err
        assert "task policy:subagent-backend" in err

    def test_unavailable_backend_lists_alternatives(
        self, project: Path, gates_pass, capsys, monkeypatch
    ) -> None:
        _write_project_def(project, {"swarmSubagentBackend": "composer"})
        monkeypatch.delenv("DEFT_PROBE_COMPOSER", raising=False)
        monkeypatch.setenv("DEFT_PROBE_GROK_BUILD", "yes")
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_GATE_FAILED
        err = capsys.readouterr().err
        assert "composer" in err
        assert "unavailable" in err
        assert "grok-build" in err
        assert "task policy:subagent-backend" in err

    def test_available_backend_adds_audit_metadata(
        self, project: Path, launch_ready, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_OK
        entry = json.loads(capsys.readouterr().out)[0]
        assert entry["subagent_backend"] == "grok-build"
        assert entry["dispatch_provider"] == "grok"
        assert entry["worker_role"] == sl.LEAF_CODING_WORKER_ROLE
        ctx = entry["allocation_context"]
        assert set(ctx) == {
            "dispatch_kind",
            "allocation_plan_id",
            "batching_rationale",
            "cohort_vbriefs",
            "operator_approval_evidence",
        }

    def test_autonomous_missing_policy_fails_non_interactively(
        self, project: Path, gates_pass, capsys
    ) -> None:
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(
            ["--stories", "100", "--autonomous", "--project-root", str(project)]
        )
        assert rc == sl.EXIT_GATE_FAILED
        assert capsys.readouterr().out.strip() == ""

    def test_autonomous_unavailable_backend_fails_non_interactively(
        self, project: Path, gates_pass, capsys, monkeypatch
    ) -> None:
        _write_project_def(project, {"swarmSubagentBackend": "cursor-cloud"})
        monkeypatch.delenv("DEFT_PROBE_CURSOR_CLOUD", raising=False)
        monkeypatch.delenv("CURSOR_AGENT", raising=False)
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(
            ["--stories", "100", "--autonomous", "--project-root", str(project)]
        )
        assert rc == sl.EXIT_GATE_FAILED
        err = capsys.readouterr().err
        assert "cursor-cloud" in err
        assert "task policy:subagent-backend" in err

    def test_backend_without_leaf_role_fails(
        self, project: Path, gates_pass, capsys, monkeypatch
    ) -> None:
        fake_result = type(
            "Result",
            (),
            {"backend_id": "review-only", "source": "typed", "error": None},
        )()
        monkeypatch.setattr(
            sl, "resolve_swarm_subagent_backend", lambda root: fake_result
        )
        monkeypatch.setattr(
            sl,
            "probe_subagent_backends",
            lambda: [
                type(
                    "Desc",
                    (),
                    {
                        "backend_id": "review-only",
                        "display_name": "Review only",
                        "roles": ("review-monitor",),
                        "available": True,
                    },
                )()
            ],
        )
        _write_story(project / "vbrief" / "active", "a.vbrief.json", story_id="sA", issues=[100])
        rc = sl.main(["--stories", "100", "--project-root", str(project)])
        assert rc == sl.EXIT_GATE_FAILED
        err = capsys.readouterr().err
        assert "leaf-implementation" in err
        assert "review-only" in err
