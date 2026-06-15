from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "swarm_readiness.py"

sys.path.insert(0, str(REPO_ROOT / "scripts"))

import swarm_readiness as mod  # noqa: E402


def _write_json(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def _story(
    project: Path,
    story_id: str,
    *,
    file_scope: list[str] | None = None,
    verify_commands: list[str] | None = None,
    acceptance: str | list[str] | None = None,
    depends_on: list[str] | None = None,
    size: str = "small",
    confidence: str = "high",
    parallel_safe: bool = True,
    readiness: str = "ready",
) -> Path:
    acceptance_values = (
        [
            f"Given {story_id} input, when the story runs, then it returns a scoped result.",
            f"Given {story_id} failure input, when the story runs, then it rejects the request.",
        ]
        if acceptance is None
        else ([acceptance] if isinstance(acceptance, str) else acceptance)
    )
    return _write_json(
        project / "vbrief" / "active" / f"2026-05-12-{story_id}.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": story_id,
                "title": story_id,
                "status": "running",
                "narratives": {
                    "Description": (
                        f"{story_id} implements a focused product behavior for the active "
                        "workflow. The story stays within a narrow code path and includes "
                        "targeted tests for success and failure behavior."
                    ),
                    "ImplementationPlan": (
                        f"1. Update the {story_id} source path to implement the focused "
                        "workflow behavior.\n"
                        f"2. Add targeted tests for {story_id} success and failure outcomes."
                    ),
                    "Traces": "FR-1",
                    "UserStory": (
                        f"As a product user, I want {story_id} behavior, "
                        "so that I can complete the workflow."
                    ),
                },
                "items": [
                    {
                        "id": f"{story_id}-a{index}",
                        "title": f"Acceptance item {index}",
                        "status": "pending",
                        "narrative": {"Acceptance": criterion, "Traces": "FR-1"},
                    }
                    for index, criterion in enumerate(acceptance_values, start=1)
                ],
                "metadata": {
                    "kind": "story",
                    "swarm": {
                        "readiness": readiness,
                        "parallel_safe": parallel_safe,
                        "file_scope": [f"src/{story_id}.ts"] if file_scope is None else file_scope,
                        "verify_commands": (
                            [f"npm test -- {story_id}"]
                            if verify_commands is None
                            else verify_commands
                        ),
                        "expected_outputs": ["focused tests pass"],
                        "depends_on": depends_on or [],
                        "conflict_group": "auth",
                        "size": size,
                        "file_scope_confidence": confidence,
                        "model_tier": "medium",
                    },
                },
            },
        },
    )


def _run(project: Path, *paths: Path) -> subprocess.CompletedProcess[str]:
    args = [str(path.relative_to(project)) for path in paths]
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args, "--project-root", str(project)],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


def test_readiness_passes_for_ready_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-ready")

    result = _run(tmp_path, story)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Ready stories:" in result.stdout
    assert "story-ready" in result.stdout
    assert "Blocked stories:\n- none" in result.stdout


