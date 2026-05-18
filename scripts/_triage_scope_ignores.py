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
import re
from pathlib import Path
from typing import Any

#: Index regex used by :func:`validate_triage_scope_ignores_on_plan` to
#: associate each error message back to the raw entry that produced it.
#: The validator prefixes every error with
#: ``plan.policy.triageScopeIgnores[<i>]`` so the wrapper can look up the
#: raw entry by integer index and decide the pointer (#1133 vs #1182)
#: from the entry's *shape* rather than from a substring match on the
#: error text -- shape inspection is robust to future error-wording
#: edits, substring matching is not.
_INDEXED_ERROR_RE: re.Pattern[str] = re.compile(
    r"^plan\.policy\.triageScopeIgnores\[(\d+)\]"
)

#: Recognised single-key ignore-entry discriminator values (D14 / #1133).
#: Each legacy entry on ``plan.policy.triageScopeIgnores[]`` is a single-key
#: object: either ``{label: <name>}`` or ``{milestone: <name>}``.
#: D14c / #1182 adds the discriminated rule-shape entry ``{rule: <kind>,
#: ...}`` for kinds that cannot collapse to a single-name string -- see
#: :data:`VALID_IGNORE_RULES` below.
VALID_IGNORE_KEYS: frozenset[str] = frozenset({"label", "milestone"})

#: Recognised ``rule`` discriminator values on the D14c / #1182
#: rule-shaped ignore entry ``{rule: <kind>, any-of: [<str>, ...]}``.
#: v1 ships ``author`` only; future variants (``sunset-on``,
#: ``body-text``, ...) extend this set.
VALID_IGNORE_RULES: frozenset[str] = frozenset({"author"})

_PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"


def validate_scope_ignores(ignores: Any) -> tuple[list[str], list[str]]:
    """Validate a ``plan.policy.triageScopeIgnores`` payload.

    Returns ``(errors, warnings)``. ``errors`` is empty on success.

    Two entry shapes are accepted:

    * Single-key entries (D14 / #1133): ``{label: <name>}`` or
      ``{milestone: <name>}``. Value MUST be a non-empty string.
    * Rule-shaped entries (D14c / #1182): ``{rule: <kind>, any-of:
      [<str>, ...]}``. v1 supports ``rule: author`` only; ``any-of``
      MUST be a non-empty list of non-empty strings.

    Unrecognised top-level keys on a single-key entry, or unknown
    ``rule`` discriminators on a rule-shaped entry, surface as
    warnings rather than errors so a forward-compat consumer's config
    does not break on rollback.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if ignores is None:
        return errors, warnings
    if not isinstance(ignores, list):
        errors.append(
            "plan.policy.triageScopeIgnores must be a list of "
            "{label|milestone: <name>} or {rule: <kind>, any-of: [...]} "
            f"objects; got {type(ignores).__name__}"
        )
        return errors, warnings
    for i, entry in enumerate(ignores):
        prefix = f"plan.policy.triageScopeIgnores[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix} must be an object, got {type(entry).__name__}")
            continue
        if "rule" in entry:
            _validate_rule_ignore(entry, prefix, errors, warnings)
            continue
        _validate_single_key_ignore(entry, prefix, errors, warnings)
    return errors, warnings


def _validate_single_key_ignore(
    entry: dict[str, Any],
    prefix: str,
    errors: list[str],
    warnings: list[str],
) -> None:
    """Validate a D14-era single-key ignore entry."""
    known = sorted(k for k in entry if k in VALID_IGNORE_KEYS)
    unknown = sorted(k for k in entry if k not in VALID_IGNORE_KEYS)
    if not known:
        errors.append(
            f"{prefix} must have a 'label' / 'milestone' key OR a "
            f"'rule' discriminator (v1 single-key keys: {sorted(VALID_IGNORE_KEYS)}; "
            f"v1 rule kinds: {sorted(VALID_IGNORE_RULES)})"
        )
        return
    if len(known) > 1:
        errors.append(
            f"{prefix}: 'label' and 'milestone' are mutually exclusive"
        )
        return
    if unknown:
        warnings.append(
            f"{prefix}: ignoring unrecognised keys {unknown} "
            "(forward-compat: future ignore-entry variants will surface here)"
        )
    key = known[0]
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{prefix}.{key} must be a non-empty string")


def _validate_rule_ignore(
    entry: dict[str, Any],
    prefix: str,
    errors: list[str],
    warnings: list[str],
) -> None:
    """Validate a D14c / #1182 rule-shaped ignore entry."""
    kind = entry.get("rule")
    if not isinstance(kind, str) or not kind.strip():
        errors.append(f"{prefix}.rule must be a non-empty string")
        return
    if kind not in VALID_IGNORE_RULES:
        # The wrapper :func:`validate_triage_scope_ignores_on_plan` appends
        # the canonical ``(#1182)`` pointer; do NOT inline it here or the
        # error renders with two conflicting pointers on one line.
        errors.append(
            f"{prefix}.rule {kind!r} is not a recognised ignore-rule "
            f"kind; expected one of {sorted(VALID_IGNORE_RULES)}"
        )
        return
    # Per-kind body shape. v1 ships ``author`` only; the ``any-of``
    # contract is shared so future kinds can re-use this validator.
    if kind == "author":
        any_of = entry.get("any-of")
        if not isinstance(any_of, list) or not any_of:
            errors.append(
                f"{prefix}.author requires 'any-of' as a non-empty list "
                "of GitHub login strings (e.g. ['dependabot[bot]'])"
            )
            return
        for j, name in enumerate(any_of):
            if not isinstance(name, str) or not name.strip():
                errors.append(
                    f"{prefix}.author.any-of[{j}] must be a non-empty string"
                )
        extra = sorted(k for k in entry if k not in {"rule", "any-of"})
        if extra:
            warnings.append(
                f"{prefix}.author: ignoring unrecognised keys {extra} "
                "(forward-compat: future author-rule variants will surface here)"
            )


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
    """Return ``{'labels', 'milestones', 'authors'}`` sets from PROJECT-DEFINITION.

    Used by the drift detector to suppress label / milestone / author
    signals the operator explicitly chose to ignore. Unset / missing /
    non-list yields empty sets (the framework default is to surface
    every drift signal until the operator opts out).

    The ``authors`` key was added in D14c (#1182) when the rule-shaped
    ``{rule: author, any-of: [<login>, ...]}`` ignore entry shipped;
    callers MUST tolerate the new key even when they only consume
    labels / milestones.
    """
    data = (
        project_definition
        if project_definition is not None
        else _load_project_definition(project_root)
    )
    out: dict[str, set[str]] = {
        "labels": set(),
        "milestones": set(),
        "authors": set(),
    }
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
        # D14 single-key shape.
        label = entry.get("label")
        if isinstance(label, str) and label.strip():
            out["labels"].add(label)
        milestone = entry.get("milestone")
        if isinstance(milestone, str) and milestone.strip():
            out["milestones"].add(milestone)
        # D14c rule-shaped entries.
        rule = entry.get("rule")
        if rule == "author":
            any_of = entry.get("any-of")
            if isinstance(any_of, list):
                for name in any_of:
                    if isinstance(name, str) and name.strip():
                        out["authors"].add(name)
    return out


