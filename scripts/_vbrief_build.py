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
# Emitted vBRIEF version (#533)
# ----------------------------------------------------------------------------

# Canonical ``vBRIEFInfo.version`` string emitted on every scope vBRIEF built
# via :func:`create_scope_vbrief`. Bumped from ``"0.5"`` to ``"0.6"`` as part
# of the Agent 2 schema vendor transition (#533). During the transition the
# validator accepts both strings; ingestion/generation paths only emit the
# newer one.
EMITTED_VBRIEF_VERSION: str = "0.6"


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
# Migrator provenance metadata namespace (#616)
# ----------------------------------------------------------------------------

# Per issue #616 (option A, scope-clamped), per-issue scope vBRIEFs emit
# ``plan.narratives`` as an empty object because a ROADMAP.md row does not
# carry enough data to populate any canonical narrative key meaningfully
# (Goals / ProblemStatement / UserStories need hand-authoring). Migrator-
# internal provenance (Phase, Tier, PhaseDescription plus reconciler-
# emitted fields) is relocated under ``plan.metadata`` in the
# ``x-migrator/*`` namespace so downstream readers can still access it
# without it leaking into user-visible narratives.
#
# The surface key is a string (``"x-migrator"``) rather than a dotted
# path because ``plan.metadata`` is schema-defined as ``{type: object}``
# with no structural constraints -- any key is legal. Using the
# ``x-migrator`` namespace signals "this value comes from `task
# migrate:vbrief`" at a glance and keeps the payload compatible with the
# vendored v0.6 schema without touching it.
MIGRATOR_METADATA_KEY: str = "x-migrator"

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

    The returned structure conforms to the canonical vBRIEF version emitted
    by deft (``EMITTED_VBRIEF_VERSION``, currently ``"0.6"`` per #533):
      - ``vBRIEFInfo.version = EMITTED_VBRIEF_VERSION``
      - ``plan.title`` is ``item['title']`` verbatim
      - ``plan.status`` is ``status`` (default ``pending``)
      - ``plan.narratives`` is ``{}`` (empty). Per-issue scope vBRIEFs
        intentionally ship with no narratives -- ROADMAP rows do not
        carry enough data for any canonical narrative key, and inventing
        keys leaked migrator internals into user-visible narratives
        (#616). Migrator-internal provenance (``Phase`` / ``Tier`` /
        ``PhaseDescription``) lives in ``plan.metadata['x-migrator']``
        when populated.
      - ``plan.references`` carries the canonical v0.6 origin-provenance
        entry ``{uri, type: "x-vbrief/github-issue", title}`` when
        ``item['number']`` is non-empty AND ``repo_url`` can be resolved
        to a GitHub owner/repo (#613). Legacy readers that used to
        receive a bare ``{type: "github-issue", id: "#N"}`` must migrate
        to the canonical shape -- see ``scripts/reconcile_issues.py``
        for a bilingual reader example.
    """
    number = item.get("number", "")
    title = item.get("title", "Untitled")
    phase = item.get("phase", "")
    tier = item.get("tier", "")

    desc_label = f"#{number}: {title}" if number else title

    vbrief: dict = {
        "vBRIEFInfo": {
            "version": EMITTED_VBRIEF_VERSION,
            "description": f"Scope vBRIEF for {desc_label}",
        },
        "plan": {
            "title": title,
            "status": status,
            "narratives": {},
            "items": [],
        },
    }

    # #616: relocate migrator-internal provenance from plan.narratives to
    # plan.metadata['x-migrator'] so downstream tools (roadmap_render) keep
    # working without leaking invented keys into user-visible narratives.
    migrator_meta: dict[str, str] = {}
    if phase:
        migrator_meta["Phase"] = phase
    if tier:
        migrator_meta["Tier"] = tier
    if phase_description:
        migrator_meta["PhaseDescription"] = phase_description
    if migrator_meta:
        vbrief["plan"].setdefault("metadata", {})[MIGRATOR_METADATA_KEY] = migrator_meta

    # #613: origin provenance per RFC #309 D11 + conventions/references.md.
    # Canonical shape: {uri, type: "x-vbrief/github-issue", title}. A
    # reference is only emitted when BOTH ``number`` and ``repo_url`` are
    # present -- the schema's VBriefReference definition requires ``uri``
    # so we cannot honestly emit a reference without a resolvable URL.
    # ROADMAP bare-text rows (no issue number) legitimately ship with no
    # origin reference; the migrator logs them as proposed/ orphans.
    if number and repo_url:
        ref_title = (
            f"Issue #{number}: {title}" if title and title != "Untitled"
            else f"Issue #{number}"
        )
        canonical_ref: dict = {
            "uri": f"{repo_url}/issues/{number}",
            "type": "x-vbrief/github-issue",
            "title": ref_title,
        }
        vbrief["plan"]["references"] = [canonical_ref]

    return vbrief


__all__ = [
    "EMITTED_VBRIEF_VERSION",
    "MIGRATOR_METADATA_KEY",
    "TODAY",
    "slugify",
    "create_scope_vbrief",
]
