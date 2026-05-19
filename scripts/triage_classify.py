#!/usr/bin/env python3
"""triage_classify.py -- auto-classification for cached upstream issues (#1129 / D10).

Wave-1 D10 child of umbrella #1119. Anchored to Current Shape comment
4471901622 on issue #1129. Ships consumer-agnostic primitives only:

* :data:`UNIVERSAL_RULES` -- four hardcoded framework rules (Decision 1):
    1. Body contains any hold-marker phrase  -> defer ``hold marker in body``.
    2. Closed upstream AND never triaged     -> archive ``closed upstream and
       never triaged``.
    3. No activity > 90 days AND body absent/<50 chars
                                             -> defer ``dormant; needs AC
                                                refresh``.
    4. Already referenced from pending/active vBRIEFs
                                             -> accept ``already referenced
                                                from a scope vBRIEF``.
* :data:`DEFAULT_HOLD_MARKERS` -- four default hold-marker phrases
  (``do not implement`` / ``BLOCKED`` / ``HOLDING`` /
  ``Holding / capture only``). Overridable per-consumer via
  ``plan.policy.triageHoldMarkers[]`` (Decision 3).
* ``plan.policy.triageAutoClassify[]`` typed-policy schema (Decision 2):

  .. code-block:: json

      {
        "match": {
          "labels": {"any-of": [...]} | {"all-of": [...]},
          "body-text": {"any-of": [...]},
          "state": "open" | "closed",
          "age-days": {"gt": N}
        },
        "action": "defer" | "archive" | "escalate" | "accept",
        "reason": "<text>",
        "resume-on": "<D3 resume condition>"   // optional
      }

  Framework default for the typed array = **empty** (Decision 2). The four
  universal rules above are HARDCODED and consumer-specific label rules
  layer on top.

* Order of evaluation: framework universal rules first, then consumer
  rules in declared order; **first match wins** (Decision 2).

Public API:

* :func:`validate_classify_rules` / :func:`validate_hold_markers`
* :func:`resolve_classify_rules` / :func:`resolve_hold_markers`
* :func:`classify_issue`
* :func:`validate_triage_auto_classify_on_plan` / :func:`validate_triage_hold_markers_on_plan`
  -- vbrief_validate hooks

§12 boundary: this module ships ZERO deft-specific label / milestone /
state values. Consumer-specific label rules live OUTSIDE the framework
(see #1186 consumer-example child of #1119).
"""

from __future__ import annotations

import contextlib
import json
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked as
# ``python scripts/triage_classify.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the recap printed by ``--list`` includes the
# checkmark glyphs that cp1252 cannot encode.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Filesystem-relative location of the PROJECT-DEFINITION vBRIEF.
PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"

#: Threshold in days for the "dormant" universal rule (Decision 1).
DORMANT_AGE_DAYS: int = 90

#: Threshold in characters for "thin body" used by the dormant rule.
THIN_BODY_THRESHOLD_CHARS: int = 50

#: Default hold-marker phrases (Decision 1 + Decision 3). Consumers may
#: extend this list via ``plan.policy.triageHoldMarkers[]``. Note that
#: the matching is case-INsensitive for the all-lowercase / all-uppercase
#: idioms commonly used in issue bodies.
DEFAULT_HOLD_MARKERS: tuple[str, ...] = (
    "do not implement",
    "BLOCKED",
    "HOLDING",
    "Holding / capture only",
)

#: Recognised action values for a consumer rule.
VALID_ACTIONS: frozenset[str] = frozenset({"defer", "archive", "escalate", "accept"})

#: Recognised state values for the ``match.state`` predicate.
VALID_STATES: frozenset[str] = frozenset({"open", "closed"})

#: Internal discriminators for the four framework universal rules. These
#: are NOT exposed in the consumer schema; the validator below rejects
#: any consumer rule whose ``match`` block omits the typed predicates.
_UNIVERSAL_RULE_KINDS: tuple[str, ...] = (
    "universal:hold-marker",
    "universal:closed-never-triaged",
    "universal:dormant-thin-body",
    "universal:vbrief-referenced",
)


