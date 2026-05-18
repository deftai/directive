"""``plan.policy.triageScopeIgnores[]`` validator + resolver (D14 / #1133).

Extracted from ``scripts/triage_scope.py`` so the parent module stays
under the 1000-line MUST cap from ``coding/coding.md`` after D14
landed the milestone rule type AND this ignore-list foundation.

The public surface is re-exported by ``triage_scope`` so existing
call sites (``triage_scope.validate_scope_ignores``,
``triage_scope.resolve_scope_ignores``,
``triage_scope.validate_triage_scope_ignores_on_plan``) keep working
unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

#: Recognised ignore-entry discriminator values (D14 / #1133). Each
#: entry on ``plan.policy.triageScopeIgnores[]`` is a single-key
#: object: either ``{label: <name>}`` or ``{milestone: <name>}``.
#: Future variants (``author``, ``sunset-on``, ...) are D14c / #1182
#: scope -- v1 accepts ONLY these two keys.
VALID_IGNORE_KEYS: frozenset[str] = frozenset({"label", "milestone"})

_PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"


def validate_scope_ignores(ignores: Any) -> tuple[list[str], list[str]]:
    """Validate a ``plan.policy.triageScopeIgnores`` payload.

    Returns ``(errors, warnings)``. ``errors`` is empty on success.
    Each entry is a single-key object: either ``{label: <name>}`` or
    ``{milestone: <name>}``. v1 (D14 / #1133) ships these two
    variants; future variants (``author``, ``sunset-on``, ...) are
    D14c / #1182 scope and surface as warnings rather than errors so
    a forward-compat consumer's config does not break on rollback.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if ignores is None:
        return errors, warnings
    if not isinstance(ignores, list):
        errors.append(
            "plan.policy.triageScopeIgnores must be a list of "
            f"{{label|milestone: <name>}} objects; got {type(ignores).__name__}"
        )
        return errors, warnings
    for i, entry in enumerate(ignores):
        prefix = f"plan.policy.triageScopeIgnores[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix} must be an object, got {type(entry).__name__}")
            continue
        known = sorted(k for k in entry if k in VALID_IGNORE_KEYS)
        unknown = sorted(k for k in entry if k not in VALID_IGNORE_KEYS)
        if not known:
            errors.append(
                f"{prefix} must have a 'label' or 'milestone' key "
                f"(v1 keys: {sorted(VALID_IGNORE_KEYS)})"
            )
            continue
        if len(known) > 1:
            errors.append(
                f"{prefix}: 'label' and 'milestone' are mutually exclusive"
            )
            continue
        if unknown:
            warnings.append(
                f"{prefix}: ignoring unrecognised keys {unknown} "
                "(D14c / #1182 may add new ignore-entry variants)"
            )
        key = known[0]
        value = entry.get(key)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{prefix}.{key} must be a non-empty string")
    return errors, warnings


def _load_project_definition(project_root: Path | None) -> dict[str, Any] | None:
    """Load PROJECT-DEFINITION.vbrief.json (None on missing/malformed)."""
    root = project_root or Path.cwd()
    path = root / _PROJECT_DEFINITION_REL_PATH
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def resolve_scope_ignores(
    project_root: Path | None = None,
    *,
    project_definition: dict[str, Any] | None = None,
) -> dict[str, set[str]]:
    """Return ``{'labels': set[str], 'milestones': set[str]}`` from PROJECT-DEFINITION.

    Used by the drift detector to suppress label/milestone signals the
    operator explicitly chose to ignore. Unset / missing / non-list
    yields empty sets (the framework default is to surface every drift
    signal until the operator opts out).
    """
    data = (
        project_definition
        if project_definition is not None
        else _load_project_definition(project_root)
    )
    out: dict[str, set[str]] = {"labels": set(), "milestones": set()}
    if not isinstance(data, dict):
        return out
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return out
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return out
    raw = policy.get("triageScopeIgnores")
    if not isinstance(raw, list):
        return out
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        if isinstance(label, str) and label.strip():
            out["labels"].add(label)
        milestone = entry.get("milestone")
        if isinstance(milestone, str) and milestone.strip():
            out["milestones"].add(milestone)
    return out


def validate_triage_scope_ignores_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.triageScopeIgnores`` (#1133).

    Returns formatted error strings prefixed with ``<filepath>:`` so
    ``vbrief_validate.validate_project_definition`` can splice them in.
    Unset / missing payload returns an empty list.
    """
    out: list[str] = []
    policy = plan.get("policy") if isinstance(plan, dict) else None
    raw = policy.get("triageScopeIgnores") if isinstance(policy, dict) else None
    if raw is None:
        return out
    errors, _warnings = validate_scope_ignores(raw)
    for err in errors:
        out.append(f"{filepath}: {err} (#1133)")
    return out
