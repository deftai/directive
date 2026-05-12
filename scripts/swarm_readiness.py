#!/usr/bin/env python3
"""Report whether vBRIEF candidates are ready for concurrent swarm allocation."""

from __future__ import annotations

import argparse
import glob
import json
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")
READY = "ready"


@dataclass
class Candidate:
    path: Path
    relpath: str
    data: dict[str, Any]
    plan: dict[str, Any]
    story_id: str
    title: str
    status: str
    folder: str
    kind: str
    swarm: dict[str, Any]
    missing: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    decomposition_needed: bool = False


def _load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _project_rel(project_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _expand_paths(project_root: Path, patterns: list[str]) -> list[Path]:
    if not patterns:
        patterns = ["vbrief/active/*.vbrief.json"]
    out: list[Path] = []
    seen: set[Path] = set()
    for pattern in patterns:
        raw = Path(pattern)
        matches: list[str]
        if any(ch in pattern for ch in "*?["):
            matches = glob.glob(str(raw if raw.is_absolute() else project_root / pattern))
        else:
            matches = [str(raw if raw.is_absolute() else project_root / pattern)]
        for match in matches:
            path = Path(match).resolve()
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            out.append(path)
    return sorted(out)


def _folder_for(path: Path) -> str:
    return path.parent.name if path.parent.name in LIFECYCLE_FOLDERS else ""


def _plan(data: dict[str, Any]) -> dict[str, Any]:
    plan = data.get("plan")
    return plan if isinstance(plan, dict) else {}


def _metadata(plan: dict[str, Any]) -> dict[str, Any]:
    metadata = plan.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _swarm(metadata: dict[str, Any]) -> dict[str, Any]:
    swarm = metadata.get("swarm")
    return swarm if isinstance(swarm, dict) else {}


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return []


def _has_child_plan_refs(plan: dict[str, Any]) -> bool:
    refs = plan.get("references")
    if not isinstance(refs, list):
        return False
    return any(isinstance(ref, dict) and ref.get("type") == "x-vbrief/plan" for ref in refs)


def _looks_like_phase(path: Path, plan: dict[str, Any]) -> bool:
    title = str(plan.get("title") or "")
    plan_id = str(plan.get("id") or "")
    narratives = plan.get("narratives")
    has_acceptance_narrative = (
        isinstance(narratives, dict)
        and isinstance(narratives.get("Acceptance"), str)
        and bool(narratives["Acceptance"].strip())
    )
    has_items = bool(plan.get("items"))
    stem = path.name
    return (
        "-ip" in stem
        or title.lower().startswith("ip-")
        or plan_id.lower().startswith("ip-")
        or (not has_items and has_acceptance_narrative)
    )


def _kind(path: Path, plan: dict[str, Any]) -> str:
    metadata = _metadata(plan)
    explicit = metadata.get("kind")
    if explicit in {"story", "epic", "phase"}:
        return str(explicit)
    if _has_child_plan_refs(plan):
        return "epic"
    if _looks_like_phase(path, plan):
        return "phase"
    return "story"


def _story_id(path: Path, plan: dict[str, Any]) -> str:
    value = plan.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    name = path.name
    return name[: -len(".vbrief.json")] if name.endswith(".vbrief.json") else path.stem


def _item_has_acceptance(item: dict[str, Any]) -> bool:
    narrative = item.get("narrative")
    if isinstance(narrative, dict):
        acceptance = narrative.get("Acceptance")
        if isinstance(acceptance, str) and acceptance.strip():
            return True
    for key in ("items", "subItems"):
        children = item.get(key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and _item_has_acceptance(child):
                    return True
    return False


def _items_have_acceptance(items: Any) -> bool:
    if not isinstance(items, list):
        return False
    return any(isinstance(item, dict) and _item_has_acceptance(item) for item in items)


def _item_has_traces(item: dict[str, Any]) -> bool:
    narrative = item.get("narrative")
    if isinstance(narrative, dict):
        traces = narrative.get("Traces")
        if isinstance(traces, str) and traces.strip():
            return True
    for key in ("items", "subItems"):
        children = item.get(key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and _item_has_traces(child):
                    return True
    return False


def _has_traces(plan: dict[str, Any], swarm: dict[str, Any]) -> bool:
    narratives = plan.get("narratives")
    if isinstance(narratives, dict):
        traces = narratives.get("Traces")
        if isinstance(traces, str) and traces.strip():
            return True
    items = plan.get("items")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and _item_has_traces(item):
                return True
    refs = plan.get("references")
    if isinstance(refs, list):
        for ref in refs:
            if isinstance(ref, dict) and ref.get("type") == "x-vbrief/spec-section":
                return True
    return bool(_as_str_list(swarm.get("missing_traces_justification")))


def _all_scope_ids(project_root: Path) -> dict[str, tuple[Path, str]]:
    ids: dict[str, tuple[Path, str]] = {}
    vbrief_dir = project_root / "vbrief"
    for folder in LIFECYCLE_FOLDERS:
        for path in sorted((vbrief_dir / folder).glob("*.vbrief.json")):
            data = _load_json(path)
            if not data:
                continue
            plan = _plan(data)
            scope_id = _story_id(path, plan)
            ids[scope_id] = (path, str(plan.get("status") or ""))
            name = path.name
            stem = name[: -len(".vbrief.json")] if name.endswith(".vbrief.json") else path.stem
            ids.setdefault(stem, (path, str(plan.get("status") or "")))
    return ids


def _candidate(path: Path, project_root: Path) -> Candidate | None:
    data = _load_json(path)
    if not data:
        return None
    plan = _plan(data)
    metadata = _metadata(plan)
    swarm = _swarm(metadata)
    return Candidate(
        path=path,
        relpath=_project_rel(project_root, path),
        data=data,
        plan=plan,
        story_id=_story_id(path, plan),
        title=str(plan.get("title") or path.name),
        status=str(plan.get("status") or ""),
        folder=_folder_for(path),
        kind=_kind(path, plan),
        swarm=swarm,
    )


def _validate_candidate(candidate: Candidate, known_ids: dict[str, tuple[Path, str]]) -> None:
    if candidate.kind in {"epic", "phase"}:
        candidate.decomposition_needed = True
        return
    if candidate.kind != "story":
        candidate.missing.append("plan.metadata.kind=story")
    if candidate.folder == "active" and candidate.status != "running":
        candidate.blocked.append("active candidate plan.status must be running")
    if candidate.status == "running" and candidate.folder != "active":
        candidate.blocked.append("plan.status=running is only valid in vbrief/active/")
    if candidate.status == "blocked":
        candidate.blocked.append("plan.status=blocked")

    items = candidate.plan.get("items")
    if not isinstance(items, list) or not items:
        candidate.missing.append("plan.items")
    elif not _items_have_acceptance(items):
        candidate.missing.append("plan.items[].narrative.Acceptance")

    if candidate.swarm.get("readiness") != READY:
        candidate.missing.append("plan.metadata.swarm.readiness=ready")
    if candidate.swarm.get("parallel_safe") is not True:
        candidate.missing.append("plan.metadata.swarm.parallel_safe=true")
    if not _as_str_list(candidate.swarm.get("file_scope")):
        candidate.missing.append("plan.metadata.swarm.file_scope")
    if not _as_str_list(candidate.swarm.get("verify_commands")):
        candidate.missing.append("plan.metadata.swarm.verify_commands")
    if not _has_traces(candidate.plan, candidate.swarm):
        candidate.missing.append("Traces or missing_traces_justification")
    if candidate.swarm.get("size") == "large" and candidate.swarm.get("parallel_safe") is True:
        candidate.blocked.append("size=large cannot be parallel_safe=true")
    if (
        candidate.swarm.get("file_scope_confidence") == "low"
        and candidate.swarm.get("parallel_safe") is True
    ):
        candidate.blocked.append("low-confidence file scope cannot be parallel-safe by default")

    for dep in _as_str_list(candidate.swarm.get("depends_on")):
        if dep not in known_ids:
            candidate.blocked.append(f"dependency {dep!r} does not resolve")


def _candidate_dep_graph(
    candidates: list[Candidate],
    known_ids: dict[str, tuple[Path, str]],
) -> dict[str, list[str]]:
    candidate_ids = {candidate.story_id for candidate in candidates}
    graph: dict[str, list[str]] = {}
    for candidate in candidates:
        deps: list[str] = []
        for dep in _as_str_list(candidate.swarm.get("depends_on")):
            if dep in candidate_ids:
                deps.append(dep)
                continue
            known = known_ids.get(dep)
            if known is None:
                continue
            _dep_path, dep_status = known
            if dep_status not in {"completed", "failed", "cancelled"}:
                candidate.blocked.append(f"dependency {dep!r} is not completed or a candidate")
        graph[candidate.story_id] = deps
    return graph


def _mark_cycles(candidates: list[Candidate], graph: dict[str, list[str]]) -> None:
    by_id = {candidate.story_id: candidate for candidate in candidates}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(story_id: str, path: list[str]) -> None:
        if story_id in visited:
            return
        if story_id in visiting:
            cycle = [*path, story_id]
            message = f"dependency cycle: {' -> '.join(cycle)}"
            for node in cycle:
                if node in by_id and message not in by_id[node].blocked:
                    by_id[node].blocked.append(message)
            return
        visiting.add(story_id)
        for dep in graph.get(story_id, []):
            visit(dep, [*path, story_id])
        visiting.remove(story_id)
        visited.add(story_id)

    for candidate in candidates:
        visit(candidate.story_id, [])


def _ready_stories(candidates: list[Candidate]) -> list[Candidate]:
    return [
        candidate
        for candidate in candidates
        if candidate.kind == "story"
        and not candidate.missing
        and not candidate.blocked
        and not candidate.decomposition_needed
    ]


def _dependency_waves(candidates: list[Candidate], graph: dict[str, list[str]]) -> list[list[str]]:
    ready_ids = {candidate.story_id for candidate in _ready_stories(candidates)}
    remaining = set(ready_ids)
    waves: list[list[str]] = []
    while remaining:
        wave = sorted(
            story_id
            for story_id in remaining
            if all(dep not in remaining for dep in graph.get(story_id, []))
        )
        if not wave:
            waves.append(sorted(remaining))
            break
        waves.append(wave)
        remaining.difference_update(wave)
    return waves


def _transitive_deps(story_id: str, graph: dict[str, list[str]]) -> set[str]:
    out: set[str] = set()
    stack = list(graph.get(story_id, []))
    while stack:
        dep = stack.pop()
        if dep in out:
            continue
        out.add(dep)
        stack.extend(graph.get(dep, []))
    return out


def _file_overlaps(
    candidates: list[Candidate],
    graph: dict[str, list[str]],
) -> dict[str, list[str]]:
    file_to_ids: dict[str, list[str]] = defaultdict(list)
    for candidate in _ready_stories(candidates):
        if candidate.swarm.get("parallel_safe") is not True:
            continue
        for file_path in _as_str_list(candidate.swarm.get("file_scope")):
            file_to_ids[file_path].append(candidate.story_id)

    overlaps: dict[str, list[str]] = {}
    for file_path, ids in file_to_ids.items():
        unsafe_pairs: set[str] = set()
        for index, left in enumerate(ids):
            for right in ids[index + 1:]:
                if right in _transitive_deps(left, graph) or left in _transitive_deps(right, graph):
                    continue
                unsafe_pairs.add(left)
                unsafe_pairs.add(right)
        if unsafe_pairs:
            overlaps[file_path] = sorted(unsafe_pairs)
    return overlaps


def _conflict_groups(candidates: list[Candidate]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for candidate in candidates:
        group = candidate.swarm.get("conflict_group")
        if isinstance(group, str) and group.strip():
            groups[group].append(candidate.story_id)
    return dict(sorted(groups.items()))


def _render_report(
    candidates: list[Candidate],
    graph: dict[str, list[str]],
    overlaps: dict[str, list[str]],
) -> str:
    ready = _ready_stories(candidates)
    blocked = [
        candidate
        for candidate in candidates
        if candidate.kind == "story" and (candidate.missing or candidate.blocked)
    ]
    needs_decomposition = [candidate for candidate in candidates if candidate.decomposition_needed]
    lines: list[str] = ["Swarm readiness report", ""]

    lines.append("Ready stories:")
    if ready:
        for candidate in ready:
            lines.append(f"- {candidate.story_id}: {candidate.title} ({candidate.relpath})")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Blocked stories:")
    if blocked:
        for candidate in blocked:
            reasons = [*candidate.missing, *candidate.blocked]
            lines.append(f"- {candidate.story_id}: {candidate.title} -- {'; '.join(reasons)}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Decomposition-needed epics/phases:")
    if needs_decomposition:
        for candidate in needs_decomposition:
            lines.append(f"- {candidate.story_id}: kind={candidate.kind} ({candidate.relpath})")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Dependency waves:")
    waves = _dependency_waves(candidates, graph)
    if waves:
        for index, wave in enumerate(waves, start=1):
            lines.append(f"- wave {index}: {', '.join(wave)}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Conflict groups:")
    groups = _conflict_groups(candidates)
    if groups:
        for group, ids in groups.items():
            lines.append(f"- {group}: {', '.join(sorted(ids))}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("File overlap matrix:")
    if overlaps:
        for file_path, ids in sorted(overlaps.items()):
            lines.append(f"- {file_path}: {', '.join(ids)}")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("Missing fields:")
    missing_any = False
    for candidate in candidates:
        if candidate.missing:
            missing_any = True
            lines.append(f"- {candidate.story_id}: {', '.join(candidate.missing)}")
    if not missing_any:
        lines.append("- none")
    return "\n".join(lines)


def readiness_report(project_root: Path, paths: list[Path]) -> tuple[int, str]:
    candidates = [candidate for path in paths if (candidate := _candidate(path, project_root))]
    if not candidates:
        return 1, "Swarm readiness report\n\nNo candidate vBRIEFs found."
    known_ids = _all_scope_ids(project_root)
    for candidate in candidates:
        known_ids.setdefault(candidate.story_id, (candidate.path, candidate.status))
    for candidate in candidates:
        _validate_candidate(candidate, known_ids)
    graph = _candidate_dep_graph(candidates, known_ids)
    _mark_cycles(candidates, graph)
    overlaps = _file_overlaps(candidates, graph)
    report = _render_report(candidates, graph, overlaps)
    failed = any(
        candidate.missing or candidate.blocked or candidate.decomposition_needed
        for candidate in candidates
    ) or bool(overlaps)
    return 1 if failed else 0, report


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Report whether vBRIEF candidates are ready for concurrent swarm allocation."
    )
    parser.add_argument("paths", nargs="*", help="Candidate vBRIEF paths or globs")
    parser.add_argument("--project-root", default=".", help="Project root containing vbrief/")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    project_root = Path(args.project_root).resolve()
    paths = _expand_paths(project_root, args.paths)
    code, report = readiness_report(project_root, paths)
    print(report)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
