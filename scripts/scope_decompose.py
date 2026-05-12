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
from _vbrief_build import EMITTED_VBRIEF_VERSION, slugify  # noqa: E402

reconfigure_stdio()

LIFECYCLE_FOLDERS = {"proposed", "pending", "active", "completed", "cancelled"}
READY = "ready"


class DecompositionError(ValueError):
    """Raised when a decomposition draft is not safe to apply."""


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DecompositionError(f"{path}: invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise DecompositionError(f"{path}: expected a JSON object")
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
    rel = path.resolve().relative_to(vbrief_dir.resolve()).as_posix()
    return f"./{rel}"


def _scope_folder(parent_path: Path, vbrief_dir: Path) -> Path:
    if parent_path.parent.name in LIFECYCLE_FOLDERS:
        return parent_path.parent
    return vbrief_dir / "pending"


def _default_status_for_folder(folder: Path) -> str:
    return {
        "proposed": "proposed",
        "pending": "pending",
        "active": "running",
        "completed": "completed",
        "cancelled": "cancelled",
    }.get(folder.name, "pending")


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
    swarm.setdefault("readiness", READY)
    swarm.setdefault("parallel_safe", True)
    swarm.setdefault("depends_on", [])
    return swarm


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return []


def _item_has_acceptance(item: dict[str, Any]) -> bool:
    narrative = item.get("narrative")
    if isinstance(narrative, dict):
        value = narrative.get("Acceptance")
        if isinstance(value, str) and value.strip():
            return True
    for child_key in ("items", "subItems"):
        children = item.get(child_key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and _item_has_acceptance(child):
                    return True
    return False


def _items_have_acceptance(items: list[Any]) -> bool:
    return any(isinstance(item, dict) and _item_has_acceptance(item) for item in items)


def _item_has_traces(item: dict[str, Any]) -> bool:
    narrative = item.get("narrative")
    if isinstance(narrative, dict):
        value = narrative.get("Traces")
        if isinstance(value, str) and value.strip():
            return True
    for child_key in ("items", "subItems"):
        children = item.get(child_key)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict) and _item_has_traces(child):
                    return True
    return False


def _story_has_traces(story: dict[str, Any], items: list[Any], swarm: dict[str, Any]) -> bool:
    narratives = story.get("narratives")
    if isinstance(narratives, dict):
        value = narratives.get("Traces")
        if isinstance(value, str) and value.strip():
            return True
    if _as_str_list(story.get("traces")):
        return True
    if any(isinstance(item, dict) and _item_has_traces(item) for item in items):
        return True
    if _as_str_list(swarm.get("missing_traces_justification")):
        return True
    refs = story.get("references")
    if isinstance(refs, list):
        for ref in refs:
            if isinstance(ref, dict) and ref.get("type") == "x-vbrief/spec-section":
                return True
    return False


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
            cycle = " -> ".join([*path, story_id])
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

        if swarm.get("readiness") != READY:
            continue

        items = _items_from_story(story_id, story)
        missing: list[str] = []
        if not items:
            missing.append("plan.items")
        if items and not _items_have_acceptance(items):
            missing.append("plan.items[].narrative.Acceptance")
        if not _as_str_list(swarm.get("file_scope")):
            missing.append("plan.metadata.swarm.file_scope")
        if not _as_str_list(swarm.get("verify_commands")):
            missing.append("plan.metadata.swarm.verify_commands")
        if not _story_has_traces(story, items, swarm):
            missing.append("Traces or missing_traces_justification")
        if missing:
            raise DecompositionError(f"{story_id}: ready story missing {', '.join(missing)}")

    _validate_dag(story_ids, deps_by_story)
    return story_ids


def _normalize_references(refs: Any) -> list[dict[str, Any]]:
    if not isinstance(refs, list):
        return []
    normalized: list[dict[str, Any]] = []
    for ref in refs:
        if isinstance(ref, dict):
            normalized.append(copy.deepcopy(ref))
    return normalized


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
        ("traces", "Traces"),
    ):
        if narrative_key in narratives:
            continue
        values = _as_str_list(story.get(draft_key))
        if values:
            narratives[narrative_key] = ", ".join(values)
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
        _normalize_references(parent_plan.get("references"))
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
            "status": str(story.get("status") or status),
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
        project_root, str(draft.get("output_dir", ""))
    ) or _scope_folder(parent_path, vbrief_dir)
    if output_dir.name not in LIFECYCLE_FOLDERS:
        raise DecompositionError("output_dir must be a vbrief lifecycle folder")
    status = str(draft.get("status") or _default_status_for_folder(output_dir))
    parent_rel = _rel_to_vbrief(vbrief_dir, parent_path)

    actions = [f"VALIDATED {len(stories)} story decomposition draft"]
    child_paths: list[tuple[Path, str, str]] = []
    child_docs: list[dict[str, Any]] = []
    for index, story in enumerate(stories, start=1):
        story_id = story_ids[index - 1]
        title = str(story.get("title") or story_id)
        filename = _child_filename(story, story_id, title, date)
        target = output_dir / filename
        if target.exists() and not check_only:
            raise DecompositionError(f"{target}: refusing to overwrite existing child story")
        child = _build_child_vbrief(
            story=story,
            story_id=story_id,
            story_index=index,
            parent=parent,
            parent_rel=parent_rel,
            status=status,
        )
        child_paths.append((target, story_id, title))
        child_docs.append(child)
        verb = "CHECK" if check_only else "CREATE"
        actions.append(f"{verb} {_rel_to_vbrief(vbrief_dir, target)}")

    if check_only:
        return actions

    for target, _story_id, _title in child_paths:
        target.parent.mkdir(parents=True, exist_ok=True)
    for (target, _story_id, _title), child in zip(child_paths, child_docs, strict=True):
        _write_json(target, child)

    parent_plan = parent.setdefault("plan", {})
    if not isinstance(parent_plan, dict):
        raise DecompositionError(f"{parent_path}: plan must be an object")
    metadata = parent_plan.setdefault("metadata", {})
    if isinstance(metadata, dict):
        metadata.setdefault("kind", "epic")
    references = parent_plan.setdefault("references", [])
    if not isinstance(references, list):
        references = []
        parent_plan["references"] = references
    for target, _story_id, title in child_paths:
        references.append(
            {
                "uri": _rel_to_vbrief(vbrief_dir, target),
                "type": "x-vbrief/plan",
                "title": title,
            }
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
