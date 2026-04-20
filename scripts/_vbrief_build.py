"""Shared helpers for building scope vBRIEF dicts.

Extracted from ``scripts/migrate_vbrief.py`` so ``scripts/issue_ingest.py`` (and
any future ingestion / generation script) can reuse them without cross-importing
the migrator. The canonical names are the public ``slugify`` / ``TODAY`` /
``create_scope_vbrief`` surface; ``migrate_vbrief.py`` continues to re-export
the legacy underscore-prefixed aliases for backwards compatibility.

Story: #454 (task issue:ingest).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

# ----------------------------------------------------------------------------
# Date helper
# ----------------------------------------------------------------------------

# Exposed for callers that want the canonical YYYY-MM-DD date used across
# ingestion / migration filenames. Kept module-level so monkeypatching in tests
# is straightforward.
TODAY: str = datetime.now(UTC).strftime("%Y-%m-%d")


# ----------------------------------------------------------------------------
# Slugification
# ----------------------------------------------------------------------------


def slugify(text: str) -> str:
    """Convert a title to a filename-safe slug.

    - Lowercase, collapse whitespace/underscores to single hyphens
    - Drop characters that are not [a-z0-9-]
    - Trim to 60 characters maximum and strip leading/trailing hyphens
    """
    slug = text.lower().strip()
    # Preserve underscores through the strip pass so the next line can fold
    # them into hyphens (matches the documented contract).
    slug = re.sub(r"[^a-z0-9\s_-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    return slug[:60].strip("-")


# ----------------------------------------------------------------------------
# Scope vBRIEF construction
# ----------------------------------------------------------------------------


def create_scope_vbrief(
    item: dict,
    repo_url: str = "",
    status: str = "pending",
    phase_description: str = "",
) -> dict:
    """Build a scope vBRIEF dict for a roadmap or issue item.

    ``item`` is a generic dict with the following recognised keys:
      - ``number`` (str): GitHub issue number (without '#')
      - ``title`` (str): scope title (required in practice)
      - ``phase`` (str): roadmap phase label (optional)
      - ``tier`` (str): sub-phase tier label (optional)

    The returned structure conforms to vBRIEF v0.5:
      - ``vBRIEFInfo.version = "0.5"``
      - ``plan.title`` is ``item['title']`` verbatim
      - ``plan.status`` is ``status`` (default ``pending``)
      - ``plan.narratives`` carries ``Description`` / ``Phase`` (and optional
        ``Tier`` / ``PhaseDescription``).
      - ``plan.references`` carries a ``github-issue`` origin-provenance entry
        when ``item['number']`` is non-empty.
    """
    number = item.get("number", "")
    title = item.get("title", "Untitled")
    phase = item.get("phase", "")
    tier = item.get("tier", "")

    desc_label = f"#{number}: {title}" if number else title
    narratives: dict[str, str] = {
        "Description": title,
        "Phase": phase,
    }
    if tier:
        narratives["Tier"] = tier
    if phase_description:
        narratives["PhaseDescription"] = phase_description

    vbrief: dict = {
        "vBRIEFInfo": {
            "version": "0.5",
            "description": f"Scope vBRIEF for {desc_label}",
        },
        "plan": {
            "title": title,
            "status": status,
            "narratives": narratives,
            "items": [],
        },
    }

    # Origin provenance per RFC #309 D11
    if number:
        ref: dict = {
            "type": "github-issue",
            "id": f"#{number}",
        }
        if repo_url:
            ref["url"] = f"{repo_url}/issues/{number}"
        vbrief["plan"]["references"] = [ref]

    return vbrief


__all__ = ["TODAY", "slugify", "create_scope_vbrief"]