def test_readiness_fails_missing_acceptance_file_scope_and_verify_commands(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-missing", file_scope=[], verify_commands=[], acceptance="")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "plan.items[].narrative.Acceptance" in result.stdout
    assert "plan.metadata.swarm.file_scope" in result.stdout
    assert "plan.metadata.swarm.verify_commands" in result.stdout


def test_readiness_fails_missing_required_swarm_metadata(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-missing-swarm-metadata")
    data = json.loads(story.read_text(encoding="utf-8"))
    swarm = data["plan"]["metadata"]["swarm"]
    for key in (
        "expected_outputs",
        "depends_on",
        "conflict_group",
        "size",
        "file_scope_confidence",
        "model_tier",
    ):
        del swarm[key]
    story.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "plan.metadata.swarm.expected_outputs" in result.stdout
    assert "plan.metadata.swarm.depends_on" in result.stdout
    assert "plan.metadata.swarm.conflict_group" in result.stdout
    assert "plan.metadata.swarm.size" in result.stdout
    assert "plan.metadata.swarm.file_scope_confidence" in result.stdout
    assert "plan.metadata.swarm.model_tier" in result.stdout


def test_readiness_requires_explicit_story_kind(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-missing-kind")
    data = json.loads(story.read_text(encoding="utf-8"))
    del data["plan"]["metadata"]["kind"]
    story.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "plan.metadata.kind=story" in result.stdout


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (
            lambda data: data["plan"]["narratives"].update({"UserStory": "Build auth."}),
            "UserStory must match",
        ),
        (
            lambda data: data["plan"]["narratives"].update(
                {"Description": "Implement the behavior."}
            ),
            "plan.narratives.Description must contain at least two concrete sentences",
        ),
        (
            lambda data: data["plan"]["narratives"].update(
                {"ImplementationPlan": "Change the code."}
            ),
            "plan.narratives.ImplementationPlan must contain at least two concrete steps",
        ),
        (
            lambda data: data["plan"]["narratives"].update(
                {
                    "ImplementationPlan": (
                        "1. Update the code so the feature is implemented in the application.\n"
                        "2. Add tests so it works as expected for users."
                    )
                }
            ),
            "plan.narratives.ImplementationPlan must identify concrete code paths",
        ),
        (
            lambda data: data["plan"]["items"][0]["narrative"].update(
                {"Acceptance": "to refine from parent scope"}
            ),
            "placeholder acceptance criterion",
        ),
        (
            lambda data: data["plan"]["items"][0]["narrative"].update(
                {"Acceptance": data["plan"]["title"]}
            ),
            "acceptance criterion duplicates title or description",
        ),
        (
            lambda data: data["plan"]["items"][0]["narrative"].update(
                {"Acceptance": "The system displays a message"}
            ),
            "acceptance criterion must describe specific observable behavior",
        ),
        (
            lambda data: data["plan"]["metadata"]["swarm"].update({"file_scope": ["frontend/**"]}),
            "broad file_scope is not swarm-ready",
        ),
        (
            lambda data: data["plan"]["metadata"]["swarm"].update({"file_scope": ["src/*.ts"]}),
            "broad file_scope is not swarm-ready",
        ),
        (
            lambda data: data["plan"]["metadata"]["swarm"].update(
                {"verify_commands": ["task check"]}
            ),
            "generic verify command is not swarm-ready",
        ),
    ],
)
def test_readiness_rejects_low_quality_ready_story(tmp_path: Path, mutate, expected: str) -> None:
    story = _story(tmp_path, "story-low-quality")
    data = json.loads(story.read_text(encoding="utf-8"))
    mutate(data)
    story.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert expected in result.stdout


def test_readiness_rejects_deprecated_subitems_in_story_items(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-subitems")
    data = json.loads(story.read_text(encoding="utf-8"))
    data["plan"]["items"][0]["subItems"] = []
    story.write_text(json.dumps(data, indent=2), encoding="utf-8")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "subItems is deprecated; use items" in result.stdout


def test_readiness_reports_epic_phase_as_decomposition_needed(tmp_path: Path) -> None:
    phase = _write_json(
        tmp_path / "vbrief" / "active" / "2026-05-12-ip001-auth.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": "ip-1",
                "title": "IP-1: Auth",
                "status": "running",
                "narratives": {"Acceptance": "Broad epic acceptance", "Traces": "FR-1"},
                "items": [],
                "metadata": {"kind": "phase"},
            },
        },
    )

    result = _run(tmp_path, phase)

    assert result.returncode == 1
    assert "Decomposition-needed epics/phases:" in result.stdout
    assert "kind=phase" in result.stdout


def test_readiness_detects_unsafe_file_overlap(tmp_path: Path) -> None:
    left = _story(tmp_path, "story-left", file_scope=["src/shared.ts"])
    right = _story(tmp_path, "story-right", file_scope=["src/shared.ts"])

    result = _run(tmp_path, left, right)

    assert result.returncode == 1
    assert "File overlap matrix:" in result.stdout
    assert "src/shared.ts" in result.stdout
    assert "story-left" in result.stdout
    assert "story-right" in result.stdout


def test_readiness_rejects_large_parallel_safe_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-large", size="large")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "size=large cannot be parallel_safe=true" in result.stdout


def test_readiness_rejects_ready_parallel_safe_false_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-sequential", parallel_safe=False)

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "Blocked stories:" in result.stdout
    assert "story-sequential" in result.stdout
    assert "readiness=ready requires parallel_safe=true" in result.stdout
    assert "Sequential stories:" not in result.stdout


def test_readiness_does_not_apply_ready_only_checks_to_sequential_story(
    tmp_path: Path,
) -> None:
    story = _story(
        tmp_path,
        "story-sequential",
        parallel_safe=False,
        readiness="sequential",
    )

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "plan.metadata.swarm.readiness=ready for concurrent allocation" in result.stdout
    assert "readiness=ready requires parallel_safe=true" not in result.stdout


