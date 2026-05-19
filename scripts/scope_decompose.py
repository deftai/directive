#!/usr/bin/env python3
"""Apply or validate an approved epic/phase -> story decomposition draft.

The command is intentionally deterministic: it never invents stories from a
parent scope. A caller supplies a draft with child story definitions; this
script validates that draft, writes the child story vBRIEFs, and updates the
parent scope references.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from _vbrief_build import (  # noqa: E402
    EMITTED_VBRIEF_VERSION,
    reference_with_default_trust as _reference_with_default_trust,
    slugify,
)
from _vbrief_story_quality import (  # noqa: E402
    acceptance_texts_from_items,
    as_str_list as _as_str_list,
    deprecated_subitems_issues,
    item_has_traces,
    items_have_acceptance,
    missing_required_swarm_fields,
    story_quality_issues,
)

reconfigure_stdio()

LIFECYCLE_FOLDERS = {"proposed", "pending", "active", "completed", "cancelled"}
ACTIVE_DECOMPOSITION_STATUSES = {"active", "running"}
READY = "ready"
STORY_READINESS_STATES = {READY, "sequential", "needs_refinement"}


class DecompositionError(ValueError):
    """Raised when a decomposition draft is not safe to apply."""


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise DecompositionError(f"{path}: cannot read file: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise DecompositionError(f"{path}: invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise DecompositionError(f"{path}: expected a JSON object") from None
    return data


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _resolve_path(project_root: Path, value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else project_root / path


def _vbrief_dir(project_root: Path) -> Path:
    return project_root / "vbrief"


def _rel_to_vbrief(vbrief_dir: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(vbrief_dir.resolve()).as_posix()
    except ValueError as exc:
        raise DecompositionError(f"{path}: path must be inside {vbrief_dir}") from exc


def _pending_scope_folder(vbrief_dir: Path) -> Path:
    return vbrief_dir / "pending"


def _default_status_for_folder(folder: Path) -> str:
    return {
        "proposed": "proposed",
        "pending": "pending",
        "active": "running",
        "completed": "completed",
        "cancelled": "cancelled",
    }.get(folder.name, "pending")


def _normalize_status(value: Any, default: str) -> str:
    if value is None:
        return default
    status = str(value).strip().lower()
    return status or default


def _story_specs(draft: dict[str, Any]) -> list[dict[str, Any]]:
    stories = draft.get("stories", draft.get("children", []))
    if isinstance(stories, dict):
        stories = list(stories.values())
    if not isinstance(stories, list):
        raise DecompositionError("draft must contain a stories array")
    normalized: list[dict[str, Any]] = []
    for index, story in enumerate(stories, start=1):
        if not isinstance(story, dict):
            raise DecompositionError(f"stories[{index}] must be an object")
        normalized.append(story)
    return normalized


def _story_id(story: dict[str, Any], index: int) -> str:
    raw = story.get("id") or story.get("story_id") or story.get("key")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    title = str(story.get("title") or f"story-{index}")
    return slugify(title) or f"story-{index}"


def _swarm_meta(story: dict[str, Any]) -> dict[str, Any]:
    metadata = story.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    swarm = story.get("swarm") or metadata.get("swarm") or {}
    if not isinstance(swarm, dict):
        swarm = {}
    # Accept the convenient draft shape where canonical swarm fields live at
    # the story top level, then store them under plan.metadata.swarm.
    for key in (
        "readiness",
        "parallel_safe",
        "file_scope",
        "verify_commands",
        "expected_outputs",
        "depends_on",
        "conflict_group",
        "size",
        "file_scope_confidence",
        "model_tier",
        "missing_traces_justification",
    ):
        if key in story and key not in swarm:
            swarm[key] = story[key]
    return swarm


def _story_has_traces(story: dict[str, Any], items: list[Any], swarm: dict[str, Any]) -> bool:
    narratives = story.get("narratives")
    if isinstance(narratives, dict):
        value = narratives.get("Traces")
        if isinstance(value, str) and value.strip():
            return True
    if _as_str_list(story.get("traces")):
        return True
    if any(isinstance(item, dict) and item_has_traces(item) for item in items):
        return True
    if _as_str_list(swarm.get("missing_traces_justification")):
        return True
    refs = story.get("references")
    if isinstance(refs, list):
        for ref in refs:
            if isinstance(ref, dict) and ref.get("type") == "x-vbrief/spec-section":
                return True
    return False


def _story_description(story: dict[str, Any]) -> str:
    narratives = story.get("narratives")
    if isinstance(narratives, dict):
        value = narratives.get("Description")
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("description", "summary"):
        value = story.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _story_implementation_plan(story: dict[str, Any]) -> str:
    narratives = story.get("narratives")
    if isinstance(narratives, dict):
        value = narratives.get("ImplementationPlan")
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("implementation_plan", "ImplementationPlan"):
        values = _as_str_list(story.get(key))
        if values:
            return "\n".join(values)
    return ""


def _story_user_story(story: dict[str, Any]) -> str:
    narratives = story.get("narratives")
    if isinstance(narratives, dict):
        value = narratives.get("UserStory")
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("user_story", "UserStory"):
        value = story.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _acceptance_count_justification(story: dict[str, Any], swarm: dict[str, Any]) -> str:
    for value in (
        swarm.get("acceptance_criteria_justification"),
        story.get("acceptance_criteria_justification"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    narratives = story.get("narratives")
    if isinstance(narratives, dict):
        value = narratives.get("AcceptanceJustification")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _items_from_story(story_id: str, story: dict[str, Any]) -> list[Any]:
    items = story.get("items")
    if isinstance(items, list) and items:
        return items
    acceptance = _as_str_list(story.get("acceptance"))
    if not acceptance:
        acceptance = _as_str_list(story.get("acceptance_items"))
    traces = ", ".join(_as_str_list(story.get("traces")))
    generated: list[dict[str, Any]] = []
    for index, criterion in enumerate(acceptance, start=1):
        narrative = {"Acceptance": criterion}
        if traces:
            narrative["Traces"] = traces
        generated.append(
            {
                "id": f"{story_id}-a{index}",
                "title": criterion,
                "status": "pending",
                "narrative": narrative,
            }
        )
    return generated


def _validate_dag(story_ids: list[str], deps_by_story: dict[str, list[str]]) -> None:
    known = set(story_ids)
    for story_id, deps in deps_by_story.items():
        for dep in deps:
            if dep not in known:
                raise DecompositionError(f"{story_id}: depends_on references unknown story {dep!r}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(story_id: str, path: list[str]) -> None:
        if story_id in visited:
            return
        if story_id in visiting:
            start = path.index(story_id) if story_id in path else 0
            cycle = " -> ".join([*path[start:], story_id])
            raise DecompositionError(f"dependency cycle detected: {cycle}")
        visiting.add(story_id)
        for dep in deps_by_story.get(story_id, []):
            visit(dep, [*path, story_id])
        visiting.remove(story_id)
        visited.add(story_id)

    for story_id in story_ids:
        visit(story_id, [])


def validate_draft(stories: list[dict[str, Any]]) -> list[str]:
    """Validate draft story contracts and return ordered story ids."""
    story_ids: list[str] = []
    deps_by_story: dict[str, list[str]] = {}
    seen: set[str] = set()
    for index, story in enumerate(stories, start=1):
        story_id = _story_id(story, index)
        if story_id in seen:
            raise DecompositionError(f"duplicate story id {story_id!r}")
        seen.add(story_id)
        story_ids.append(story_id)
        swarm = _swarm_meta(story)
        deps = _as_str_list(swarm.get("depends_on") or story.get("depends_on"))
        deps_by_story[story_id] = deps

        items = _items_from_story(story_id, story)
        description = _story_description(story)
        implementation_plan = _story_implementation_plan(story)
        user_story = _story_user_story(story)
        issues: list[str] = []
        raw_id = story.get("id") or story.get("story_id") or story.get("key")
        if not isinstance(raw_id, str) or not raw_id.strip():
            issues.append("id")
        raw_title = story.get("title")
        if not isinstance(raw_title, str) or not raw_title.strip():
            issues.append("title")
        if not description:
            issues.append("plan.narratives.Description")
        if not implementation_plan:
            issues.append("plan.narratives.ImplementationPlan")
        if not user_story:
            issues.append("plan.narratives.UserStory")
        readiness = swarm.get("readiness")
        if readiness not in STORY_READINESS_STATES:
            issues.append("plan.metadata.swarm.readiness")
        parallel_safe = swarm.get("parallel_safe")
        if parallel_safe is not True and parallel_safe is not False:
            issues.append("plan.metadata.swarm.parallel_safe")
        if not items:
            issues.append("plan.items")
        if items and not items_have_acceptance(items):
            issues.append("plan.items[].narrative.Acceptance")
        issues.extend(deprecated_subitems_issues(items))
        issues.extend(missing_required_swarm_fields(swarm))
        if not _story_has_traces(story, items, swarm):
            issues.append("Traces or missing_traces_justification")
        issues.extend(
            story_quality_issues(
                title=str(story.get("title") or story_id),
                description=description,
                implementation_plan=implementation_plan,
                user_story=user_story,
                acceptance_texts=acceptance_texts_from_items(items),
                acceptance_count_justification=_acceptance_count_justification(story, swarm),
                swarm=swarm,
                concurrent_ready=readiness == READY,
            )
        )
        if issues:
            raise DecompositionError(f"{story_id}: story invalid: {', '.join(issues)}")

    _validate_dag(story_ids, deps_by_story)
    return story_ids


def _normalize_references(refs: Any) -> list[dict[str, Any]]:
    if not isinstance(refs, list):
        return []
    normalized: list[dict[str, Any]] = []
    for ref in refs:
        if isinstance(ref, dict):
            normalized.append(_reference_with_default_trust(ref))
    return normalized


def _child_provenance_references(refs: Any) -> list[dict[str, Any]]:
    return [
        ref
        for ref in _normalize_references(refs)
        if "acceptance" not in str(ref.get("type") or "").lower()
    ]


def _dedupe_references(refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for ref in refs:
        key = (
            str(ref.get("uri") or ref.get("url") or ""),
            str(ref.get("type") or ""),
            str(ref.get("title") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(ref)
    return out


def _story_narratives(story: dict[str, Any]) -> dict[str, str]:
    narratives: dict[str, str] = {}
    raw = story.get("narratives")
    if isinstance(raw, dict):
        for key, value in raw.items():
            if isinstance(value, str) and value.strip():
                narratives[key] = value.strip()
    for draft_key, narrative_key in (
        ("description", "Description"),
        ("summary", "Description"),
        ("implementation_plan", "ImplementationPlan"),
        ("ImplementationPlan", "ImplementationPlan"),
        ("user_story", "UserStory"),
        ("UserStory", "UserStory"),
        ("traces", "Traces"),
    ):
        if narrative_key in narratives:
            continue
        values = _as_str_list(story.get(draft_key))
        if values:
            separator = "\n" if narrative_key == "ImplementationPlan" else ", "
            narratives[narrative_key] = separator.join(values)
    return narratives


def _child_filename(story: dict[str, Any], story_id: str, title: str, date: str) -> str:
    filename = story.get("filename")
    if isinstance(filename, str) and filename.endswith(".vbrief.json"):
        return filename
    slug = slugify(title) or slugify(story_id) or "story"
    return f"{date}-{slug}.vbrief.json"


def _build_child_vbrief(
    *,
    story: dict[str, Any],
    story_id: str,
    story_index: int,
    parent: dict[str, Any],
    parent_rel: str,
    status: str,
) -> dict[str, Any]:
    title = str(story.get("title") or story_id)
    swarm = _swarm_meta(story)
    items = _items_from_story(story_id, story)
    metadata = (
        copy.deepcopy(story.get("metadata"))
        if isinstance(story.get("metadata"), dict)
        else {}
    )
    metadata["kind"] = "story"
    metadata["swarm"] = swarm

    parent_plan = parent.get("plan", {}) if isinstance(parent, dict) else {}
    parent_refs = (
        _child_provenance_references(parent_plan.get("references"))
        if isinstance(parent_plan, dict)
        else []
    )
    story_refs = _normalize_references(story.get("references"))

    return {
        "vBRIEFInfo": {
            "version": EMITTED_VBRIEF_VERSION,
            "description": f"Story vBRIEF {story_index} decomposed from {parent_rel}",
        },
        "plan": {
            "id": story_id,
            "title": title,
            "status": status,
            "planRef": parent_rel,
            "narratives": _story_narratives(story),
            "items": items,
            "metadata": metadata,
            "references": _dedupe_references([*parent_refs, *story_refs]),
        },
    }


def apply_decomposition(
    *,
    project_root: Path,
    parent_path: Path,
    draft_path: Path,
    check_only: bool,
    date: str,
) -> list[str]:
    vbrief_dir = _vbrief_dir(project_root)
    parent = _load_json(parent_path)
    draft = _load_json(draft_path)
    stories = _story_specs(draft)
    story_ids = validate_draft(stories)
    output_dir = _resolve_path(
        project_root, draft.get("output_dir") or ""
    ) or _pending_scope_folder(vbrief_dir)
    if output_dir.name not in LIFECYCLE_FOLDERS:
        raise DecompositionError("output_dir must be a vbrief lifecycle folder")
    try:
        output_dir.resolve().relative_to(vbrief_dir.resolve())
    except ValueError as exc:
        raise DecompositionError("output_dir must be inside vbrief/") from exc
    if output_dir.name == "active":
        raise DecompositionError(
            "output_dir must not be vbrief/active; write pending stories and use "
            "task scope:activate when work begins"
        ) from None
    status = _normalize_status(draft.get("status"), _default_status_for_folder(output_dir))
    if status in ACTIVE_DECOMPOSITION_STATUSES:
        raise DecompositionError(
            "decomposition cannot create active/running child stories; write pending "
            "stories and use task scope:activate when work begins"
        )
    parent_rel = _rel_to_vbrief(vbrief_dir, parent_path)

    actions = [f"VALIDATED {len(stories)} story decomposition draft"]
    child_paths: list[tuple[Path, str, str]] = []
    child_docs: list[dict[str, Any]] = []
    for index, story in enumerate(stories, start=1):
        story_id = story_ids[index - 1]
        title = str(story.get("title") or story_id)
        story_status = _normalize_status(story.get("status"), status)
        if story_status in ACTIVE_DECOMPOSITION_STATUSES:
            raise DecompositionError(
                f"{story_id}: decomposition cannot create active/running child stories; "
                "write pending stories and use task scope:activate when work begins"
            )
        filename = _child_filename(story, story_id, title, date)
        target = output_dir / filename
        if not check_only and (target.is_file() or target.is_dir() or target.is_symlink()):
            raise DecompositionError(
                f"{target}: child story path already exists; overwriting is not supported"
            )
        child = _build_child_vbrief(
            story=story,
            story_id=story_id,
            story_index=index,
            parent=parent,
            parent_rel=parent_rel,
            status=story_status,
        )
        child_paths.append((target, story_id, title))
        child_docs.append(child)
        verb = "CHECK" if check_only else "CREATE"
        actions.append(f"{verb} {_rel_to_vbrief(vbrief_dir, target)}")

    if check_only:
        return actions

    parent_plan = parent.get("plan")
    if parent_plan is None:
        parent_plan = {}
        parent["plan"] = parent_plan
    if not isinstance(parent_plan, dict):
        raise DecompositionError(f"{parent_path}: plan must be an object")
    metadata = parent_plan.get("metadata")
    if metadata is None:
        metadata = {}
        parent_plan["metadata"] = metadata
    if not isinstance(metadata, dict):
        raise DecompositionError(f"{parent_path}: plan.metadata must be an object")
    metadata.setdefault("kind", "epic")
    references = parent_plan.get("references")
    if references is None:
        references = []
        parent_plan["references"] = references
    if not isinstance(references, list):
        raise DecompositionError(f"{parent_path}: plan.references must be an array")

    for target, _story_id, _title in child_paths:
        target.parent.mkdir(parents=True, exist_ok=True)
    for (target, _story_id, _title), child in zip(child_paths, child_docs, strict=True):
        _write_json(target, child)

    for target, _story_id, title in child_paths:
        references.append(
            _reference_with_default_trust(
                {
                    "uri": _rel_to_vbrief(vbrief_dir, target),
                    "type": "x-vbrief/plan",
                    "title": title,
                }
            )
        )
    parent_plan["references"] = _dedupe_references(
        [ref for ref in references if isinstance(ref, dict)]
    )
    _write_json(parent_path, parent)
    actions.append(f"UPDATE {parent_rel} references")
    return actions


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate and apply an approved epic/phase story decomposition draft."
    )
    parser.add_argument("parent", nargs="?", help="Parent epic/phase vBRIEF path")
    parser.add_argument("--draft", help="Approved decomposition JSON draft")
    parser.add_argument("--check", action="store_true", help="Validate only; do not write")
    parser.add_argument("--date", help="Creation date for generated child filenames")
    parser.add_argument("--project-root", default=".", help="Project root containing vbrief/")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("scope_decompose", argv)
    if rc is not None:
        return rc
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    project_root = Path(args.project_root).resolve()
    parent_path = _resolve_path(project_root, args.parent)
    draft_path = _resolve_path(project_root, args.draft)
    if parent_path is None or draft_path is None:
        if args.check:
            print("OK no decomposition draft supplied; nothing to apply.")
            return 0
        print("ERROR: parent path and --draft are required", file=sys.stderr)
        return 2
    if not parent_path.is_file():
        print(f"ERROR: parent vBRIEF not found: {parent_path}", file=sys.stderr)
        return 2
    if not draft_path.is_file():
        print(f"ERROR: decomposition draft not found: {draft_path}", file=sys.stderr)
        return 2
    date = args.date or datetime.now(UTC).strftime("%Y-%m-%d")
    try:
        actions = apply_decomposition(
            project_root=project_root,
            parent_path=parent_path,
            draft_path=draft_path,
            check_only=args.check,
            date=date,
        )
    except DecompositionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    for action in actions:
        print(action)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
