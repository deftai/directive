"""Rule renderers + vBRIEF reference extractor for ``scripts/triage_scope.py``.

Extracted from ``scripts/triage_scope.py`` so the parent module stays
under the 1000-line MUST cap from ``coding/coding.md`` once D14 (#1133)
landed the milestone rule type and the ``triageScopeIgnores[]``
foundation. The public surface lives in ``triage_scope``; this module
is the renderer + vBRIEF-reference helper only.

Companion module: scripts/triage_scope.py (re-exports the names below
for back-compat with existing call sites and tests).
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any


def extract_referenced_issues(
    project_root: Path | None = None,
    *,
    lifecycle_folders: tuple[str, ...] = (
        "proposed",
        "pending",
        "active",
        "completed",
        "cancelled",
    ),
) -> dict[str, set[int]]:
    """Walk ``vbrief/<folder>/*.vbrief.json`` and pull referenced issue numbers.

    Returns ``{"any": {...}, "active": {...}}`` -- the per-scope sets
    consumed by the ``referenced-by-vbrief`` evaluator. Used by
    ``triage:scope --list`` to surface how the consumer's vBRIEF graph
    feeds the subscription.
    """
    root = (project_root or Path.cwd()) / "vbrief"
    any_set: set[int] = set()
    active_set: set[int] = set()
    if not root.is_dir():
        return {"any": any_set, "active": active_set}
    for folder in lifecycle_folders:
        folder_path = root / folder
        if not folder_path.is_dir():
            continue
        for vbrief_path in folder_path.glob("*.vbrief.json"):
            try:
                data = json.loads(vbrief_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            plan = data.get("plan") if isinstance(data, dict) else None
            if not isinstance(plan, dict):
                continue
            refs = plan.get("references") or []
            if not isinstance(refs, list):
                continue
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                if ref.get("type") != "x-vbrief/github-issue":
                    continue
                uri = ref.get("uri", "")
                if not isinstance(uri, str):
                    continue
                tail = uri.rstrip("/").rsplit("/", 1)[-1]
                if tail.isdigit():
                    n = int(tail)
                    any_set.add(n)
                    if folder == "active":
                        active_set.add(n)
    return {"any": any_set, "active": active_set}


def render_list(
    rules: Iterable[dict[str, Any]],
    *,
    subscription_hash_fn: Any,
    project_root: Path | None = None,
    is_default: bool = False,
) -> str:
    """Return the human-readable ``triage:scope --list`` recap.

    Format:

        triage:scope effective rules (N):
          1. all-open
          2. labels any-of=[bug, regression]
          3. explicit-watch:
               - #1234  (<note>)
               - #5678  (<note>)
        subscription-hash: <hex>

    A leading ``(default applied)`` annotation is added when the rule
    set is the framework default (``plan.policy.triageScope`` unset).
    Per Decision 4, ``explicit-watch`` entries always print their note
    so future operators understand why a specific issue was pinned.

    ``subscription_hash_fn`` is the parent module's hash callable
    (passed in to avoid a circular import).
    """
    rules = list(rules)
    lines: list[str] = []
    header = f"triage:scope effective rules ({len(rules)}):"
    if is_default:
        header += " (default applied -- plan.policy.triageScope unset)"
    lines.append(header)
    for i, rule in enumerate(rules, start=1):
        lines.extend(_render_rule(i, rule))
    lines.append(f"subscription-hash: {subscription_hash_fn(rules)}")
    return "\n".join(lines)


def render_ignores(ignores: Iterable[dict[str, Any]] | None) -> str:
    """Render the ``plan.policy.triageScopeIgnores[]`` block (D14c / #1182).

    Empty / missing list renders as the canonical ``(none)`` line so the
    operator can distinguish ``ran, no ignores`` from ``ran, ignores
    not surfaced``. The output is grouped by ignore-entry kind (label /
    milestone / author) so a long ignore-list stays scannable.
    """
    entries = list(ignores or [])
    lines: list[str] = [
        f"triage:scope ignores ({len(entries)} entries):",
    ]
    if not entries:
        lines.append("  (none) -- task triage:scope -- --ignore-label=<L> to add")
        return "\n".join(lines)
    labels: list[str] = []
    milestones: list[str] = []
    authors: list[str] = []
    other: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            other.append(repr(entry))
            continue
        rule = entry.get("rule")
        if rule == "author":
            any_of = entry.get("any-of") or []
            if isinstance(any_of, list):
                authors.extend(
                    str(name)
                    for name in any_of
                    if isinstance(name, str) and name
                )
            continue
        label = entry.get("label")
        if isinstance(label, str) and label:
            labels.append(label)
            continue
        milestone = entry.get("milestone")
        if isinstance(milestone, str) and milestone:
            milestones.append(milestone)
            continue
        other.append(repr(entry))
    if labels:
        lines.append(f"  labels:     {sorted(labels)}")
    if milestones:
        lines.append(f"  milestones: {sorted(milestones)}")
    if authors:
        lines.append(f"  authors:    {sorted(authors)}")
    if other:
        lines.append(f"  unrecognised: {other}")
    return "\n".join(lines)


def _render_rule(idx: int, rule: dict[str, Any]) -> list[str]:
    kind = rule.get("rule", "<unknown>")
    if kind == "all-open":
        return [f"  {idx}. all-open"]
    if kind == "labels":
        if "any-of" in rule:
            return [f"  {idx}. labels any-of={sorted(rule['any-of'])}"]
        if "all-of" in rule:
            return [f"  {idx}. labels all-of={sorted(rule['all-of'])}"]
        return [f"  {idx}. labels (malformed)"]
    if kind == "milestone":
        # D14 (#1133) v1 exact-match + D14b (#1181) any-of / is-open
        # variants render distinctly so the operator can confirm which
        # branch their subscription actually uses.
        if "name" in rule:
            return [f"  {idx}. milestone name={rule.get('name', '?')!r}"]
        if "any-of" in rule:
            raw = rule.get("any-of") or []
            return [
                f"  {idx}. milestone any-of={sorted(raw) if isinstance(raw, list) else raw}"
            ]
        if rule.get("is-open") is True:
            return [f"  {idx}. milestone is-open=true (currently-open upstream)"]
        return [f"  {idx}. milestone (malformed)"]
    if kind in {"opened-since", "updated-since"}:
        return [f"  {idx}. {kind} duration={rule.get('duration', '?')}"]
    if kind == "referenced-by-vbrief":
        return [f"  {idx}. referenced-by-vbrief scope={rule.get('scope', '?')}"]
    if kind == "sliced-from":
        return [f"  {idx}. sliced-from scope={rule.get('scope', '?')}"]
    if kind == "explicit-watch":
        out = [f"  {idx}. explicit-watch:"]
        for entry in rule.get("issues", []):
            if not isinstance(entry, dict):
                continue
            n = entry.get("n")
            note = entry.get("note", "")
            out.append(f"       - #{n}  ({note})")
        return out
    return [f"  {idx}. {kind} (unknown rule type)"]