def validate_triage_scope_ignores_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.triageScopeIgnores`` (#1133 / #1182).

    Returns formatted error strings prefixed with ``<filepath>:`` so
    ``vbrief_validate.validate_project_definition`` can splice them in.
    Unset / missing payload returns an empty list. Errors carry the
    ``(#1133)`` pointer for D14 single-key shape errors and ``(#1182)``
    for any error on a D14c rule-shape entry (``{rule: <kind>, ...}``).

    The pointer is resolved by inspecting each entry's *shape* (presence
    of a top-level ``rule`` key) rather than substring-matching the
    error text -- substring heuristics were fragile against rule-key
    error messages that did not happen to mention ``author`` (e.g.
    ``{rule: ""}`` -> ``...rule must be a non-empty string``,
    ``{rule: "sunset-on"}`` -> ``...rule 'sunset-on' is not a
    recognised ignore-rule kind...``). The shape check is robust to
    future error-wording edits AND covers the entire rule-shape error
    surface uniformly.
    """
    out: list[str] = []
    policy = plan.get("policy") if isinstance(plan, dict) else None
    raw = policy.get("triageScopeIgnores") if isinstance(policy, dict) else None
    if raw is None:
        return out
    errors, _warnings = validate_scope_ignores(raw)
    raw_list = raw if isinstance(raw, list) else []
    for err in errors:
        out.append(f"{filepath}: {err} ({_pointer_for_error(err, raw_list)})")
    return out


def _pointer_for_error(err: str, raw_list: list[Any]) -> str:
    """Resolve the issue-tracker pointer for a single validator error.

    Strategy: extract the entry index ``[i]`` from the canonical error
    prefix and look the entry up in ``raw_list``. An entry carrying a
    top-level ``rule`` key is a D14c rule-shape entry (#1182); anything
    else is a D14 single-key entry (#1133). Errors with no parseable
    index (e.g. the top-level ``must be a list`` error) fall through to
    #1133.
    """
    match = _INDEXED_ERROR_RE.match(err)
    if match is not None:
        idx = int(match.group(1))
        if 0 <= idx < len(raw_list):
            entry = raw_list[idx]
            if isinstance(entry, dict) and "rule" in entry:
                return "#1182"
    return "#1133"
