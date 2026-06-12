#!/usr/bin/env python3
r"""
issue_ingest.py -- Ingest GitHub issues into vBRIEF lifecycle folders.

Every post-GA issue would otherwise live only on GitHub and reappear in the
``task reconcile:issues`` unlinked section monotonically -- this script lets a
maintainer (or an agent running the refinement skill) materialise an issue as a
scope vBRIEF with origin provenance so the rest of the framework can reason
about it. Single-issue mode fetches one issue number and writes one scope
vBRIEF; bulk mode scans all open issues (optionally filtered by label) and
ingests anything not already referenced by an existing vBRIEF.

Usage:
    uv run python scripts/issue_ingest.py <N> [--status proposed|pending|active]
    uv run python scripts/issue_ingest.py --all [--label LABEL]
                                         [--status STATUS] [--dry-run]
    uv run python scripts/issue_ingest.py [--vbrief-dir DIR] [--repo OWNER/REPO] ...

Exit codes:
    0 -- ingest completed successfully
    1 -- duplicate (single-issue mode; the issue already has a vBRIEF)
    2 -- external error (missing gh, API failure, usage error)

Story: #454 (task issue:ingest).

Issue bodies are opaque upstream Markdown text. Never decode them through
Python or JSON string-escape semantics after the GitHub JSON payload has been
parsed; literal substrings such as ``\vbrief``, ``\task``, ``\n``, and
``\u0041`` must remain literal text in ``plan.narratives.Overview``.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# Make sibling scripts importable both when run as __main__ and when imported
# by tests that pre-populate sys.path with the ``scripts/`` directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# #1145 / N5: route the ``gh api`` round-trip in :func:`_fetch_single_issue`
# through the source-aware shim so a future GitLab / Gitea / local consumer
# sees ``NotImplementedError`` pointing at #445 / #935 Workstream 6 instead
# of a confusing ``gh: command not found`` deep in the call stack. The shim
# resolves the binary via the #884 ``ghx`` -> ``gh`` preference ladder.
from _project_context import resolve_project_repo, resolve_project_root  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from _vbrief_build import EMITTED_VBRIEF_VERSION, TODAY, slugify  # noqa: E402
from reconcile_issues import (  # noqa: E402
    GITHUB_ISSUE_REF_TYPES,
    LIFECYCLE_FOLDERS,
    detect_repo,
    extract_references_from_vbrief,
    fetch_open_issues,
    parse_issue_number,
)

import scm  # noqa: E402 -- sibling-first path insertion above is intentional

# #883 unified cache surface (optional). When present we prefer the cached
# raw.json payload over a live ``gh api`` round-trip so a Phase 0 walk that
# pre-populated the cache (``task cache:fetch-all``) does not re-spend the
# REST budget per issue. The import is guarded so this module imports cleanly
# in checkouts where ``scripts/cache.py`` is not yet on the branch -- tests
# substitute fakes via ``monkeypatch.setattr(issue_ingest, "cache", ...)``.
try:  # pragma: no cover -- exercised once #883 Story 2 lands.
    import cache  # type: ignore[import-not-found]  # noqa: E402
except ImportError:  # pragma: no cover
    cache = None  # type: ignore[assignment]

reconfigure_stdio()

# --- Constants --------------------------------------------------------------

# Allowed target lifecycle folders for ingestion. The rest (``completed/``,
# ``cancelled/``) are terminal states; a freshly ingested issue doesn't belong
# there.
INGEST_STATUSES: tuple[str, ...] = ("proposed", "pending", "active")

# #1096: provenance-narrative parsers. ``_build_issue_vbrief`` emits
# ``narratives.Origin = "Ingested from <full-URL>"`` when a browser URL
# resolves, or ``"Ingested from issue #N"`` when no URL is available.
# ``vBRIEFInfo.description = "Scope vBRIEF ingested from GitHub issue #N"``
# is the secondary signal. Both shapes yield the same canonical provenance
# issue number for the dedup pass.
_ORIGIN_URL_RE = re.compile(
    r"https?://github\.com/[^/\s]+/[^/\s]+/issues/(\d+)"
)
_ORIGIN_BARE_RE = re.compile(r"issue\s*#(\d+)", re.IGNORECASE)

# Map status keyword -> (folder, plan.status) pair used in the generated
# scope vBRIEF file.
_STATUS_MAP: dict[str, tuple[str, str]] = {
    "proposed": ("proposed", "proposed"),
    "pending": ("pending", "pending"),
    "active": ("active", "running"),
}

# #1248: body-parsing patterns. The ingester previously emitted stub-only
# vBRIEFs (no ``Overview``, ``plan.items == []``) which forced the
# refinement workflow to re-read the GitHub issue body by hand. The
# patterns below extract acceptance-criteria checklists, numbered AC
# items, and Closes / Refs / Blocked-by cross-references from the issue
# body so downstream consumers (``deft-directive-refinement``,
# ``task triage:queue`` dedup) have substantive content to project from.

# GitHub-flavoured Markdown task-list line. Captures the marker (space /
# x / X) and the trailing title text. The trailing ``$`` anchors against
# trailing whitespace so a multi-line list item only contributes the
# first line; deeper nesting / continuation lines are explicitly out of
# scope for v1 and noted as a follow-up in the issue body.
_CHECKBOX_RE = re.compile(
    r"^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$",
    re.MULTILINE,
)

# Heading whose text contains "Acceptance Criteria" (case-insensitive).
# Used as the entry point for the AC-section fallback when the body
# carries no checkbox-style task list.
_AC_HEADING_RE = re.compile(
    r"^(#{1,6})\s+.*\bacceptance\s+criteria\b.*$",
    re.IGNORECASE | re.MULTILINE,
)

# Bullet- or numbered-list item. Used inside the AC section after the
# heading match -- both ``- foo`` / ``* foo`` / ``+ foo`` and
# ``1. foo`` / ``1) foo`` shapes are accepted.
_LIST_ITEM_RE = re.compile(
    r"^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$",
    re.MULTILINE,
)

# Closing / referencing / blocking keyword -> canonical ``x-vbrief/*``
# reference type. Ordering is significant: ``blocked by`` is matched
# before ``blocks`` would be (the latter is intentionally absent because
# ``Blocks #N`` on the source issue has the inverse semantic of the
# ingested issue being blocked). Patterns are applied against a body
# stripped of fenced and inline code spans so Markdown examples don't
# produce spurious cross-refs.
_CROSS_REF_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "x-vbrief/closes",
        re.compile(
            r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "x-vbrief/blocks",
        re.compile(
            r"\bblocked[\s\-]+by\s+#(\d+)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "x-vbrief/refs",
        re.compile(
            r"\b(?:refs?|references?|see\s+also|related(?:\s+to)?)\s+#(\d+)\b",
            re.IGNORECASE,
        ),
    ),
)

# Fenced code block (triple-backtick OR tilde-fence) and inline code
# span (single backtick, no embedded backtick / newline). Stripped
# before cross-ref / plan-item extraction so a body that quotes
# ``Closes #N`` as an illustration does not produce a real cross-ref.
# The capturing group + ``\1`` backreference enforces matching
# delimiters (a ``~~~`` fence cannot be closed by ``\`\`\``) per the
# GitHub Flavoured Markdown spec.
_CODE_FENCE_RE = re.compile(r"(```|~~~).*?\1", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")

_CONTROL_CHAR_LABELS: dict[str, str] = {
    "\b": "U+0008 backspace",
    "\t": "U+0009 tab",
    "\v": "U+000B vertical tab",
    "\f": "U+000C form feed",
}


# --- Helpers ----------------------------------------------------------------


def _strip_code_blocks(body: str) -> str:
    """Return ``body`` with Markdown code spans elided (#1248).

    Fenced code blocks (triple-backtick) and inline single-backtick code
    spans are replaced with the empty string before cross-ref / plan-item
    extraction. This prevents an issue body that *quotes* ``Closes #N``
    as a syntax example (the #1248 body is itself an example -- it
    embeds a JSON block illustrating the stub-only shape) from producing
    spurious cross-refs or plan-items.
    """
    if not body:
        return ""
    return _INLINE_CODE_RE.sub("", _CODE_FENCE_RE.sub("", body))


def _has_non_indentation_prefix(text: str, index: int) -> bool:
    """Return True when a tab at ``index`` follows non-whitespace on its line."""
    line_start = text.rfind("\n", 0, index) + 1
    return any(ch not in " \t" for ch in text[line_start:index])


def _body_control_character_labels(body: str) -> list[str]:
    """Return visible labels for unexpected control characters in issue body text."""
    labels: list[str] = []
    seen: set[str] = set()
    for index, char in enumerate(body):
        if char == "\t" and not _has_non_indentation_prefix(body, index):
            continue
        label = _CONTROL_CHAR_LABELS.get(char)
        if label is None and ord(char) < 32 and char not in {"\n", "\r"}:
            label = f"U+{ord(char):04X} control character"
        if label and label not in seen:
            seen.add(label)
            labels.append(label)
    return labels


def _warn_body_control_characters(number: int, body: str) -> None:
    """Surface decoded upstream control characters before writing a vBRIEF."""
    labels = _body_control_character_labels(body)
    if not labels:
        return
    print(
        f"Warning: issue #{number} body contains unexpected control characters "
        f"({', '.join(labels)}); preserving Overview verbatim, but "
        "verify_encoding will flag the generated vBRIEF narrative.",
        file=sys.stderr,
    )


def _extract_plan_items(body: str) -> list[dict]:
    """Extract ``plan.items[]`` entries from a GitHub issue body (#1248).

    Detection ladder:

    1. Markdown task-list checkboxes (``- [ ] foo`` / ``- [x] bar``) --
       the GitHub-native shape that ``deft-directive-refinement`` and
       ``task triage:queue`` both project from. Unchecked boxes map to
       ``status = "proposed"``; checked boxes map to
       ``status = "completed"`` so an issue that ships partial progress
       is reflected honestly.
    2. Bullet- / numbered-list items underneath an ``Acceptance
       Criteria`` heading -- the second-most-common shape across the
       2026-05-20 audit cohort. Stops at the next heading at the same
       or higher level.
    3. Graceful degradation: when neither shape is present, return an
       empty list. The vBRIEF still carries ``narratives.Overview`` so
       refinement can refine *something*; ``plan.items`` is only ever
       populated when there is structured source material to project
       from.

    Every emitted item carries the schema-required ``title`` + ``status``
    keys (``minLength: 1`` on ``title``; ``status`` from the canonical
    ``Status`` enum). Duplicate titles are de-duped while preserving
    document order.
    """
    if not body:
        return []
    text = _strip_code_blocks(body)

    items: list[dict] = []
    seen: set[str] = set()
    for match in _CHECKBOX_RE.finditer(text):
        marker = match.group(1)
        title_text = match.group(2).strip()
        if not title_text or title_text in seen:
            continue
        seen.add(title_text)
        status = "completed" if marker.lower() == "x" else "proposed"
        items.append({"title": title_text, "status": status})
    if items:
        return items

    # Fallback: numbered / bulleted list under an Acceptance Criteria heading.
    return _extract_ac_section_items(text)


def _extract_ac_section_items(text: str) -> list[dict]:
    """Extract list items from an Acceptance Criteria section (#1248 fallback).

    Walks for an ``Acceptance Criteria`` heading (any level 1-6,
    case-insensitive). When found, slices the body to the section --
    bounded by the next heading at the same-or-higher level -- and
    returns each bullet / numbered list item as a PlanItem dict with
    ``status = "proposed"``.
    """
    heading_match = _AC_HEADING_RE.search(text)
    if not heading_match:
        return []
    heading_level = len(heading_match.group(1))
    section_start = heading_match.end()
    next_heading_re = re.compile(
        rf"^#{{1,{heading_level}}}\s+\S",
        re.MULTILINE,
    )
    after = text[section_start:]
    next_match = next_heading_re.search(after)
    section_text = after[: next_match.start()] if next_match else after

    items: list[dict] = []
    seen: set[str] = set()
    for li in _LIST_ITEM_RE.finditer(section_text):
        title_text = li.group(1).strip()
        # Defensive: strip a leftover ``[ ]`` / ``[x]`` checkbox prefix
        # if a maintainer mixed checkbox + numbered shapes inside the
        # AC section. Preserve the checked state so a completed item
        # in a numbered+checkbox mixed AC list lands as ``completed``
        # rather than being silently demoted to ``proposed`` (downstream
        # consumers ``deft-directive-refinement`` / ``task triage:queue``
        # treat ``status`` as signal for remaining work).
        status = "proposed"
        cb = re.match(r"\[([ xX])\]\s+(.+)", title_text)
        if cb:
            title_text = cb.group(2).strip()
            if cb.group(1).lower() == "x":
                status = "completed"
        if not title_text or title_text in seen:
            continue
        seen.add(title_text)
        items.append({"title": title_text, "status": status})
    return items


def _extract_cross_refs(
    body: str,
    repo_url: str,
    *,
    exclude: set[int] | None = None,
) -> list[dict]:
    """Extract Closes / Refs / Blocked-by cross-refs from issue body (#1248).

    Returns a list of canonical ``VBriefReference`` dicts (``{uri, type,
    title}``) ready to append to ``plan.references[]``. Reference types:

    - ``x-vbrief/closes`` for ``Closes / Fixes / Resolves #N`` (inflected
      forms ``closed`` / ``fixed`` / ``resolved`` accepted).
    - ``x-vbrief/blocks`` for ``Blocked by #N`` -- the dependency
      direction the issue body expresses (this scope is blocked by #N).
    - ``x-vbrief/refs`` for ``Refs / References / See also / Related #N``.

    Skips matches that fall inside fenced or inline code spans (the
    body is passed through :func:`_strip_code_blocks` first) and any
    issue number in ``exclude`` -- callers pass the provenance issue
    number itself so a self-reference (e.g. ``Closes #1248`` in #1248's
    own body) does not produce a duplicate reference to the canonical
    ``x-vbrief/github-issue`` origin.

    Returns an empty list when ``repo_url`` is empty -- the canonical
    ``VBriefReference`` shape requires ``uri``, and synthesising a
    URL without a repo handle would be dishonest.
    """
    if not body or not repo_url:
        return []
    text = _strip_code_blocks(body)
    refs: list[dict] = []
    seen: set[tuple[str, int]] = set()
    excluded = exclude or set()
    for ref_type, pattern in _CROSS_REF_PATTERNS:
        for match in pattern.finditer(text):
            number = int(match.group(1))
            if number in excluded:
                continue
            key = (ref_type, number)
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                {
                    "uri": f"{repo_url}/issues/{number}",
                    "type": ref_type,
                    "title": f"Issue #{number}",
                }
            )
    return refs


def _provenance_issue_number(data: dict) -> int | None:
    """Extract the provenance issue number from a vBRIEF data dict (#1096).

    A vBRIEF is the *provenance owner* of issue ``#N`` when its
    ``plan.narratives.Origin`` (or, as a secondary signal,
    ``vBRIEFInfo.description``) states it was ingested from ``#N``. Both
    canonical Origin shapes emitted by :func:`_build_issue_vbrief` are
    accepted:

    - ``Ingested from https://github.com/<owner>/<repo>/issues/<N>``
    - ``Ingested from issue #<N>``  (no-URL fallback)

    Returns the provenance issue number or ``None`` when the vBRIEF carries
    no recognisable ``Ingested from ...`` signal (e.g. a hand-authored
    kaizen brief that merely references GitHub issues, or a legacy v0.5
    fixture predating the Origin convention -- the caller's fallback
    heuristic in :func:`_scan_provenance_refs` handles back-compat).
    """
    if not isinstance(data, dict):
        return None
    plan = data.get("plan", {})
    narratives = plan.get("narratives", {}) if isinstance(plan, dict) else {}
    origin = (
        narratives.get("Origin", "") if isinstance(narratives, dict) else ""
    )
    info = data.get("vBRIEFInfo", {})
    description = info.get("description", "") if isinstance(info, dict) else ""

    for text in (origin, description):
        if not isinstance(text, str) or not text:
            continue
        m = _ORIGIN_URL_RE.search(text)
        if m:
            return int(m.group(1))
        m = _ORIGIN_BARE_RE.search(text)
        if m:
            return int(m.group(1))
    return None


def _scan_provenance_refs(vbrief_dir: Path) -> dict[int, list[str]]:
    """Scan vBRIEF lifecycle folders and return a provenance-only dedup map (#1096).

    Differentiates *provenance* references (the vBRIEF was actually
    ingested from issue ``#N`` -- ``plan.narratives.Origin`` confirms it
    AND a canonical ``x-vbrief/github-issue`` reference points at ``#N``)
    from *informational* references (companion / sibling / related-plan
    mentions, even when typed ``x-vbrief/github-issue``). Only the
    provenance owner of an issue is returned, so ``task issue:ingest --
    <N>`` no longer false-positives on informational references that
    merely mention ``#N`` (closes #1096).

    Per-vBRIEF resolution rule:

    1. If ``plan.narratives.Origin`` (or ``vBRIEFInfo.description``)
       identifies a provenance issue number ``P`` AND any
       ``x-vbrief/github-issue`` reference points at ``P`` -> that vBRIEF
       is the provenance owner of ``P`` (only). Other
       ``x-vbrief/github-issue`` references on the same vBRIEF are
       treated as informational and contribute nothing to the dedup map.
    2. If no ``Origin`` provenance signal is present (legacy v0.5
       fixtures, hand-authored stubs) -> fall back to the FIRST
       ``x-vbrief/github-issue`` reference as the implied provenance.
       This preserves dedup for unmigrated trees per the #1096 vBRIEF's
       out-of-scope clause ("the fix should make new ingest correct
       without requiring a data-migration sweep first").

    Returns:
        Mapping of issue_number -> list of vBRIEF file paths (relative to
        ``vbrief_dir``) where each listed vBRIEF is the *provenance* owner
        of that issue. The list shape matches
        :func:`reconcile_issues.scan_vbrief_dir` so callers can swap the
        two functions transparently.
    """
    issue_to_vbriefs: dict[int, list[str]] = {}

    for folder in LIFECYCLE_FOLDERS:
        folder_path = vbrief_dir / folder
        if not folder_path.is_dir():
            continue
        for vbrief_file in sorted(folder_path.glob("*.vbrief.json")):
            try:
                data = json.loads(vbrief_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            refs = extract_references_from_vbrief(data)
            github_refs: list[tuple[dict, int]] = []
            for ref in refs:
                if ref.get("type") not in GITHUB_ISSUE_REF_TYPES:
                    continue
                num = parse_issue_number(ref)
                if num is not None:
                    github_refs.append((ref, num))

            if not github_refs:
                continue

            provenance_num = _provenance_issue_number(data)
            if provenance_num is not None:
                # Origin/description identifies ``provenance_num`` -- only
                # count the matching github-issue ref. Companion refs to
                # other issues on the same vBRIEF are informational.
                if not any(num == provenance_num for _, num in github_refs):
                    # Origin narrative claims a number not borne out by any
                    # github-issue reference. Honest behaviour is to skip
                    # this vBRIEF -- treating the Origin claim alone as
                    # provenance would re-introduce the false-positive
                    # surface the legacy-ref fallback below is bounded
                    # against.
                    continue
                owner_num = provenance_num
            else:
                # Legacy fallback: first github-issue ref is provenance.
                owner_num = github_refs[0][1]

            rel_path = f"{folder}/{vbrief_file.name}"
            issue_to_vbriefs.setdefault(owner_num, []).append(rel_path)

    return issue_to_vbriefs


def _build_issue_vbrief(
    issue: dict, status: str, repo_url: str
) -> tuple[dict, str]:
    """Build a scope vBRIEF dict (and the target lifecycle folder) from a GitHub issue dict.

    ``issue`` is the JSON payload returned by ``gh api repos/.../issues/N`` or
    one element of the ``gh issue list --json number,title,labels,url,body``
    array.

    Emits canonical vBRIEF v0.6 output (#639 + #988):
      - ``vBRIEFInfo.version = EMITTED_VBRIEF_VERSION`` (``"0.6"``) -- the
        canonical schema pin (const ``"0.6"`` in
        ``vbrief/schemas/vbrief-core.schema.json``).
      - ``plan.narratives.Overview`` carries the GitHub issue body verbatim
        when present (#988). This is the contract documented in
        ``skills/deft-directive-swarm/SKILL.md`` Phase 0 Step 0B; the prior
        implementation only emitted ``Description`` (= title) and dropped
        the body, producing stub vBRIEFs that failed every downstream
        "acceptance criteria present" check. ``narratives.Labels`` is kept
        for backward compatibility but ``plan.tags`` is now the structured
        surface for downstream filtering.
      - ``plan.tags`` is a list of label-name strings when the issue carries
        labels (#988). The Plan schema's ``tags`` array (line 162 of
        ``vbrief/schemas/vbrief-core.schema.json``) accepts arbitrary
        strings; this lets consumers filter without parsing the freeform
        ``narratives.Labels`` text.
      - ``plan.references`` uses the canonical
        ``VBriefReference`` shape ``{uri, type: "x-vbrief/github-issue",
        title: "Issue #{N}: {title}"}`` documented in
        ``conventions/references.md`` (matches ``scripts/_vbrief_build.py::
        create_scope_vbrief``). The legacy bare
        ``{type: "github-issue", id: "#N", url}`` shape is NEVER emitted.
      - When no browser URL can be resolved (neither the issue payload's
        ``url`` nor a non-empty ``repo_url``) the reference is omitted --
        ``VBriefReference`` requires ``uri``, so we cannot honestly emit
        one. The caller still has the issue number in ``plan.narratives["Origin"]``.
    """
    number = int(issue["number"])
    title = str(issue.get("title", f"Issue #{number}")) or f"Issue #{number}"
    url = str(issue.get("url", "")) or (
        f"{repo_url}/issues/{number}" if repo_url else ""
    )
    body = issue.get("body")
    body_str = str(body) if isinstance(body, str) and body else ""
    labels = issue.get("labels", []) or []
    label_names = [
        (lbl.get("name") if isinstance(lbl, dict) else str(lbl))
        for lbl in labels
        if (isinstance(lbl, dict) and lbl.get("name")) or isinstance(lbl, str)
    ]
    folder, plan_status = _STATUS_MAP[status]

    narratives: dict[str, str] = {
        "Description": title,
        "Origin": f"Ingested from {url}" if url else f"Ingested from issue #{number}",
    }
    if body_str:
        # #988: carry the issue body verbatim to ``narratives.Overview`` so
        # the swarm Phase 0 "acceptance criteria present" check has source
        # text to project from. #1248 widens this surface by ALSO emitting
        # structured ``plan.items[]`` + ``plan.references[]`` cross-refs
        # derived from the body, so refinement / triage:queue have more
        # than just an opaque blob to work with.
        _warn_body_control_characters(number, body_str)
        narratives["Overview"] = body_str
    if label_names:
        narratives["Labels"] = ", ".join(label_names)

    # #1248: derive ``plan.items[]`` from the issue body's task-list /
    # acceptance-criteria checklist (graceful degradation to ``[]`` when
    # neither shape is present).
    plan_items = _extract_plan_items(body_str) if body_str else []

    plan: dict = {
        "title": title,
        "status": plan_status,
        "narratives": narratives,
        "items": plan_items,
    }
    if label_names:
        # #988: structured-surface mirror of ``narratives.Labels`` so
        # consumers can filter by tag without parsing the freeform string.
        plan["tags"] = list(label_names)

    # #639 + #1248: canonical v0.6 VBriefReference shape, with the body-
    # derived Closes / Refs / Blocked-by cross-refs appended after the
    # canonical ``x-vbrief/github-issue`` origin. Only emit when we have
    # a resolvable URL -- the schema requires ``uri`` and we must not
    # forge one. Matches ``scripts/_vbrief_build.py::create_scope_vbrief``
    # and ``conventions/references.md``.
    if url:
        references: list[dict] = [
            {
                "uri": url,
                "type": "x-vbrief/github-issue",
                "title": f"Issue #{number}: {title}",
            }
        ]
        if body_str and repo_url:
            # Use ``repo_url`` (not ``url``) so cross-refs target sibling
            # issues under the same repo even when ``url`` already
            # resolves a specific issue; exclude ``number`` so a
            # self-referencing ``Closes #N`` in the body does not
            # duplicate the canonical origin reference above.
            references.extend(
                _extract_cross_refs(
                    body_str, repo_url, exclude={number}
                )
            )
        plan["references"] = references

    return {
        "vBRIEFInfo": {
            "version": EMITTED_VBRIEF_VERSION,
            "description": f"Scope vBRIEF ingested from GitHub issue #{number}",
        },
        "plan": plan,
    }, folder


def _target_filename(number: int, title: str) -> str:
    """Build the ``YYYY-MM-DD-<N>-<slug>.vbrief.json`` filename for an issue."""
    slug = slugify(title) or f"issue-{number}"
    return f"{TODAY}-{number}-{slug}.vbrief.json"


def _fetch_from_cache(
    repo: str,
    number: int,
    *,
    cache_root: Path | None = None,
) -> dict | None:
    """Read the unified cache (#883) for ``(github-issue, repo/number)`` if fresh.

    Returns the parsed ``raw.json`` payload when present and not stale,
    ``None`` otherwise (cache miss, stale entry, parse failure, or the
    cache module is not importable). The caller falls back to a live
    ``gh api`` round-trip via :func:`_fetch_single_issue` on ``None``.

    Cache freshness is delegated to :func:`scripts.cache.cache_get` with
    ``allow_stale=False`` -- this matches the #883 contract that callers
    opt in to stale entries explicitly. The unified cache TTL for
    ``github-issue`` is 7 days (see ``scripts/cache.py::SOURCE_TTL_SECONDS``).
    """
    if cache is None:
        return None
    key = f"{repo}/{int(number)}"
    try:
        result = cache.cache_get(
            "github-issue", key, cache_root=cache_root, allow_stale=False
        )
    except Exception:  # noqa: BLE001 -- any cache error -> live fetch fallback
        return None
    raw_path = Path(result.entry_dir) / "raw.json"
    if not raw_path.exists():
        return None
    try:
        issue: Any = json.loads(raw_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(issue, dict):
        return None
    # Mirror the normalisation _fetch_single_issue applies to live ``gh api``
    # output: prefer ``html_url`` (browser URL) over ``url`` (REST API URL)
    # when both are present. The cache populated by ``task cache:fetch-all``
    # uses ``gh issue list --json ...,url`` which already emits the browser
    # URL, so this branch is a no-op for cached payloads -- but keep it
    # defensive so a future cache populator using ``gh api`` directly still
    # produces honest output here.
    if issue.get("html_url"):
        issue["url"] = issue["html_url"]
    return issue


def _fetch_issue(
    repo: str,
    number: int,
    *,
    cwd: Path | None = None,
    cache_root: Path | None = None,
) -> dict | None:
    """Fetch a single issue, preferring the unified cache over live ``gh api``.

    #988: when ``.deft-cache/github-issue/<owner>/<repo>/<N>/raw.json`` is
    fresh, return the cached payload directly so a Phase 0 walk that
    pre-populated the cache via ``task cache:fetch-all`` does not re-spend
    the REST budget per issue. Falls back to live ``gh api`` on cache miss
    or stale entries (per #883 cache freshness rules).
    """
    cached = _fetch_from_cache(repo, number, cache_root=cache_root)
    if cached is not None:
        return cached
    return _fetch_single_issue(repo, number, cwd=cwd)


def _fetch_single_issue(
    repo: str,
    number: int,
    *,
    cwd: Path | None = None,
) -> dict | None:
    """Fetch a single issue via ``gh api repos/{repo}/issues/{number}``.

    Routes through :func:`scripts.scm.call` (#1145 / N5) so a future
    non-GitHub consumer raises a loud ``NotImplementedError`` pointing at
    #445 / #935 Workstream 6 rather than failing deep in the call stack
    with ``gh: command not found``. The shim resolves the binary via the
    #884 ``ghx`` -> ``gh`` preference ladder so cached responses are
    transparently picked up when ``ghx`` is installed.

    Returns the parsed issue dict on success, ``None`` on error (with the
    reason printed to stderr).
    """
    try:
        result = scm.call(
            "github-issue",
            "api",
            [f"repos/{repo}/issues/{number}"],
            timeout=30,
            cwd=str(cwd) if cwd is not None else None,
        )
    except FileNotFoundError:
        print("Error: gh CLI not found. Install GitHub CLI.", file=sys.stderr)
        return None
    except scm.ScmStubError as exc:
        print(f"Error: gh CLI resolution failed: {exc}", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print("Error: gh CLI timed out.", file=sys.stderr)
        return None

    if result.returncode != 0:
        print(
            f"Error: gh CLI failed fetching #{number}: {result.stderr.strip()}",
            file=sys.stderr,
        )
        return None
    try:
        issue = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(
            f"Error: failed to parse gh CLI output for #{number}.",
            file=sys.stderr,
        )
        return None
    # #639 follow-up (Greptile P1): ``gh api repos/{repo}/issues/{N}``
    # ALWAYS returns both ``url`` (REST API URL, ``https://api.github.com/repos/...``)
    # and ``html_url`` (browser URL, ``https://github.com/{owner}/{repo}/issues/{N}``).
    # The previous ``"url" not in issue`` guard was therefore always False for
    # real gh api output, so ``issue["url"]`` leaked through as the REST API
    # URL and ended up in the canonical ``uri`` field -- contradicting the
    # ``conventions/references.md`` spec which requires the browser URL.
    # ``fetch_open_issues`` (``gh issue list --json ...,url``) already returns
    # ``url`` = browser URL, so unconditionally preferring ``html_url`` when
    # present aligns the single-issue and bulk paths.
    if "html_url" in issue and issue.get("html_url"):
        issue["url"] = issue["html_url"]
    return issue


# --- Core actions -----------------------------------------------------------


def ingest_one(
    issue: dict,
    *,
    vbrief_dir: Path,
    status: str,
    repo_url: str,
    dry_run: bool = False,
    existing_refs: dict[int, list[str]] | None = None,
) -> tuple[str, Path | None, str]:
    """Ingest a single issue dict.

    Returns ``(result, path, message)`` where ``result`` is one of ``"created"``,
    ``"dryrun"``, or ``"duplicate"``. ``path`` is the written (or would-be) file
    path; for ``duplicate`` it points at the pre-existing vBRIEF that already
    references this issue.
    """
    number = int(issue["number"])
    # #1096: provenance-aware dedup. Only count vBRIEFs that were actually
    # ingested from issue #N (Origin-narrative-confirmed) -- companion /
    # related-plan / sibling-mention references that merely cite #N do NOT
    # block ingest.
    refs = (
        existing_refs
        if existing_refs is not None
        else _scan_provenance_refs(vbrief_dir)
    )
    if number in refs:
        existing = refs[number][0]
        return "duplicate", vbrief_dir / existing, f"#{number} already ingested at {existing}"

    vbrief, folder = _build_issue_vbrief(issue, status, repo_url)
    filename = _target_filename(number, str(issue.get("title", "")))
    target = vbrief_dir / folder / filename

    if dry_run:
        return "dryrun", target, f"DRY-RUN would write {folder}/{filename}"

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(vbrief, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return "created", target, f"CREATED {folder}/{filename}"


def ingest_bulk(
    issues: list[dict],
    *,
    vbrief_dir: Path,
    status: str,
    repo_url: str,
    label: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Ingest a list of issues.

    Filters by ``label`` first (if provided), then delegates to
    ``ingest_one`` for each remaining issue. Returns a summary dict:
    ``{"created": [...], "duplicate": [...], "dryrun": [...], "total": N}``.
    """
    if label:
        filtered = []
        for issue in issues:
            for lbl in issue.get("labels", []) or []:
                name = lbl.get("name") if isinstance(lbl, dict) else str(lbl)
                if name == label:
                    filtered.append(issue)
                    break
        issues = filtered

    # #1096: provenance-aware dedup. See :func:`_scan_provenance_refs`.
    refs = _scan_provenance_refs(vbrief_dir)

    # Values are list[str] for the three bucket keys and int for "total",
    # hence the union annotation.
    summary: dict[str, list[str] | int] = {"created": [], "duplicate": [], "dryrun": []}
    for issue in issues:
        result, path, _msg = ingest_one(
            issue,
            vbrief_dir=vbrief_dir,
            status=status,
            repo_url=repo_url,
            dry_run=dry_run,
            existing_refs=refs,
        )
        summary[result].append(str(path.relative_to(vbrief_dir)) if path else "")
        # After a real write the refs map would now contain this number;
        # update in place so duplicates inside the same batch are detected.
        if result == "created":
            refs.setdefault(int(issue["number"]), []).append(
                str(path.relative_to(vbrief_dir))
            )

    summary["total"] = len(issues)
    return summary


# --- CLI --------------------------------------------------------------------


def _resolve_repo_url(repo: str) -> str:
    """Produce a browser URL from an OWNER/REPO pair (or empty if none)."""
    if not repo:
        return ""
    if repo.startswith(("http://", "https://")):
        return repo.rstrip("/")
    if re.match(r"^[^/]+/[^/]+$", repo):
        return f"https://github.com/{repo}"
    return ""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Ingest GitHub issues as scope vBRIEFs in vbrief/ lifecycle folders.",
    )
    parser.add_argument(
        "number",
        nargs="?",
        type=int,
        help="GitHub issue number to ingest (single-issue mode)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Bulk mode -- ingest all open issues (optionally filtered by --label)",
    )
    parser.add_argument(
        "--label",
        default=None,
        help="Only ingest issues carrying this label (bulk mode)",
    )
    parser.add_argument(
        "--status",
        default="proposed",
        choices=INGEST_STATUSES,
        help="Target lifecycle folder / plan.status (default: proposed)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be written without creating files",
    )
    parser.add_argument(
        "--vbrief-dir",
        default="./vbrief",
        help="Path to vbrief/ directory (default: ./vbrief)",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help=(
            "GitHub repo in OWNER/REPO format. Highest precedence; beats "
            "$DEFT_PROJECT_REPO and git-remote detection. Without a flag, "
            "env var, or git remote in the project root the script FAILS "
            "loudly rather than silently falling back to deft's own remote "
            "(#538)."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help=(
            "Consumer project root. Used as CWD for git-remote detection "
            "so ``gh`` / ``git`` queries target the consumer repo, not "
            "deftai/directive (#538)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.number is None and not args.all:
        parser.error("Provide an issue number or --all")

    if args.number is not None and args.all:
        parser.error("Use either a single issue number OR --all, not both")

    vbrief_dir = Path(args.vbrief_dir).resolve()
    if not vbrief_dir.exists():
        vbrief_dir.mkdir(parents=True, exist_ok=True)

    project_root = resolve_project_root(args.project_root)
    repo = resolve_project_repo(args.repo, project_root=project_root)
    # Fall back to the legacy CWD-scoped ``detect_repo`` only when no
    # project root could be inferred; that path still exists because
    # some in-process test suites monkeypatch ``detect_repo`` directly.
    if not repo:
        repo = detect_repo()
    if not repo:
        print(
            "Error: could not detect repo. "
            "Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from "
            "a directory tree whose git remote origin is the consumer "
            "repo (#538).",
            file=sys.stderr,
        )
        return 2
    repo_url = _resolve_repo_url(repo)

    if args.all:
        issues = fetch_open_issues(repo, cwd=project_root)
        if issues is None:
            return 2
        summary = ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status=args.status,
            repo_url=repo_url,
            label=args.label,
            dry_run=args.dry_run,
        )
        print(
            "issue:ingest bulk summary: "
            f"{len(summary['created'])} created, "
            f"{len(summary['duplicate'])} duplicate, "
            f"{len(summary['dryrun'])} dry-run "
            f"(total considered: {summary['total']})"
        )
        for entry in summary["created"]:
            print(f"  CREATED {entry}")
        for entry in summary["dryrun"]:
            print(f"  DRY-RUN {entry}")
        for entry in summary["duplicate"]:
            print(f"  SKIP    {entry} (already has scope vBRIEF)")
        return 0

    # Single-issue mode -- prefer the unified cache (#883/#988) before
    # falling back to a live ``gh api`` round-trip.
    issue = _fetch_issue(repo, args.number, cwd=project_root)
    if issue is None:
        return 2
    result, path, msg = ingest_one(
        issue,
        vbrief_dir=vbrief_dir,
        status=args.status,
        repo_url=repo_url,
        dry_run=args.dry_run,
    )
    print(msg)
    if result == "duplicate":
        return 1
    return 0


def ingest_single_for_accept(
    n: int,
    repo: str,
    *,
    project_root: Path | None = None,
    status: str = "proposed",
    cache_root: Path | None = None,
) -> tuple[str, Path | None]:
    """Ingest a single issue on behalf of ``triage_actions.accept`` (#985).

    The triage skill's contract is that ``task triage:accept`` delegates the
    actual vBRIEF authoring to ``task issue:ingest`` so slug / reference /
    schema rules stay in one place (per ``conventions/references.md`` and
    ``skills/deft-directive-refinement/SKILL.md`` Phase 0 Tier 3). This is
    the importable Python entry point that ``scripts/triage_actions.py::accept``
    calls after the audit-log append succeeds.

    Resolves ``vbrief_dir`` to ``<project_root>/vbrief`` (created on demand)
    and the ``repo_url`` to the canonical browser URL via
    :func:`_resolve_repo_url`. Fetches the issue via :func:`_fetch_issue`
    (cache-first per #988) and writes the vBRIEF via :func:`ingest_one`.

    Returns the ``(result, path)`` tuple from :func:`ingest_one`. Raises
    :class:`RuntimeError` on fetch failure so the caller (``accept``) can
    roll the audit-log entry back.
    """
    root = (project_root or Path.cwd()).resolve()
    vbrief_dir = (root / "vbrief").resolve()
    if not vbrief_dir.exists():
        vbrief_dir.mkdir(parents=True, exist_ok=True)
    repo_url = _resolve_repo_url(repo)
    issue = _fetch_issue(repo, n, cwd=root, cache_root=cache_root)
    if issue is None:
        raise RuntimeError(
            f"failed to fetch GitHub issue #{n} from {repo} "
            "(unified cache miss + live gh api fetch failed; see stderr)"
        )
    result, path, _msg = ingest_one(
        issue,
        vbrief_dir=vbrief_dir,
        status=status,
        repo_url=repo_url,
    )
    return result, path


if __name__ == "__main__":
    raise SystemExit(main())