def test_readiness_rejects_low_confidence_parallel_safe_story(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-low-confidence", confidence="low")

    result = _run(tmp_path, story)

    assert result.returncode == 1
    assert "readiness=ready requires file_scope_confidence above low" in result.stdout


def test_readiness_cycle_report_excludes_upstream_non_cycle_node(tmp_path: Path) -> None:
    upstream = _story(tmp_path, "story-upstream", depends_on=["story-cycle-a"])
    cycle_a = _story(tmp_path, "story-cycle-a", depends_on=["story-cycle-b"])
    cycle_b = _story(tmp_path, "story-cycle-b", depends_on=["story-cycle-a"])

    result = _run(tmp_path, upstream, cycle_a, cycle_b)

    assert result.returncode == 1
    assert "dependency cycle: story-cycle-a -> story-cycle-b -> story-cycle-a" in result.stdout
    assert "dependency cycle: story-upstream" not in result.stdout
    assert (
        "story-upstream: story-upstream -- dependency 'story-cycle-a' is blocked"
        in result.stdout
    )
    ready_section = result.stdout.split("Ready stories:", 1)[1].split("\n\n", 1)[0]
    waves_section = result.stdout.split("Dependency waves:", 1)[1].split("\n\n", 1)[0]
    assert "story-upstream" not in ready_section
    assert "story-upstream" not in waves_section


# ---------------------------------------------------------------------------
# In-process coverage: readiness_report / _render_report / main / _expand_paths
# (the subprocess tests above exercise behaviour but are not attributed to
# coverage; these call the module directly so the gate sees real coverage.)
# ---------------------------------------------------------------------------


def test_inproc_ready_story_passes(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-ready")

    code, report = mod.readiness_report(tmp_path, [story])

    assert code == 0
    assert "Ready stories:" in report
    assert "story-ready" in report
    assert "Conflict groups:" in report
    assert "auth: story-ready" in report


def test_inproc_blocked_story_fails(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-missing", file_scope=[], verify_commands=[], acceptance="")

    code, report = mod.readiness_report(tmp_path, [story])

    assert code == 1
    assert "Blocked stories:" in report
    assert "Missing fields:" in report
    assert "plan.metadata.swarm.file_scope" in report


def test_inproc_epic_decomposition_needed(tmp_path: Path) -> None:
    phase = _write_json(
        tmp_path / "vbrief" / "active" / "2026-05-12-ip001.vbrief.json",
        {
            "vBRIEFInfo": {"version": "0.6"},
            "plan": {
                "id": "ip-1",
                "title": "IP-1: Auth",
                "status": "running",
                "narratives": {"Acceptance": "Broad epic acceptance", "Traces": "FR-1"},
                "items": [],
                "metadata": {"kind": "phase"},
            },
        },
    )

    code, report = mod.readiness_report(tmp_path, [phase])

    assert code == 1
    assert "Decomposition-needed epics/phases:" in report
    assert "kind=phase" in report


def test_inproc_file_overlap_detected(tmp_path: Path) -> None:
    left = _story(tmp_path, "story-left", file_scope=["src/shared.ts"])
    right = _story(tmp_path, "story-right", file_scope=["src/shared.ts"])

    code, report = mod.readiness_report(tmp_path, [left, right])

    assert code == 1
    assert "File overlap matrix:" in report
    assert "src/shared.ts" in report


def test_inproc_dependency_waves_ordered(tmp_path: Path) -> None:
    base = _story(tmp_path, "story-base", file_scope=["src/base.ts"])
    follow = _story(
        tmp_path, "story-follow", file_scope=["src/follow.ts"], depends_on=["story-base"]
    )

    code, report = mod.readiness_report(tmp_path, [base, follow])

    assert code == 0
    waves = report.split("Dependency waves:", 1)[1]
    assert "wave 1: story-base" in waves
    assert "wave 2: story-follow" in waves


def test_inproc_no_candidates(tmp_path: Path) -> None:
    code, report = mod.readiness_report(tmp_path, [])
    assert code == 1
    assert "No candidate vBRIEFs found." in report


def test_inproc_main_default_glob(tmp_path: Path, capsys) -> None:
    # A ready story in the default vbrief/active/ glob; main() with no path
    # args must discover it via _expand_paths' default pattern.
    _story(tmp_path, "story-default")

    rc = mod.main(["--project-root", str(tmp_path)])

    assert rc == 0
    out = capsys.readouterr().out
    assert "Ready stories:" in out
    assert "story-default" in out


def test_inproc_main_explicit_path_blocked(tmp_path: Path, capsys) -> None:
    story = _story(tmp_path, "story-large", size="large")

    rc = mod.main([str(story), "--project-root", str(tmp_path)])

    assert rc == 1
    assert "size=large cannot be parallel_safe=true" in capsys.readouterr().out


def test_inproc_main_no_candidates_exit1(tmp_path: Path, capsys) -> None:
    (tmp_path / "vbrief" / "active").mkdir(parents=True)
    rc = mod.main(["--project-root", str(tmp_path)])
    assert rc == 1
    assert "No candidate vBRIEFs found." in capsys.readouterr().out


def test_inproc_cycle_marks_blocked(tmp_path: Path) -> None:
    cycle_a = _story(tmp_path, "story-cycle-a", depends_on=["story-cycle-b"])
    cycle_b = _story(tmp_path, "story-cycle-b", depends_on=["story-cycle-a"])

    code, report = mod.readiness_report(tmp_path, [cycle_a, cycle_b])

    assert code == 1
    assert "dependency cycle:" in report


def test_inproc_unknown_dependency_blocks(tmp_path: Path) -> None:
    story = _story(tmp_path, "story-dep", depends_on=["does-not-exist"])

    code, report = mod.readiness_report(tmp_path, [story])

    assert code == 1
    assert "does not resolve" in report
