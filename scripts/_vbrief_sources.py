"""_vbrief_sources.py -- pre-cutover source-file readers for migrate:vbrief.

Extracted from ``scripts/migrate_vbrief.py`` so the migrator meets the
<1000-line file-size MUST from ``deft/main.md`` after the #495/#505
extractions.  Pure helpers with no dependencies on the other migrator
submodules (#454, #495, #505); behaviour is unchanged.

Exports
-------
parse_roadmap_items(path)
    Parse ROADMAP.md into active items, phase descriptions, and completed
    items (replaces ``_parse_roadmap_items``).
resolve_repo_url(spec_vbrief)
    Resolve the GitHub repository URL from spec_vbrief metadata.
extract_tech_stack(project_content)
    Extract a tech-stack string from PROJECT.md markdown.
first_prose_paragraph(content)
    Return the first plain prose paragraph (skipping code blocks, lists,
    etc.), falling back to the first H1 title.
derive_overview_narrative(...)
    Resolution order for the Overview narrative on
    ``PROJECT-DEFINITION.vbrief.json`` (#417).

Issue: #312 (original migrator); extracted by #495 + #505 swarm (Agent A).
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

DEPRECATION_SENTINEL = "<!-- deft:deprecated-redirect -->"


def parse_roadmap_items(
    roadmap_path: Path,
) -> tuple[list[dict], dict[str, str], list[dict]]:
    """Parse ROADMAP.md and extract items as structured data.

    Returns a tuple of:
      - active items: list of dicts with keys: number, title, phase, tier.
      - phase_descriptions: dict mapping phase heading -> description text.
      - completed items: list of dicts with keys: number, title, phase.
    """
    if not roadmap_path.exists():
        return [], {}, []

    content = roadmap_path.read_text(encoding="utf-8")
    items: list[dict] = []
    completed_items: list[dict] = []
    phase_descriptions: dict[str, str] = {}
    current_phase = ""
    current_tier = ""
    in_completed = False
    desc_lines: list[str] = []
    capturing_desc = False
    _synthetic_counter = 0

    for line in content.splitlines():
        phase_match = re.match(r"^##\s+(.+)", line)
        if phase_match:
            if current_phase and desc_lines:
                phase_descriptions[current_phase] = "\n".join(desc_lines).strip()
            desc_lines = []
            current_phase = phase_match.group(1).strip()
            current_tier = ""
            if "completed" in current_phase.lower():
                in_completed = True
                capturing_desc = False
            else:
                in_completed = False
                capturing_desc = True
            continue

        tier_match = re.match(r"^###\s+(.+)", line)
        if tier_match:
            if current_phase and desc_lines and capturing_desc:
                phase_descriptions[current_phase] = "\n".join(desc_lines).strip()
                desc_lines = []
                capturing_desc = False
            current_tier = tier_match.group(1).strip()
            continue

        if capturing_desc and not in_completed:
            stripped = line.strip()
            if stripped and not stripped.startswith("-"):
                desc_lines.append(stripped)
                continue
            if stripped.startswith("-"):
                if desc_lines:
                    phase_descriptions[current_phase] = "\n".join(desc_lines).strip()
                    desc_lines = []
                capturing_desc = False
            else:
                if desc_lines:
                    desc_lines.append("")
                continue

        if not current_phase:
            continue

        if in_completed:
            comp_match = re.match(r"^-\s+~~(?:#?(\d+)\s*--?\s*)?(.+?)~~", line)
            if comp_match:
                comp_number = comp_match.group(1) or ""
                comp_title = comp_match.group(2).strip()
                completed_items.append({
                    "number": comp_number,
                    "title": comp_title,
                    "phase": current_phase,
                })
            continue

        item_match = re.match(r"^-\s+\*\*#(\d+)\*\*\s+--\s+(.+)", line)
        if item_match:
            items.append({
                "number": item_match.group(1),
                "title": item_match.group(2).strip(),
                "phase": current_phase,
                "tier": current_tier,
            })
            continue

        task_match = re.match(
            r"^-\s+(?:\*\*)?`([^`]+)`(?:\*\*)?\s+(.+)", line
        )
        if task_match:
            task_id = task_match.group(1).strip()
            title = task_match.group(2).strip()
            items.append({
                "number": "",
                "title": title,
                "phase": current_phase,
                "tier": current_tier,
                "task_id": task_id,
            })
            continue

        generic_match = re.match(r"^-\s+(.+)", line)
        if generic_match:
            title = generic_match.group(1).strip()
            if not title:
                continue
            _synthetic_counter += 1
            items.append({
                "number": "",
                "title": title,
                "phase": current_phase,
                "tier": current_tier,
                "synthetic_id": f"roadmap-{_synthetic_counter}",
            })
            continue

    if current_phase and desc_lines and not in_completed:
        phase_descriptions[current_phase] = "\n".join(desc_lines).strip()

    return items, phase_descriptions, completed_items


def resolve_repo_url(spec_vbrief: dict | None) -> str:
    """Resolve the GitHub repository URL from spec_vbrief metadata.

    Falls back to an empty string if no repository can be determined.
    """
    if spec_vbrief:
        repo = spec_vbrief.get("vBRIEFInfo", {}).get("repository", "")
        if repo:
            return f"https://github.com/{repo}"
        refs = spec_vbrief.get("plan", {}).get("references", [])
        for ref in refs:
            uri = ref.get("uri", "")
            if urlparse(uri).netloc in ("github.com", "www.github.com"):
                parts = uri.split("github.com/")[-1].split("/")
                if len(parts) >= 2:
                    return f"https://github.com/{parts[0]}/{parts[1]}"
    return ""


def extract_tech_stack(project_content: str) -> str:
    """Extract a tech-stack string from PROJECT.md content.

    Recognises ``**Tech Stack**: value``, ``## Tech Stack`` sections, and
    plain ``Tech Stack: value``.
    """
    match = re.search(
        r"\*\*Tech\s+Stack\*\*\s*:\s*(.+)", project_content, re.IGNORECASE
    )
    if match:
        return match.group(1).strip()

    section_match = re.search(
        r"##\s+Tech\s+Stack\s*\n(.*?)(?=\n##\s|\Z)",
        project_content,
        re.IGNORECASE | re.DOTALL,
    )
    if section_match:
        section = section_match.group(1).strip()
        if section:
            return section

    plain_match = re.search(
        r"Tech\s+Stack\s*:\s*(.+)", project_content, re.IGNORECASE
    )
    if plain_match:
        return plain_match.group(1).strip()

    return ""


def first_prose_paragraph(content: str) -> str:
    """Return the first non-empty prose paragraph from markdown content."""
    if not content:
        return ""
    first_h1 = ""
    in_code_block = False
    paragraph_lines: list[str] = []

    def _flush() -> str:
        if paragraph_lines:
            return " ".join(paragraph_lines).strip()
        return ""

    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue
        if re.match(r"^#\s+", stripped) and not first_h1:
            first_h1 = re.sub(r"^#\s+", "", stripped).strip()
            continue
        if stripped.startswith("#"):
            para = _flush()
            if para:
                return para
            paragraph_lines.clear()
            continue
        if stripped.startswith(("-", "*", ">", "|")) or re.match(r"^\d+\.\s", stripped):
            para = _flush()
            if para:
                return para
            paragraph_lines.clear()
            continue
        if not stripped:
            para = _flush()
            if para:
                return para
            paragraph_lines.clear()
            continue
        paragraph_lines.append(stripped)

    para = _flush()
    if para:
        return para
    return first_h1


def derive_overview_narrative(
    spec_vbrief: dict | None,
    spec_md_content: str | None,
    project_content: str | None,
    scope_item_count: int,
) -> str:
    """Derive an Overview narrative for PROJECT-DEFINITION.vbrief.json (#417).

    Resolution order:
      1. ``spec_vbrief.plan.narratives['Overview']`` if non-empty.
      2. First prose paragraph / H1 of ``SPECIFICATION.md`` (pre-sentinel).
      3. First prose paragraph / H1 of ``PROJECT.md`` (pre-sentinel).
      4. Synthesized placeholder naming the scope count.
    """
    if spec_vbrief:
        narratives = spec_vbrief.get("plan", {}).get("narratives", {})
        if isinstance(narratives, dict):
            ov = narratives.get("Overview")
            if isinstance(ov, str) and ov.strip():
                return ov.strip()

    if spec_md_content and DEPRECATION_SENTINEL not in spec_md_content:
        derived = first_prose_paragraph(spec_md_content)
        if derived:
            return derived

    if project_content and DEPRECATION_SENTINEL not in project_content:
        derived = first_prose_paragraph(project_content)
        if derived:
            return derived

    if scope_item_count > 0:
        return (
            f"Project overview was not auto-derived during migration. "
            f"{scope_item_count} scope item(s) were created in vbrief/pending/. "
            f"Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['Overview'] "
            f"manually to describe your project."
        )
    return (
        "Project overview was not auto-derived during migration. "
        "Update vbrief/PROJECT-DEFINITION.vbrief.json narratives['Overview'] "
        "manually to describe your project."
    )


__all__ = [
    "DEPRECATION_SENTINEL",
    "derive_overview_narrative",
    "extract_tech_stack",
    "first_prose_paragraph",
    "parse_roadmap_items",
    "resolve_repo_url",
]