@dataclass(frozen=True)
class ClassificationResult:
    """Outcome of :func:`classify_issue` when a rule matches.

    ``rule_source`` is ``"framework"`` for the four hardcoded universal
    rules and ``"consumer"`` for rules pulled from
    ``plan.policy.triageAutoClassify[]``. ``rule_index`` is the 0-based
    position within the resolved rule list (universal rules occupy
    indices 0..3; consumer rules start at index 4).
    """

    action: str
    reason: str
    rule_index: int
    rule_source: str
    rule_kind: str
    resume_on: str | None = None


# ---------------------------------------------------------------------------
# Framework universal rules (Decision 1) -- HARDCODED, consumer-agnostic.
# ---------------------------------------------------------------------------

#: The four framework universal rules. Encoded as opaque ``rule`` objects
#: so they share the same dispatch surface as consumer rules; the
#: discriminator strings live in :data:`_UNIVERSAL_RULE_KINDS` and are
#: NOT writable from consumer config (the validator rejects any consumer
#: rule whose discriminator starts with ``universal:``).
UNIVERSAL_RULES: tuple[dict[str, Any], ...] = (
    {
        "rule": "universal:hold-marker",
        "action": "defer",
        "reason": "hold marker in body",
    },
    {
        "rule": "universal:closed-never-triaged",
        "action": "archive",
        "reason": "closed upstream and never triaged",
    },
    {
        "rule": "universal:dormant-thin-body",
        "action": "defer",
        "reason": "dormant; needs AC refresh",
    },
    {
        "rule": "universal:vbrief-referenced",
        "action": "accept",
        "reason": "already referenced from a scope vBRIEF",
    },
)


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _parse_iso(stamp: str) -> datetime:
    text = stamp.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def _ts_to_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = _parse_iso(value)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


# ---------------------------------------------------------------------------
# Schema validation -- consumer rules
# ---------------------------------------------------------------------------


def validate_classify_rules(rules: Any) -> tuple[list[str], list[str]]:
    """Validate a ``plan.policy.triageAutoClassify`` payload.

    Returns ``(errors, warnings)``. ``errors`` is empty on success. The
    contract follows the same shape as ``triage_scope.validate_scope_rules``
    so call-sites can splice the two error lists together.

    Validation rules (Decision 2):

    * The top-level value MUST be a list (omission is fine and resolves
      to an empty consumer rule set via :func:`resolve_classify_rules`).
    * Each rule MUST be an object with at minimum ``match``, ``action``,
      and ``reason`` keys.
    * The ``match`` block MUST contain at least one recognised
      predicate (``labels``, ``body-text``, ``state``, ``age-days``);
      an empty ``match`` (matches every issue) is rejected as ambiguous.
    * Per-predicate field shape is checked (label list, body-text list,
      state enum, age-days ``{gt: N}``).
    * ``action`` MUST be one of :data:`VALID_ACTIONS`.
    * ``reason`` MUST be a non-empty string.
    * ``resume-on`` is optional but, when present, MUST be a non-empty
      string (a D3 resume-condition expression).
    * Any ``rule`` discriminator starting with ``universal:`` is REJECTED
      because the framework universal rules are hardcoded and cannot be
      re-bound from consumer config.
    """
    errors: list[str] = []
    warnings: list[str] = []

    if rules is None:
        return errors, warnings

    if not isinstance(rules, list):
        errors.append(
            "plan.policy.triageAutoClassify must be a list of rule objects; "
            f"got {type(rules).__name__}"
        )
        return errors, warnings

    for i, rule in enumerate(rules):
        prefix = f"plan.policy.triageAutoClassify[{i}]"
        if not isinstance(rule, dict):
            errors.append(f"{prefix} must be an object, got {type(rule).__name__}")
            continue
        _validate_consumer_rule(rule, prefix, errors, warnings)

    return errors, warnings


