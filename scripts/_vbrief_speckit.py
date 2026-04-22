"""_vbrief_speckit.py -- speckit plan.vbrief.json -> scope vBRIEFs translator.

Extracted from ``scripts/migrate_vbrief.py`` so the migrator meets the
<1000-line file-size MUST from ``deft/main.md`` after the #495/#505
extractions.  Behaviour is unchanged; import names preserved for the
existing test surface.

Story: #436 / #458.  Extracted by #495 + #505 swarm (Agent A).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from _vbrief_build import slugify as _slugify_shared


def edge_nodes(edge: dict) -> tuple[str, str]:
    """Return (from_id, to_id) for a vBRIEF edge, reading both dialects.

    The canonical v0.5 key names are ``from`` / ``to``, but earlier speckit
    drafts used ``source`` / ``target``.  Prefer the canonical keys when
    they are populated and fall back to the legacy keys.
    """
    if not isinstance(edge, dict):
        return "", ""
    src = edge.get("from") or edge.get("source", "")
    tgt = edge.get("to") or edge.get("target", "")
    return str(src or ""), str(tgt or "")


def dependencies_for_item(item_id: str, edges: list[dict]) -> list[str]:
    """Return the list of item IDs that block ``item_id`` (bilingual reader).

    An edge with ``type == 'blocks'`` and target equal to ``item_id`` means
    the edge's source blocks this item -- so the source is a dependency.
    """
    deps: list[str] = []
    for edge in edges or []:
        if not isinstance(edge, dict):
            continue
        if edge.get("type", "") != "blocks":
            continue
        src, tgt = edge_nodes(edge)
        if tgt == item_id and src and src not in deps:
            deps.append(src)
    return deps


def speckit_ip_slug(title: str, item_id: str) -> str:
    """Return a slug for a speckit IP item filename."""
    source = (title or item_id or "").strip()
    source = re.sub(
        r"^\s*IP[\s-]*\d+\s*[:\-]\s*", "", source, flags=re.IGNORECASE
    )
    slug = _slugify_shared(source)
    return slug or _slugify_shared(item_id) or "ip-phase"


def speckit_ip_index(item: dict, fallback_index: int) -> int:
    """Derive the numeric IP index for a speckit plan item."""
    item_id = str(item.get("id", "") or "")
    tail = re.search(r"(\d+)\s*$", item_id)
    if tail:
        return int(tail.group(1))
    title = str(item.get("title", "") or "")
    lead = re.search(r"IP[\s-]*(\d+)", title, flags=re.IGNORECASE)
    if lead:
        return int(lead.group(1))
    return fallback_index


def create_speckit_scope_vbrief(
    item: dict,
    *,
    ip_index: int,
    dependencies: list[str],
    spec_ref: str,
) -> dict:
    """Build a Phase 4 scope vBRIEF dict for a speckit implementation phase.

    Populates the canonical narrative keys (``Description``, ``Acceptance``,
    ``Traces``), writes ``plan.metadata.dependencies`` at the plan level,
    and links back to the parent ``specification.vbrief.json`` via a
    ``x-vbrief/plan`` reference.
    """
    title = str(item.get("title", f"IP-{ip_index}") or f"IP-{ip_index}")
    narrative = item.get("narrative") or {}
    if not isinstance(narrative, dict):
        narrative = {}

    def _pick(*keys: str, default: str = "") -> str:
        for key in keys:
            value = narrative.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return default

    description = _pick("Description", "Summary", default=title)
    acceptance = _pick("Acceptance", "AcceptanceCriteria", default="")
    traces = _pick("Traces", "Trace", "Requirements", default=f"IP-{ip_index}")

    default_acceptance = (
        f"Acceptance criteria for IP-{ip_index} "
        f"(copy from specification.vbrief.json)."
    )
    narratives: dict[str, str] = {
        "Description": description,
        "Acceptance": acceptance or default_acceptance,
        "Traces": traces,
    }
    for extra in ("Phase", "PhaseDescription", "Tier"):
        value = narrative.get(extra)
        if isinstance(value, str) and value.strip():
            narratives[extra] = value.strip()

    references = [{"type": "x-vbrief/plan", "url": spec_ref}]
    for ref in item.get("references", []) or []:
        if isinstance(ref, dict) and ref.get("type") != "x-vbrief/plan":
            references.append(ref)

    plan: dict = {
        "title": title,
        "status": "pending",
        "narratives": narratives,
        "items": [],
        "references": references,
    }
    if dependencies:
        plan["metadata"] = {"dependencies": list(dependencies)}

    return {
        "vBRIEFInfo": {
            "version": "0.5",
            "description": f"Scope vBRIEF for speckit IP-{ip_index}",
        },
        "plan": plan,
    }


def migrate_speckit_plan(
    plan_path: Path,
    *,
    pending_dir: Path | None = None,
    date: str | None = None,
    spec_ref: str = "../specification.vbrief.json",
    today: str | None = None,
) -> tuple[bool, list[str]]:
    """Translate a speckit-shaped ``plan.vbrief.json`` into scope vBRIEFs.

    Each ``plan.items`` entry becomes a file in ``pending_dir`` named
    ``YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json``.
    """
    actions: list[str] = []
    if not plan_path.is_file():
        return False, [f"ERROR: plan.vbrief.json not found at {plan_path}"]

    try:
        plan_data = json.loads(plan_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, [f"ERROR: invalid JSON in {plan_path.name}: {exc}"]

    plan = plan_data.get("plan", {}) if isinstance(plan_data, dict) else {}
    items = plan.get("items", []) if isinstance(plan, dict) else []
    edges = plan.get("edges", []) if isinstance(plan, dict) else []

    if not items:
        return False, [
            "ERROR: plan.vbrief.json has no items to migrate (empty speckit plan?)"
        ]

    pending_dir = pending_dir or (plan_path.parent / "pending")
    pending_dir.mkdir(parents=True, exist_ok=True)
    effective_date = date or today
    if effective_date is None:  # pragma: no cover -- caller always supplies
        from datetime import UTC, datetime  # noqa: WPS433 -- lazy import
        effective_date = datetime.now(UTC).strftime("%Y-%m-%d")

    created_paths: list[Path] = []
    for idx, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        ip_index = speckit_ip_index(item, idx)
        item_id = str(item.get("id", "") or f"ip-{ip_index}")
        dependencies = dependencies_for_item(item_id, edges)
        slug = speckit_ip_slug(str(item.get("title", "")), item_id)
        ip_token = f"ip{ip_index:03d}"
        filename = f"{effective_date}-{ip_token}-{slug}.vbrief.json"
        target = pending_dir / filename
        if target.exists():
            actions.append(f"SKIP   pending/{filename} already exists")
            created_paths.append(target)
            continue
        scope = create_speckit_scope_vbrief(
            item,
            ip_index=ip_index,
            dependencies=dependencies,
            spec_ref=spec_ref,
        )
        target.write_text(
            json.dumps(scope, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        actions.append(f"CREATE pending/{filename} (IP-{ip_index})")
        created_paths.append(target)

    envelope = plan_data.get("vBRIEFInfo", {}) if isinstance(plan_data, dict) else {}
    envelope.setdefault("version", "0.5")
    envelope["description"] = (
        "Session-level tactical plan (migrated from speckit plan). "
        "Scope vBRIEFs live in vbrief/pending/."
    )
    session_plan = {
        "vBRIEFInfo": envelope,
        "plan": {
            "title": str(plan.get("title", "Session plan")) or "Session plan",
            "status": "running",
            "items": [],
        },
    }
    plan_path.write_text(
        json.dumps(session_plan, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    actions.append(f"REWRITE {plan_path.name} -> session-todo scaffold")
    return True, actions


__all__ = [
    "create_speckit_scope_vbrief",
    "dependencies_for_item",
    "edge_nodes",
    "migrate_speckit_plan",
    "speckit_ip_index",
    "speckit_ip_slug",
]