def _validate_consumer_rule(
    rule: dict[str, Any], prefix: str, errors: list[str], warnings: list[str]
) -> None:
    # Reject re-binding the universal discriminators.
    kind = rule.get("rule")
    if isinstance(kind, str) and kind.startswith("universal:"):
        errors.append(
            f"{prefix}.rule {kind!r} is reserved for framework universal "
            "rules (#1129 Decision 1); consumer rules MUST omit the "
            "'rule' field or use a non-'universal:' discriminator"
        )
        return

    # action
    action = rule.get("action")
    if not isinstance(action, str) or action not in VALID_ACTIONS:
        errors.append(
            f"{prefix}.action must be one of {sorted(VALID_ACTIONS)}; "
            f"got {action!r}"
        )

    # reason
    reason = rule.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        errors.append(f"{prefix}.reason must be a non-empty string")

    # resume-on (optional)
    if "resume-on" in rule:
        ro = rule["resume-on"]
        if not isinstance(ro, str) or not ro.strip():
            errors.append(f"{prefix}.resume-on must be a non-empty string when set")

    # match block
    match = rule.get("match")
    if not isinstance(match, dict):
        errors.append(f"{prefix}.match must be an object")
        return

    recognised_predicates = {"labels", "body-text", "state", "age-days"}
    extra = sorted(set(match) - recognised_predicates)
    if extra:
        warnings.append(
            f"{prefix}.match: ignoring unrecognised predicate(s) {extra}; "
            f"expected one or more of {sorted(recognised_predicates)}"
        )
    used_predicates = sorted(set(match) & recognised_predicates)
    if not used_predicates:
        errors.append(
            f"{prefix}.match requires at least one of "
            f"{sorted(recognised_predicates)}"
        )
        return

    if "labels" in match:
        _validate_labels_predicate(match["labels"], f"{prefix}.match.labels", errors)
    if "body-text" in match:
        _validate_body_text_predicate(
            match["body-text"], f"{prefix}.match.body-text", errors
        )
    if "state" in match:
        state = match["state"]
        if state not in VALID_STATES:
            errors.append(
                f"{prefix}.match.state must be one of {sorted(VALID_STATES)}; "
                f"got {state!r}"
            )
    if "age-days" in match:
        _validate_age_days_predicate(
            match["age-days"], f"{prefix}.match.age-days", errors
        )


def _validate_labels_predicate(value: Any, prefix: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{prefix} must be an object")
        return
    any_of = value.get("any-of")
    all_of = value.get("all-of")
    if any_of is None and all_of is None:
        errors.append(f"{prefix} requires 'any-of' or 'all-of'")
        return
    if any_of is not None and all_of is not None:
        errors.append(f"{prefix}: 'any-of' and 'all-of' are mutually exclusive")
        return
    target = any_of if any_of is not None else all_of
    which = "any-of" if any_of is not None else "all-of"
    if not isinstance(target, list) or not target:
        errors.append(f"{prefix}.{which} must be a non-empty list of strings")
        return
    for j, label in enumerate(target):
        if not isinstance(label, str) or not label:
            errors.append(f"{prefix}.{which}[{j}] must be a non-empty string")


def _validate_body_text_predicate(value: Any, prefix: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{prefix} must be an object")
        return
    any_of = value.get("any-of")
    if not isinstance(any_of, list) or not any_of:
        errors.append(f"{prefix}.any-of must be a non-empty list of strings")
        return
    for j, needle in enumerate(any_of):
        if not isinstance(needle, str) or not needle:
            errors.append(f"{prefix}.any-of[{j}] must be a non-empty string")


def _validate_age_days_predicate(value: Any, prefix: str, errors: list[str]) -> None:
    if not isinstance(value, dict):
        errors.append(f"{prefix} must be an object")
        return
    if "gt" not in value:
        errors.append(f"{prefix} requires a 'gt' integer threshold")
        return
    gt = value["gt"]
    if (
        not isinstance(gt, int)
        or isinstance(gt, bool)
        or gt < 0
    ):
        errors.append(f"{prefix}.gt must be a non-negative integer; got {gt!r}")


# ---------------------------------------------------------------------------
# Schema validation -- hold markers
# ---------------------------------------------------------------------------


def validate_hold_markers(markers: Any) -> tuple[list[str], list[str]]:
    """Validate a ``plan.policy.triageHoldMarkers`` payload.

    Returns ``(errors, warnings)``. An unset / missing list resolves to
    :data:`DEFAULT_HOLD_MARKERS` (Decision 3). An EMPTY list is accepted
    and silences the hold-marker universal rule entirely (operators who
    want zero hold-marker matching can set ``triageHoldMarkers: []``).
    """
    errors: list[str] = []
    warnings: list[str] = []
    if markers is None:
        return errors, warnings
    if not isinstance(markers, list):
        errors.append(
            "plan.policy.triageHoldMarkers must be a list of strings; "
            f"got {type(markers).__name__}"
        )
        return errors, warnings
    for i, marker in enumerate(markers):
        if not isinstance(marker, str) or not marker.strip():
            errors.append(
                f"plan.policy.triageHoldMarkers[{i}] must be a non-empty string"
            )
    return errors, warnings


# ---------------------------------------------------------------------------
# Resolve rules + hold markers from PROJECT-DEFINITION
# ---------------------------------------------------------------------------


def project_definition_path(project_root: Path | None = None) -> Path:
    root = project_root or Path.cwd()
    return root / PROJECT_DEFINITION_REL_PATH


def _load_project_definition(project_root: Path | None = None) -> dict[str, Any] | None:
    path = project_definition_path(project_root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _consumer_rules_from_project(
    data: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return []
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return []
    raw = policy.get("triageAutoClassify")
    if not isinstance(raw, list):
        return []
    return [dict(r) for r in raw if isinstance(r, dict)]


def _hold_markers_from_project(
    data: dict[str, Any] | None,
) -> list[str] | None:
    """Return the raw hold-marker list from PROJECT-DEFINITION, or None
    when unset / non-list. ``None`` means "use defaults"; an EMPTY list
    means "silence the hold-marker rule" (Decision 3 explicit opt-out).
    """
    if not isinstance(data, dict):
        return None
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return None
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return None
    raw = policy.get("triageHoldMarkers")
    if not isinstance(raw, list):
        return None
    return [m for m in raw if isinstance(m, str) and m.strip()]


def resolve_classify_rules(
    project_root: Path | None = None,
    *,
    project_definition: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return ``UNIVERSAL_RULES`` followed by the consumer rules.

    Order of evaluation (Decision 2): framework universal rules first,
    then consumer rules in declared order. The returned list is a fresh
    shallow copy so callers can mutate it without disturbing the
    framework constants.
    """
    data = (
        project_definition
        if project_definition is not None
        else _load_project_definition(project_root)
    )
    consumer = _consumer_rules_from_project(data)
    return [dict(r) for r in UNIVERSAL_RULES] + consumer


def resolve_hold_markers(
    project_root: Path | None = None,
    *,
    project_definition: dict[str, Any] | None = None,
) -> list[str]:
    """Return the effective hold-marker list (defaults + consumer override)."""
    data = (
        project_definition
        if project_definition is not None
        else _load_project_definition(project_root)
    )
    raw = _hold_markers_from_project(data)
    if raw is None:
        return list(DEFAULT_HOLD_MARKERS)
    return list(raw)


# ---------------------------------------------------------------------------
# Issue field accessors
# ---------------------------------------------------------------------------


def _issue_number(issue: dict[str, Any]) -> int:
    n = issue.get("number")
    return int(n) if isinstance(n, int) and not isinstance(n, bool) else 0


def _issue_state(issue: dict[str, Any]) -> str:
    state = issue.get("state", "open")
    return state if isinstance(state, str) else "open"


def _issue_body(issue: dict[str, Any]) -> str:
    body = issue.get("body")
    if isinstance(body, str):
        return body
    return ""


def _issue_label_names(issue: dict[str, Any]) -> set[str]:
    raw = issue.get("labels", [])
    names: set[str] = set()
    if not isinstance(raw, list):
        return names
    for item in raw:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str):
                names.add(name)
        elif isinstance(item, str):
            names.add(item)
    return names


def _issue_updated_at(issue: dict[str, Any]) -> datetime | None:
    return _ts_to_dt(issue.get("updated_at"))


def _issue_created_at(issue: dict[str, Any]) -> datetime | None:
    return _ts_to_dt(issue.get("created_at"))


# ---------------------------------------------------------------------------
# Universal rule predicates
# ---------------------------------------------------------------------------


def _matches_hold_marker(
    issue: dict[str, Any], hold_markers: Iterable[str]
) -> bool:
    """True when the issue body contains any hold-marker phrase.

    Matching is case-INsensitive so an issue body that writes
    ``do not implement`` in any casing trips the rule. The default
    markers include both an all-caps idiom (``BLOCKED``) and a sentence-
    cased phrase (``Holding / capture only``) so consumers writing
    in their natural style are still caught.
    """
    body = _issue_body(issue)
    if not body:
        return False
    haystack = body.casefold()
    for marker in hold_markers:
        if not marker:
            continue
        if marker.casefold() in haystack:
            return True
    return False


def _matches_closed_never_triaged(
    issue: dict[str, Any], *, has_triage_decision: bool
) -> bool:
    return _issue_state(issue) == "closed" and not has_triage_decision


def _matches_dormant_thin_body(
    issue: dict[str, Any], *, now: datetime, age_days: int = DORMANT_AGE_DAYS
) -> bool:
    if _issue_state(issue) != "open":
        return False
    updated = _issue_updated_at(issue) or _issue_created_at(issue)
    if updated is None:
        return False
    if (now - updated) <= timedelta(days=age_days):
        return False
    body = _issue_body(issue).strip()
    return len(body) < THIN_BODY_THRESHOLD_CHARS


def _matches_vbrief_referenced(
    issue: dict[str, Any], *, vbrief_referenced: set[int] | None
) -> bool:
    if not vbrief_referenced:
        return False
    return _issue_number(issue) in vbrief_referenced


# ---------------------------------------------------------------------------
# Consumer rule predicate
# ---------------------------------------------------------------------------


def _consumer_rule_matches(
    rule: dict[str, Any], issue: dict[str, Any], *, now: datetime
) -> bool:
    match = rule.get("match")
    if not isinstance(match, dict):
        return False

    if "state" in match:
        wanted = match["state"]
        if _issue_state(issue) != wanted:
            return False

    if "labels" in match:
        labels_pred = match["labels"]
        names = _issue_label_names(issue)
        any_of = labels_pred.get("any-of") if isinstance(labels_pred, dict) else None
        all_of = labels_pred.get("all-of") if isinstance(labels_pred, dict) else None
        if any_of is not None:
            if not any(label in names for label in any_of):
                return False
        elif all_of is not None:
            if not all(label in names for label in all_of):
                return False
        else:
            return False

    if "body-text" in match:
        body_pred = match["body-text"]
        any_of = body_pred.get("any-of") if isinstance(body_pred, dict) else None
        if not isinstance(any_of, list) or not any_of:
            return False
        body = _issue_body(issue).casefold()
        if not any(
            isinstance(n, str) and n and n.casefold() in body for n in any_of
        ):
            return False

    if "age-days" in match:
        pred = match["age-days"]
        gt = pred.get("gt") if isinstance(pred, dict) else None
        if not isinstance(gt, int) or isinstance(gt, bool):
            return False
        updated = _issue_updated_at(issue) or _issue_created_at(issue)
        if updated is None:
            return False
        if (now - updated) <= timedelta(days=gt):
            return False

    return True


# ---------------------------------------------------------------------------
# classify_issue
# ---------------------------------------------------------------------------


def classify_issue(
    issue: dict[str, Any],
    *,
    rules: list[dict[str, Any]] | None = None,
    hold_markers: list[str] | None = None,
    vbrief_referenced: set[int] | None = None,
    has_triage_decision: bool = False,
    now: datetime | None = None,
) -> ClassificationResult | None:
    """Classify a single issue against the effective rule set.

    Order of evaluation (Decision 2): framework universal rules first,
    then consumer rules in declared order; the FIRST rule that matches
    wins and the function returns its action / reason.

    Arguments:

    * ``issue`` -- a GitHub-issue-shaped dict (at minimum: ``number``,
      ``state``, ``body``, ``labels``, ``updated_at``).
    * ``rules`` -- the rule list returned by :func:`resolve_classify_rules`.
      Defaults to ``UNIVERSAL_RULES`` with no consumer additions.
    * ``hold_markers`` -- the hold-marker phrases consumed by the first
      universal rule. Defaults to :data:`DEFAULT_HOLD_MARKERS`. Pass an
      empty list to silence the hold-marker rule entirely.
    * ``vbrief_referenced`` -- issue numbers referenced by any pending/active
      scope vBRIEF. Drives the fourth universal rule.
    * ``has_triage_decision`` -- True iff the candidates audit log has
      ANY decision for this ``(repo, issue)``. Drives the second
      universal rule (closed AND never triaged -> archive).
    * ``now`` -- evaluation clock; defaults to UTC now. Tests override.

    Returns ``None`` when no rule matches (the issue is left for the
    operator / queue ranking to handle in the next phase).
    """
    if rules is None:
        rules = [dict(r) for r in UNIVERSAL_RULES]
    effective_markers = (
        list(DEFAULT_HOLD_MARKERS) if hold_markers is None else list(hold_markers)
    )
    now_dt = now or _utc_now()

    for index, rule in enumerate(rules):
        kind = rule.get("rule") if isinstance(rule, dict) else None
        matched = False
        if kind == "universal:hold-marker":
            matched = _matches_hold_marker(issue, effective_markers)
        elif kind == "universal:closed-never-triaged":
            matched = _matches_closed_never_triaged(
                issue, has_triage_decision=has_triage_decision
            )
        elif kind == "universal:dormant-thin-body":
            matched = _matches_dormant_thin_body(issue, now=now_dt)
        elif kind == "universal:vbrief-referenced":
            matched = _matches_vbrief_referenced(
                issue, vbrief_referenced=vbrief_referenced
            )
        elif isinstance(rule, dict):
            matched = _consumer_rule_matches(rule, issue, now=now_dt)

        if not matched:
            continue

        source = "framework" if isinstance(kind, str) and kind.startswith(
            "universal:"
        ) else "consumer"
        return ClassificationResult(
            action=str(rule.get("action", "")),
            reason=str(rule.get("reason", "")),
            rule_index=index,
            rule_source=source,
            rule_kind=str(kind) if isinstance(kind, str) else f"consumer[{index}]",
            resume_on=(
                str(rule["resume-on"])
                if isinstance(rule.get("resume-on"), str) and rule["resume-on"]
                else None
            ),
        )

    return None


# ---------------------------------------------------------------------------
# vBRIEF reference helper (mirror of triage_scope.extract_referenced_issues)
# ---------------------------------------------------------------------------


def extract_referenced_issues(
    project_root: Path | None = None,
    *,
    lifecycle_folders: tuple[str, ...] = ("pending", "active"),
) -> set[int]:
    """Return the union of issue numbers referenced by ``pending/`` or
    ``active/`` scope vBRIEFs.

    Used to drive the fourth universal rule (already referenced -> accept).
    Limited to pending/active by default because completed/cancelled
    references shouldn't reactivate the upstream issue. The
    ``lifecycle_folders`` knob lets callers override for the rare cases
    (e.g. cohort planning) where they want broader coverage.
    """
    root = (project_root or Path.cwd()) / "vbrief"
    referenced: set[int] = set()
    if not root.is_dir():
        return referenced
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
                    referenced.add(int(tail))
    return referenced


# ---------------------------------------------------------------------------
# --list renderer
# ---------------------------------------------------------------------------


def render_list(
    rules: Iterable[dict[str, Any]],
    *,
    hold_markers: Iterable[str] | None = None,
) -> str:
    """Return a human-readable recap of the effective rule + marker set.

    Format::

        triage:classify effective rules (N) (framework + consumer):
          1. universal:hold-marker        -> defer  (hold marker in body)
          2. universal:closed-never-triaged -> archive (closed upstream...)
          ...
          5. consumer rule [action=defer, labels.any-of=['foo']]
        hold markers (M): ['do not implement', 'BLOCKED', ...]
    """
    rule_list = list(rules)
    marker_list = (
        list(DEFAULT_HOLD_MARKERS) if hold_markers is None else list(hold_markers)
    )
    lines: list[str] = [
        f"triage:classify effective rules ({len(rule_list)}) "
        "(framework universal first, then consumer):"
    ]
    for i, rule in enumerate(rule_list, start=1):
        lines.extend(_render_rule(i, rule))
    lines.append(f"hold markers ({len(marker_list)}): {marker_list}")
    return "\n".join(lines)


def _render_rule(idx: int, rule: dict[str, Any]) -> list[str]:
    kind = rule.get("rule")
    action = rule.get("action", "?")
    reason = rule.get("reason", "")
    if isinstance(kind, str) and kind.startswith("universal:"):
        return [f"  {idx}. {kind:32s} -> {action:8s} ({reason})"]
    match = rule.get("match", {})
    parts: list[str] = []
    if isinstance(match, dict):
        if "labels" in match:
            labels = match["labels"]
            if isinstance(labels, dict):
                if "any-of" in labels:
                    parts.append(f"labels.any-of={sorted(labels['any-of'])}")
                elif "all-of" in labels:
                    parts.append(f"labels.all-of={sorted(labels['all-of'])}")
        if "body-text" in match:
            body = match["body-text"]
            if isinstance(body, dict) and "any-of" in body:
                parts.append(f"body-text.any-of={sorted(body['any-of'])}")
        if "state" in match:
            parts.append(f"state={match['state']!r}")
        if "age-days" in match:
            age = match["age-days"]
            if isinstance(age, dict) and "gt" in age:
                parts.append(f"age-days.gt={age['gt']}")
    head = (
        f"  {idx}. consumer rule "
        f"-> {action:8s} ({reason})"
    )
    if parts:
        head = f"{head} :: {', '.join(parts)}"
    if isinstance(rule.get("resume-on"), str) and rule["resume-on"]:
        head = f"{head} [resume-on: {rule['resume-on']}]"
    return [head]


# ---------------------------------------------------------------------------
# vbrief_validate hooks
# ---------------------------------------------------------------------------


def validate_triage_auto_classify_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook for ``plan.policy.triageAutoClassify`` (#1129).

    Returns formatted error strings prefixed with ``<filepath>:`` so
    ``vbrief_validate.validate_project_definition`` can splice them into
    its existing error list. Unset / missing -> no errors (default
    behaviour per Decision 2).
    """
    out: list[str] = []
    policy = plan.get("policy") if isinstance(plan, dict) else None
    raw = policy.get("triageAutoClassify") if isinstance(policy, dict) else None
    if raw is None:
        return out
    errors, _warnings = validate_classify_rules(raw)
    for err in errors:
        out.append(f"{filepath}: {err} (#1129)")
    return out


def validate_triage_hold_markers_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook for ``plan.policy.triageHoldMarkers`` (#1129)."""
    out: list[str] = []
    policy = plan.get("policy") if isinstance(plan, dict) else None
    raw = policy.get("triageHoldMarkers") if isinstance(policy, dict) else None
    if raw is None:
        return out
    errors, _warnings = validate_hold_markers(raw)
    for err in errors:
        out.append(f"{filepath}: {err} (#1129)")
    return out


# ---------------------------------------------------------------------------
# CLI entry point (delegates to scripts/_triage_classify_cli.py)
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Delegates to :mod:`_triage_classify_cli`."""
    import sys as _sys

    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_classify", argv)
    if rc is not None:
        return rc

    from _triage_classify_cli import run_cli  # local import: 1000-line cap

    return run_cli(argv, _sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
