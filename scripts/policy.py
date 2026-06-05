#!/usr/bin/env python3
"""policy.py -- shared helper for the typed PROJECT-DEFINITION.vbrief.json policy surface.

Introduced by #746 (no-feature-branch opt-out) as the single read/write surface for
``plan.policy.allowDirectCommitsToMaster``. Replaces the legacy free-form
``plan.narratives['Allow direct commits to master']`` narrative key (case-sensitive,
typo-prone, type-coerced). The legacy key is still recognized at read time with a
deprecation warning so existing PROJECT-DEFINITION files keep working until they
are migrated; new writes always go through this typed surface.

This module is consumed by:

- ``scripts/preflight_branch.py`` (#747 detection-bound branch gate)
- ``scripts/policy_show.py`` / ``scripts/policy_set.py`` (reconfiguration surface)
- skill-level guards in ``deft-directive-{swarm,review-cycle,pre-pr,release}``
- ``scripts/vbrief_validate.py`` (typed-field enforcement on PROJECT-DEFINITION)

Pure stdlib so the helper can be invoked from git hooks without ``uv``.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Public constants ----------------------------------------------------------

#: Filesystem-relative location of the project-definition vBRIEF.
PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"

#: Environment variable that lets the operator bypass the branch-protection
#: policy enforcement WITHOUT editing the typed flag. Documented in #747 as
#: the explicit emergency-escape hatch (e.g. CI on a release tag, automated
#: hot-fix). When set to a truthy value, hooks/scripts that defer to
#: :func:`is_direct_commit_allowed` MUST treat the policy as ``allowed``.
ENV_BYPASS = "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT"

#: Recognized truthy strings for ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT``.
_TRUTHY = frozenset({"1", "true", "yes", "on"})

#: Legacy narrative key that the typed flag replaces. Kept here so the
#: deprecation warning emitted during read-time can cite the exact spelling
#: the user likely has in their PROJECT-DEFINITION.
LEGACY_NARRATIVE_KEY = "Allow direct commits to master"

#: Sigil written by ``policy_set`` to ``meta/policy-changes.log`` so the
#: audit trail is grep-friendly across PowerShell and POSIX shells.
AUDIT_LOG_REL_PATH = "meta/policy-changes.log"

# ---------------------------------------------------------------------------
# WIP cap surface (#1124 / D4 of #1119)
# ---------------------------------------------------------------------------
#
# Framework default WIP cap. Used by ``scope:promote`` enforcement,
# ``verify:wip-cap`` re-validation, and the D2 (#1122) ``triage:summary``
# one-liner. **10** per umbrella #1119 Current Shape v3 (comment
# 4471269010); supersedes the literal 12 in the D4 (#1124) issue body.
# Importing the constant from ``scripts.policy`` is mandatory for any
# component that surfaces the cap so D2 / D4 cannot drift again.
DEFAULT_WIP_CAP: int = 10

#: vBRIEF lifecycle folders that count toward the WIP set. Mirrors the
#: D4 cap target (`pending/ + active/`).
WIP_LIFECYCLE_DIRS: tuple[str, ...] = ("pending", "active")


@dataclass(frozen=True)
class PolicyResult:
    """Resolved policy state. ``source`` documents which surface won."""

    allow_direct_commits: bool
    source: str  # one of: 'typed', 'legacy-narrative', 'env-bypass', 'default-fail-closed'
    deprecation_warning: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class WipCapResult:
    """Resolved ``plan.policy.wipCap`` state. Mirrors :class:`PolicyResult` shape.

    Fields:

    * ``cap`` -- resolved integer cap (``>= 0``).
    * ``source`` -- ``'typed'`` (typed field present and well-formed),
      ``'default'`` (no typed field; framework default applied), or
      ``'default-on-error'`` (typed field present but malformed -- the
      caller can surface ``error`` to the operator).
    * ``error`` -- one-line diagnostic when the typed field is
      unreadable / non-int / negative; ``None`` on success / default.
    """

    cap: int
    source: str  # one of: 'typed', 'default', 'default-on-error'
    error: str | None = None


def project_definition_path(project_root: Path | None = None) -> Path:
    """Resolve the absolute path to ``vbrief/PROJECT-DEFINITION.vbrief.json``."""
    root = project_root or Path.cwd()
    return root / PROJECT_DEFINITION_REL_PATH


def _env_bypass_active() -> bool:
    """True when ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT`` is set to a truthy value."""
    raw = os.environ.get(ENV_BYPASS, "")
    return raw.strip().lower() in _TRUTHY


def _coerce_legacy_narrative(value: Any) -> tuple[bool, str]:
    """Best-effort coerce a legacy narrative value to a boolean.

    Returns (allow, raw) where raw is the original string for diagnostics.
    Accepts ``true``, ``yes``, ``allow direct commits to master: true``,
    case-insensitive. Anything else is treated as ``False`` (enforce branches).
    """
    if isinstance(value, bool):
        return value, repr(value)
    if not isinstance(value, str):
        return False, repr(value)
    raw = value.strip()
    low = raw.lower()
    # Two shapes seen in the wild: "true" / "yes" or
    # "Allow direct commits to master: true" (re-stating the key inline).
    if low in {"true", "yes", "on", "1"}:
        return True, raw
    match = re.search(r":\s*(true|yes|on|1)\b", low)
    if match:
        return True, raw
    return False, raw


def load_project_definition(project_root: Path | None = None) -> tuple[dict | None, str | None]:
    """Load and parse PROJECT-DEFINITION. Returns (data, error)."""
    path = project_definition_path(project_root)
    if not path.is_file():
        return None, f"PROJECT-DEFINITION not found at {path}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, f"PROJECT-DEFINITION at {path} is not valid JSON: {exc}"
    except OSError as exc:
        return None, f"PROJECT-DEFINITION at {path} cannot be read: {exc}"


def resolve_policy(project_root: Path | None = None) -> PolicyResult:
    """Resolve the effective branch-commit policy.

    Resolution order (#746 / #747):

    1. ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT`` env-var bypass -- explicit escape.
    2. ``plan.policy.allowDirectCommitsToMaster`` typed boolean (new).
    3. ``plan.narratives['Allow direct commits to master']`` legacy narrative.
       Emits a deprecation warning the caller can surface.
    4. Default fail-closed: ``allow=False`` (enforce feature branches).
    """
    if _env_bypass_active():
        return PolicyResult(
            allow_direct_commits=True,
            source="env-bypass",
            deprecation_warning=None,
            error=None,
        )

    data, err = load_project_definition(project_root)
    if data is None:
        # Fail-closed when PROJECT-DEFINITION is missing -- the only way to
        # bypass without it is the env-var (already handled above). The
        # caller may still surface ``err`` to the user.
        return PolicyResult(
            allow_direct_commits=False,
            source="default-fail-closed",
            deprecation_warning=None,
            error=err,
        )

    plan = data.get("plan", {}) if isinstance(data, dict) else {}
    if not isinstance(plan, dict):
        return PolicyResult(
            allow_direct_commits=False,
            source="default-fail-closed",
            deprecation_warning=None,
            error="PROJECT-DEFINITION 'plan' is not an object",
        )

    # 2. Typed flag.
    policy_block = plan.get("policy")
    if isinstance(policy_block, dict) and "allowDirectCommitsToMaster" in policy_block:
        raw = policy_block["allowDirectCommitsToMaster"]
        if not isinstance(raw, bool):
            return PolicyResult(
                allow_direct_commits=False,
                source="default-fail-closed",
                deprecation_warning=None,
                error=(
                    "plan.policy.allowDirectCommitsToMaster must be a boolean; "
                    f"got {type(raw).__name__} ({raw!r})"
                ),
            )
        return PolicyResult(
            allow_direct_commits=raw,
            source="typed",
            deprecation_warning=None,
            error=None,
        )

    # 3. Legacy narrative fallback.
    narratives = plan.get("narratives", {})
    if isinstance(narratives, dict) and LEGACY_NARRATIVE_KEY in narratives:
        allow, raw = _coerce_legacy_narrative(narratives[LEGACY_NARRATIVE_KEY])
        warn = (
            f"DEPRECATED: PROJECT-DEFINITION uses the legacy narrative key "
            f"'{LEGACY_NARRATIVE_KEY}' ({raw!r}). Migrate to typed "
            f"plan.policy.allowDirectCommitsToMaster (#746). Run "
            f"`task policy:enforce-branches` or `task policy:allow-direct-commits "
            f"-- --confirm` to set the typed flag explicitly."
        )
        return PolicyResult(
            allow_direct_commits=allow,
            source="legacy-narrative",
            deprecation_warning=warn,
            error=None,
        )

    # 4. Default fail-closed.
    return PolicyResult(
        allow_direct_commits=False,
        source="default-fail-closed",
        deprecation_warning=None,
        error=None,
    )


def is_direct_commit_allowed(project_root: Path | None = None) -> bool:
    """Convenience boolean wrapper -- True when direct commits to master are allowed."""
    return resolve_policy(project_root).allow_direct_commits


# ---------------------------------------------------------------------------
# WIP cap helpers (#1124 / D4 of #1119)
# ---------------------------------------------------------------------------


def resolve_wip_cap(project_root: Path | None = None) -> WipCapResult:
    """Resolve ``plan.policy.wipCap`` from PROJECT-DEFINITION.

    Resolution order:

    1. ``plan.policy.wipCap`` typed integer (``>= 0``) -- ``source='typed'``.
    2. Missing / unreadable / non-int / negative -- ``source='default'``
       (with ``error`` set when malformed so the caller can surface it).

    Pure-stdlib; no live ``gh`` / cache calls. Mirrors the
    :func:`resolve_policy` shape so callers can use the same
    pattern-match-on-source style. Default = :data:`DEFAULT_WIP_CAP`
    (10 per umbrella #1119 Current Shape v3).
    """
    data, err = load_project_definition(project_root)
    if data is None:
        # Missing PROJECT-DEFINITION is not an error for the WIP cap --
        # we fall back to the framework default. ``err`` is propagated as
        # observability for the caller.
        return WipCapResult(
            cap=DEFAULT_WIP_CAP,
            source="default",
            error=err,
        )

    plan = data.get("plan") if isinstance(data, dict) else None
    if not isinstance(plan, dict):
        return WipCapResult(
            cap=DEFAULT_WIP_CAP,
            source="default",
            error="PROJECT-DEFINITION 'plan' is not an object",
        )
    policy_block = plan.get("policy")
    if not isinstance(policy_block, dict) or "wipCap" not in policy_block:
        return WipCapResult(cap=DEFAULT_WIP_CAP, source="default", error=None)

    raw = policy_block["wipCap"]
    # ``bool`` is a subclass of ``int`` in Python -- explicitly reject it
    # so ``True`` does not silently parse as cap=1.
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
        return WipCapResult(
            cap=DEFAULT_WIP_CAP,
            source="default-on-error",
            error=(
                "plan.policy.wipCap must be a non-negative integer; got "
                f"{type(raw).__name__} ({raw!r})"
            ),
        )
    return WipCapResult(cap=raw, source="typed", error=None)


def count_vbrief_wip(project_root: Path) -> int:
    """Count ``*.vbrief.json`` files in ``vbrief/pending/`` + ``vbrief/active/``.

    Files are filtered by the ``.vbrief.json`` suffix so scratch /
    README artefacts dropped into the lifecycle folders do not pollute
    the count. Missing folders contribute 0. Mirrors the D4 / #1124 cap
    target -- the single canonical WIP definition shared with D2.
    """
    total = 0
    vbrief_root = project_root / "vbrief"
    for sub in WIP_LIFECYCLE_DIRS:
        folder = vbrief_root / sub
        if not folder.is_dir():
            continue
        total += sum(
            1
            for child in folder.iterdir()
            if child.is_file() and child.name.endswith(".vbrief.json")
        )
    return total


def validate_wip_cap(value: Any) -> list[str]:
    """Validate a ``plan.policy.wipCap`` payload. Returns a list of error strings.

    Rules:

    * ``None`` / unset is valid (resolver falls back to the default).
    * Must be an integer (``bool`` explicitly rejected).
    * Must be ``>= 0`` (``0`` is a legitimate operator state -- freezes
      promotion entirely; useful for code-freeze windows).
    """
    errors: list[str] = []
    if value is None:
        return errors
    if not isinstance(value, int) or isinstance(value, bool):
        errors.append(
            "plan.policy.wipCap must be an integer; got "
            f"{type(value).__name__} ({value!r})"
        )
        return errors
    if value < 0:
        errors.append(
            f"plan.policy.wipCap must be >= 0; got {value}"
        )
    return errors


def validate_wip_cap_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.wipCap`` (#1124).

    Returns formatted error strings prefixed with ``<filepath>:`` so
    ``vbrief_validate.validate_project_definition`` can splice them into
    its existing error list. Unset / missing is treated as the framework
    default and returns an empty list. Mirrors the D11 / D12 / D10
    hook shape.
    """
    out: list[str] = []
    if not isinstance(plan, dict):
        return out
    policy = plan.get("policy")
    if not isinstance(policy, dict) or "wipCap" not in policy:
        return out
    for err in validate_wip_cap(policy["wipCap"]):
        out.append(f"{filepath}: {err} (#1124)")
    return out


def set_wip_cap(
    project_root: Path,
    *,
    cap: int,
    actor: str = "agent",
    note: str = "",
) -> tuple[bool, str]:
    """Write ``plan.policy.wipCap`` to PROJECT-DEFINITION.

    Returns ``(changed, audit_entry)``. Performs an in-place edit
    (preserves all other keys). Audit-log entry appended to
    ``meta/policy-changes.log`` (shared with the existing
    branch-protection writer; one log = one canonical timeline).

    Raises ``FileNotFoundError`` when PROJECT-DEFINITION is missing --
    the caller should produce a fail-closed message in that case.
    """
    if not isinstance(cap, int) or isinstance(cap, bool) or cap < 0:
        raise ValueError(
            f"wipCap must be a non-negative integer; got {cap!r}"
        )
    path = project_definition_path(project_root)
    if not path.is_file():
        raise FileNotFoundError(f"PROJECT-DEFINITION not found at {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    plan = data.setdefault("plan", {})
    if not isinstance(plan, dict):
        raise ValueError("PROJECT-DEFINITION 'plan' is not an object")
    policy_block = plan.setdefault("policy", {})
    if not isinstance(policy_block, dict):
        raise ValueError("plan.policy is not an object")

    previous = policy_block.get("wipCap")
    policy_block["wipCap"] = int(cap)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    changed = previous != int(cap)
    parts = [
        f"actor={actor}",
        f"wipCap={cap}",
        f"previous={previous!r}",
    ]
    if note:
        parts.append("note=" + note.replace("\n", " ").replace("\r", " "))
    audit_entry = " ".join(parts)
    append_audit_log(project_root, audit_entry)
    return changed, audit_entry


# ---------------------------------------------------------------------------
# Capacity allocation surface (#1419 Delivery Slice 4)
# ---------------------------------------------------------------------------
#
# ``plan.policy.capacityAllocation`` lets a project track effort against
# protected buckets (e.g. ``debt`` / ``feature`` / ``urgent``) so debt
# paydown is not starved by urgent work. The schema is ADVISORY by default
# (``enforcement = "advise"``): the capacity engine reports target-vs-actual
# mix and defers to the existing selection ordering. The ``cost`` unit is
# SELECTABLE (per OQ2, resolved 2026-06-04) but self-guards -- the cost path
# falls back to advisory ``vbrief-count`` when grounded cost actuals are
# insufficient (the Warp Analytics cost-sync telemetry is out of scope /
# upstream-blocked). The resolver below returns the requested unit verbatim;
# the guarded fallback decision lives in ``scripts/capacity_show.py`` where
# the grounded-actuals coverage can actually be measured against the
# lifecycle folders.

#: Capacity accounting unit. ``vbrief-count`` (default, directive's mode)
#: tallies vBRIEF weights; ``cost`` is the opt-in unit that overlays cost
#: actuals and self-guards with an advisory count fallback (OQ2).
DEFAULT_CAPACITY_UNIT: str = "vbrief-count"
CAPACITY_UNIT_COST: str = "cost"
CAPACITY_UNITS: frozenset[str] = frozenset({DEFAULT_CAPACITY_UNIT, CAPACITY_UNIT_COST})

#: Trailing accounting window (days) when ``window`` is absent on a
#: well-formed-but-partial block. A configured block MUST carry ``window``
#: (validated), so this default only applies to the unconfigured-default
#: resolver result.
DEFAULT_CAPACITY_WINDOW_DAYS: int = 30

#: Enforcement posture. ``advise`` (default) NEVER blocks -- the engine
#: reports and defers to ordering. ``enforce`` is opt-in and only surfaces
#: a non-zero gate exit when a real deficit accrues past the sample guard;
#: the framework's own tree leaves this at ``advise`` so a capacity gate
#: cannot wedge master.
DEFAULT_CAPACITY_ENFORCEMENT: str = "advise"
CAPACITY_ENFORCEMENTS: frozenset[str] = frozenset({"advise", "enforce"})

#: Minimum classified completions before backward (target-vs-actual)
#: accounting is treated as load-bearing. Below this, the engine reports
#: advisory mode and defers to ordering (acceptance a1).
DEFAULT_CAPACITY_MIN_SAMPLE_SIZE: int = 20

#: Weight attributed to an UNDECOMPOSED epic / phase (one with no child
#: stories on disk). A decomposed parent counts 0 -- its children are
#: counted directly (acceptance a2).
DEFAULT_EPIC_ESTIMATE: int = 3

#: Age (days) past which an undecomposed epic estimate is considered stale
#: (surfaced by the capacity engine as a hint; advisory only).
DEFAULT_EPIC_STALENESS_DAYS: int = 30

#: Absolute tolerance for the ``sum(bucket.target) == 1.0`` invariant so
#: float round-trips (e.g. 0.3 + 0.3 + 0.4) validate cleanly.
CAPACITY_TARGET_SUM_TOLERANCE: float = 1e-6


@dataclass(frozen=True)
class CapacityBucket:
    """One protected capacity bucket: a stable id and its target fraction."""

    bucket_id: str
    target: float


@dataclass(frozen=True)
class CapacityAllocation:
    """Resolved ``plan.policy.capacityAllocation`` state.

    ``source`` mirrors :class:`WipCapResult` semantics: ``'typed'`` when a
    well-formed block is present, ``'default'`` when absent, and
    ``'default-on-error'`` when present-but-malformed (``error`` carries the
    first diagnostic so the caller can surface it). ``configured`` is the
    convenience predicate the capacity engine uses to decide whether to
    render the target-vs-actual table or the unconfigured advisory banner.
    """

    unit: str
    window_days: int
    enforcement: str
    min_sample_size: int
    buckets: tuple[CapacityBucket, ...]
    default_bucket: str
    default_epic_estimate: int
    epic_staleness_days: int
    source: str  # one of: 'typed', 'default', 'default-on-error'
    error: str | None = None

    @property
    def configured(self) -> bool:
        """True when a well-formed block with at least one bucket is present."""
        return self.source == "typed" and bool(self.buckets)


def _is_number(value: Any) -> bool:
    """True for a real numeric value (``bool`` is explicitly excluded)."""
    return isinstance(value, int | float) and not isinstance(value, bool)


def _is_positive_int(value: Any) -> bool:
    """True for an ``int`` strictly greater than zero (``bool`` excluded)."""
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _default_capacity_allocation(
    *, source: str, error: str | None = None
) -> CapacityAllocation:
    """Return the framework-default :class:`CapacityAllocation`.

    Buckets are intentionally empty -- with no configured buckets the
    capacity engine renders the unconfigured advisory banner rather than a
    target-vs-actual table.
    """
    return CapacityAllocation(
        unit=DEFAULT_CAPACITY_UNIT,
        window_days=DEFAULT_CAPACITY_WINDOW_DAYS,
        enforcement=DEFAULT_CAPACITY_ENFORCEMENT,
        min_sample_size=DEFAULT_CAPACITY_MIN_SAMPLE_SIZE,
        buckets=(),
        default_bucket="",
        default_epic_estimate=DEFAULT_EPIC_ESTIMATE,
        epic_staleness_days=DEFAULT_EPIC_STALENESS_DAYS,
        source=source,
        error=error,
    )


def validate_capacity_allocation(value: Any) -> list[str]:
    """Validate a ``plan.policy.capacityAllocation`` payload.

    Returns a list of error strings (empty == valid). ``None`` / unset is
    valid (the resolver falls back to the framework default). The invariants
    enforced (per the #1419 Slice 4 acceptance criteria) are:

    * ``unit`` (if present) is one of :data:`CAPACITY_UNITS`.
    * ``enforcement`` (if present) is one of :data:`CAPACITY_ENFORCEMENTS`.
    * ``window`` is REQUIRED and a positive integer (days).
    * ``minSampleSize`` (if present) is a non-negative integer.
    * ``defaultEpicEstimate`` / ``epicStalenessDays`` (if present) are
      positive integers.
    * ``buckets`` is a non-empty array of ``{id, target}`` objects with
      unique ids and targets that sum to 1.0 (within
      :data:`CAPACITY_TARGET_SUM_TOLERANCE`).
    * ``defaultBucket`` (if present) matches a declared bucket id.
    """
    errors: list[str] = []
    if value is None:
        return errors
    if not isinstance(value, dict):
        errors.append(
            "plan.policy.capacityAllocation must be an object; got "
            f"{type(value).__name__} ({value!r})"
        )
        return errors

    unit = value.get("unit", DEFAULT_CAPACITY_UNIT)
    if unit not in CAPACITY_UNITS:
        errors.append(
            "plan.policy.capacityAllocation.unit must be one of "
            f"{sorted(CAPACITY_UNITS)}; got {unit!r}"
        )

    enforcement = value.get("enforcement", DEFAULT_CAPACITY_ENFORCEMENT)
    if enforcement not in CAPACITY_ENFORCEMENTS:
        errors.append(
            "plan.policy.capacityAllocation.enforcement must be one of "
            f"{sorted(CAPACITY_ENFORCEMENTS)}; got {enforcement!r}"
        )

    if "window" not in value:
        errors.append(
            "plan.policy.capacityAllocation.window is required "
            "(trailing accounting window in days)"
        )
    elif not _is_positive_int(value["window"]):
        errors.append(
            "plan.policy.capacityAllocation.window must be a positive integer "
            f"(days); got {value['window']!r}"
        )

    if "minSampleSize" in value:
        mss = value["minSampleSize"]
        if not isinstance(mss, int) or isinstance(mss, bool) or mss < 0:
            errors.append(
                "plan.policy.capacityAllocation.minSampleSize must be a "
                f"non-negative integer; got {mss!r}"
            )

    if "defaultEpicEstimate" in value and not _is_positive_int(
        value["defaultEpicEstimate"]
    ):
        errors.append(
            "plan.policy.capacityAllocation.defaultEpicEstimate must be a "
            f"positive integer; got {value['defaultEpicEstimate']!r}"
        )

    if "epicStalenessDays" in value and not _is_positive_int(
        value["epicStalenessDays"]
    ):
        errors.append(
            "plan.policy.capacityAllocation.epicStalenessDays must be a "
            f"positive integer; got {value['epicStalenessDays']!r}"
        )

    errors.extend(_validate_capacity_buckets(value))
    return errors


def _validate_capacity_buckets(value: dict) -> list[str]:
    """Validate the ``buckets`` array + ``defaultBucket`` cross-reference."""
    errors: list[str] = []
    buckets = value.get("buckets")
    if not isinstance(buckets, list) or not buckets:
        errors.append(
            "plan.policy.capacityAllocation.buckets must be a non-empty array"
        )
        return errors

    ids: list[str] = []
    total = 0.0
    for idx, bucket in enumerate(buckets):
        if not isinstance(bucket, dict):
            errors.append(
                f"plan.policy.capacityAllocation.buckets[{idx}] must be an object"
            )
            continue
        bucket_id = bucket.get("id")
        if not isinstance(bucket_id, str) or not bucket_id.strip():
            errors.append(
                f"plan.policy.capacityAllocation.buckets[{idx}].id must be a "
                "non-empty string"
            )
        else:
            ids.append(bucket_id)
        target = bucket.get("target")
        if not _is_number(target):
            errors.append(
                f"plan.policy.capacityAllocation.buckets[{idx}].target must be "
                f"a number; got {target!r}"
            )
        elif not 0.0 <= float(target) <= 1.0:
            errors.append(
                f"plan.policy.capacityAllocation.buckets[{idx}].target must be "
                f"between 0.0 and 1.0; got {target!r}"
            )
        else:
            total += float(target)

    duplicates = sorted({bid for bid in ids if ids.count(bid) > 1})
    if duplicates:
        errors.append(
            "plan.policy.capacityAllocation.buckets ids must be unique; "
            f"duplicates: {duplicates}"
        )

    if ids and abs(total - 1.0) > CAPACITY_TARGET_SUM_TOLERANCE:
        errors.append(
            "plan.policy.capacityAllocation.buckets targets must sum to 1.0; "
            f"got {total:.6f}"
        )

    default_bucket = value.get("defaultBucket")
    if default_bucket is not None:
        if not isinstance(default_bucket, str):
            errors.append(
                "plan.policy.capacityAllocation.defaultBucket must be a string"
            )
        elif default_bucket not in ids:
            errors.append(
                "plan.policy.capacityAllocation.defaultBucket "
                f"{default_bucket!r} must match a declared bucket id"
            )
    return errors


def validate_capacity_allocation_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.capacityAllocation`` (#1419).

    Returns formatted error strings prefixed with ``<filepath>:`` so a
    PROJECT-DEFINITION validator can splice them into its error list.
    Unset / missing is valid and returns an empty list. Mirrors the
    :func:`validate_wip_cap_on_plan` hook shape.

    NOTE (#1419): this hook is provided + unit-tested as the canonical
    validation entry point, but is intentionally NOT yet spliced into
    ``scripts/vbrief_validate.py`` in this slice -- capacity is advisory in
    Slice 4 and a malformed block self-heals to defaults (the resolver
    returns ``source='default-on-error'`` and ``capacity:show`` surfaces the
    error). Wiring this into the ``task check`` validation aggregate is a
    follow-up slice's concern; doing it here would touch out-of-scope files
    and risk a fail-closed posture on the framework's own tree.
    """
    out: list[str] = []
    if not isinstance(plan, dict):
        return out
    policy = plan.get("policy")
    if not isinstance(policy, dict) or "capacityAllocation" not in policy:
        return out
    for err in validate_capacity_allocation(policy["capacityAllocation"]):
        out.append(f"{filepath}: {err} (#1419)")
    return out


def resolve_capacity_allocation(
    project_root: Path | None = None,
) -> CapacityAllocation:
    """Resolve ``plan.policy.capacityAllocation`` from PROJECT-DEFINITION.

    Resolution order (mirrors :func:`resolve_wip_cap`):

    1. A well-formed ``plan.policy.capacityAllocation`` block -> ``'typed'``.
    2. Missing -> framework default (``'default'``).
    3. Present-but-malformed -> framework default (``'default-on-error'``,
       with ``error`` set so the caller can surface it).

    Pure-stdlib; no live ``gh`` / cache calls. The ``cost`` unit is
    returned verbatim -- the guarded advisory fallback is applied downstream
    in :mod:`scripts.capacity_show` where grounded-actuals coverage can be
    measured (OQ2).
    """
    data, err = load_project_definition(project_root)
    if data is None:
        return _default_capacity_allocation(source="default", error=err)

    policy_block = _get_policy_block(data)
    if "capacityAllocation" not in policy_block:
        return _default_capacity_allocation(source="default")

    raw = policy_block["capacityAllocation"]
    validation_errors = validate_capacity_allocation(raw)
    if validation_errors or not isinstance(raw, dict):
        return _default_capacity_allocation(
            source="default-on-error",
            error=(
                validation_errors[0]
                if validation_errors
                else "capacityAllocation must be an object"
            ),
        )

    buckets = tuple(
        CapacityBucket(bucket_id=bucket["id"], target=float(bucket["target"]))
        for bucket in raw["buckets"]
    )
    default_bucket = raw.get("defaultBucket", "")
    if not isinstance(default_bucket, str):
        default_bucket = ""
    return CapacityAllocation(
        unit=raw.get("unit", DEFAULT_CAPACITY_UNIT),
        window_days=int(raw["window"]),
        enforcement=raw.get("enforcement", DEFAULT_CAPACITY_ENFORCEMENT),
        min_sample_size=int(raw.get("minSampleSize", DEFAULT_CAPACITY_MIN_SAMPLE_SIZE)),
        buckets=buckets,
        default_bucket=default_bucket,
        default_epic_estimate=int(
            raw.get("defaultEpicEstimate", DEFAULT_EPIC_ESTIMATE)
        ),
        epic_staleness_days=int(
            raw.get("epicStalenessDays", DEFAULT_EPIC_STALENESS_DAYS)
        ),
        source="typed",
        error=None,
    )


# ---------------------------------------------------------------------------
# Judgment-gate surface (#1419 Delivery Slice 3)
# ---------------------------------------------------------------------------
#
# ``plan.policy.judgmentGates`` declares risk-tiered gates that require human
# clearance before sensitive changes (secrets, infra, AGENTS.md / skills,
# installer) are dispatched. Each gate carries a stable ``id``, a ``class``
# (``mechanical`` -- mechanically detectable, fail-closed on detection; or
# ``declared`` -- depends on a human declaration, fail-open on omission), a
# ``match`` block that REUSES the triageAutoClassify DSL
# (``labels`` / ``body-text`` / ``state`` / ``age-days``) plus a NEW ``paths``
# glob predicate, a risk ``tier`` (``auto`` / ``review`` / ``block``), an
# optional ``requiredHumanReviewers`` count, and a ``reason``.
#
# ``plan.policy.judgmentGatesDisabled`` is a list of gate ids to disable --
# including the four DEFAULT-ON universal safety gates owned by
# ``scripts/verify_judgment_gates.py``.
#
# This module owns the TYPED SCHEMA + validation + resolver ONLY. The gate
# engine, the default-on universal gates, the pathspec matcher, and the
# clearance audit log live in ``scripts/verify_judgment_gates.py`` (the
# advisory ``task verify:judgment-gates`` surface). The capacityAllocation
# surface above is unaffected.

#: Recognised ``class`` values for a judgment gate.
GATE_CLASSES: frozenset[str] = frozenset({"mechanical", "declared"})

#: Recognised risk ``tier`` values.
GATE_TIERS: frozenset[str] = frozenset({"auto", "review", "block"})

#: Recognised ``match`` predicates (triage DSL + the new ``paths`` glob).
GATE_MATCH_PREDICATES: frozenset[str] = frozenset(
    {"labels", "body-text", "paths", "state", "age-days"}
)

#: Recognised ``match.state`` values (mirrors triageAutoClassify).
GATE_MATCH_STATES: frozenset[str] = frozenset({"open", "closed"})


@dataclass(frozen=True)
class JudgmentGate:
    """One resolved judgment gate from ``plan.policy.judgmentGates``."""

    gate_id: str
    gate_class: str  # 'mechanical' | 'declared'
    match: dict[str, Any]
    tier: str  # 'auto' | 'review' | 'block'
    reason: str
    required_human_reviewers: int = 0


@dataclass(frozen=True)
class JudgmentGatesPolicy:
    """Resolved ``judgmentGates`` + ``judgmentGatesDisabled`` state.

    ``source`` mirrors :class:`CapacityAllocation` semantics: ``'typed'`` when
    a well-formed config is present, ``'default'`` when both fields are absent,
    and ``'default-on-error'`` when present-but-malformed (``error`` carries
    the first diagnostic so the caller can surface it).
    """

    gates: tuple[JudgmentGate, ...]
    disabled: tuple[str, ...]
    source: str  # one of: 'typed', 'default', 'default-on-error'
    error: str | None = None

    @property
    def configured(self) -> bool:
        """True when a well-formed block with at least one consumer gate exists."""
        return self.source == "typed" and bool(self.gates)


def _validate_str_list(value: Any, prefix: str, key: str) -> list[str]:
    """Validate that ``value`` is a non-empty list of non-empty strings."""
    if not isinstance(value, list) or not value:
        return [f"{prefix}.{key} must be a non-empty list of strings"]
    errors: list[str] = []
    for j, item in enumerate(value):
        if not isinstance(item, str) or not item:
            errors.append(f"{prefix}.{key}[{j}] must be a non-empty string")
    return errors


def _validate_glob_predicate(value: Any, prefix: str) -> list[str]:
    """Validate the NEW ``paths`` glob predicate: ``{any-of: [glob, ...]}``."""
    if not isinstance(value, dict):
        return [f"{prefix} must be an object with an 'any-of' glob list"]
    if "any-of" not in value:
        return [f"{prefix} requires 'any-of'"]
    return _validate_str_list(value["any-of"], prefix, "any-of")


def _validate_gate_labels(value: Any, prefix: str) -> list[str]:
    """Validate the ``labels`` predicate (``any-of`` XOR ``all-of``)."""
    if not isinstance(value, dict):
        return [f"{prefix} must be an object"]
    any_of = value.get("any-of")
    all_of = value.get("all-of")
    if any_of is None and all_of is None:
        return [f"{prefix} requires 'any-of' or 'all-of'"]
    if any_of is not None and all_of is not None:
        return [f"{prefix}: 'any-of' and 'all-of' are mutually exclusive"]
    key = "any-of" if any_of is not None else "all-of"
    return _validate_str_list(value[key], prefix, key)


def _validate_gate_any_of(value: Any, prefix: str) -> list[str]:
    """Validate the ``body-text`` predicate: ``{any-of: [text, ...]}``."""
    if not isinstance(value, dict):
        return [f"{prefix} must be an object"]
    if "any-of" not in value:
        return [f"{prefix} requires 'any-of'"]
    return _validate_str_list(value["any-of"], prefix, "any-of")


def _validate_gate_age_days(value: Any, prefix: str) -> list[str]:
    """Validate the ``age-days`` predicate: ``{gt: N}`` (non-negative int)."""
    if not isinstance(value, dict):
        return [f"{prefix} must be an object"]
    if "gt" not in value:
        return [f"{prefix} requires a 'gt' integer threshold"]
    gt = value["gt"]
    if not isinstance(gt, int) or isinstance(gt, bool) or gt < 0:
        return [f"{prefix}.gt must be a non-negative integer; got {gt!r}"]
    return []


def _validate_gate_match(match: Any, prefix: str) -> list[str]:
    """Validate a gate ``match`` block (triage DSL predicates + ``paths``)."""
    if not isinstance(match, dict):
        return [f"{prefix} must be an object"]
    used = sorted(set(match) & GATE_MATCH_PREDICATES)
    if not used:
        return [f"{prefix} requires at least one of {sorted(GATE_MATCH_PREDICATES)}"]
    errors: list[str] = []
    # Reject unrecognised predicate keys so a misspelling (e.g. ``path`` for
    # ``paths``) fails validation loudly instead of being silently dropped at
    # match time -- the gate would otherwise appear valid but match as if that
    # predicate were absent.
    extra = sorted(set(match) - GATE_MATCH_PREDICATES)
    if extra:
        errors.append(
            f"{prefix} has unrecognised predicate(s) {extra}; "
            f"expected only {sorted(GATE_MATCH_PREDICATES)}"
        )
    if "paths" in match:
        errors.extend(_validate_glob_predicate(match["paths"], f"{prefix}.paths"))
    if "labels" in match:
        errors.extend(_validate_gate_labels(match["labels"], f"{prefix}.labels"))
    if "body-text" in match:
        errors.extend(
            _validate_gate_any_of(match["body-text"], f"{prefix}.body-text")
        )
    if "state" in match and match["state"] not in GATE_MATCH_STATES:
        errors.append(
            f"{prefix}.state must be one of {sorted(GATE_MATCH_STATES)}; "
            f"got {match['state']!r}"
        )
    if "age-days" in match:
        errors.extend(
            _validate_gate_age_days(match["age-days"], f"{prefix}.age-days")
        )
    return errors


def _validate_single_gate(gate: Any, prefix: str) -> tuple[list[str], str | None]:
    """Validate one gate object. Returns ``(errors, gate_id_or_None)``."""
    if not isinstance(gate, dict):
        return [f"{prefix} must be an object; got {type(gate).__name__}"], None
    errors: list[str] = []
    gid = gate.get("id")
    resolved_id: str | None = None
    if not isinstance(gid, str) or not gid.strip():
        errors.append(f"{prefix}.id must be a non-empty string")
    else:
        resolved_id = gid
    gclass = gate.get("class")
    if gclass not in GATE_CLASSES:
        errors.append(
            f"{prefix}.class must be one of {sorted(GATE_CLASSES)}; got {gclass!r}"
        )
    tier = gate.get("tier")
    if tier not in GATE_TIERS:
        errors.append(
            f"{prefix}.tier must be one of {sorted(GATE_TIERS)}; got {tier!r}"
        )
    reason = gate.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        errors.append(f"{prefix}.reason must be a non-empty string")
    if "requiredHumanReviewers" in gate:
        rhr = gate["requiredHumanReviewers"]
        if not isinstance(rhr, int) or isinstance(rhr, bool) or rhr < 0:
            errors.append(
                f"{prefix}.requiredHumanReviewers must be a non-negative integer; "
                f"got {rhr!r}"
            )
    errors.extend(_validate_gate_match(gate.get("match"), f"{prefix}.match"))
    return errors, resolved_id


def validate_judgment_gates(value: Any) -> list[str]:
    """Validate a ``plan.policy.judgmentGates`` payload.

    Returns a list of error strings (empty == valid). ``None`` / unset is
    valid (the resolver falls back to the framework default). Each gate is an
    object with ``id`` / ``class`` / ``tier`` / ``reason`` / ``match`` (and an
    optional ``requiredHumanReviewers``); gate ids must be unique.
    """
    errors: list[str] = []
    if value is None:
        return errors
    if not isinstance(value, list):
        errors.append(
            "plan.policy.judgmentGates must be a list of gate objects; got "
            f"{type(value).__name__}"
        )
        return errors
    ids: list[str] = []
    for idx, gate in enumerate(value):
        gate_errors, gate_id = _validate_single_gate(
            gate, f"plan.policy.judgmentGates[{idx}]"
        )
        errors.extend(gate_errors)
        if gate_id is not None:
            ids.append(gate_id)
    duplicates = sorted({g for g in ids if ids.count(g) > 1})
    if duplicates:
        errors.append(
            f"plan.policy.judgmentGates ids must be unique; duplicates: {duplicates}"
        )
    return errors


def validate_judgment_gates_disabled(value: Any) -> list[str]:
    """Validate a ``plan.policy.judgmentGatesDisabled`` payload (list of ids)."""
    errors: list[str] = []
    if value is None:
        return errors
    if not isinstance(value, list):
        errors.append(
            "plan.policy.judgmentGatesDisabled must be a list of gate ids; got "
            f"{type(value).__name__}"
        )
        return errors
    for j, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            errors.append(
                f"plan.policy.judgmentGatesDisabled[{j}] must be a non-empty string"
            )
    return errors


def validate_judgment_gates_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate the judgment-gate fields (#1419).

    Returns formatted error strings prefixed with ``<filepath>:``. Mirrors the
    :func:`validate_capacity_allocation_on_plan` hook shape. As with capacity
    in Slice 4, this hook is provided + unit-tested as the canonical
    validation entry point but is intentionally NOT yet spliced into
    ``scripts/vbrief_validate.py`` -- judgment gates are advisory in v1 and a
    malformed block self-heals to defaults; wiring it into the ``task check``
    validation aggregate is out-of-scope here (it would touch files outside
    this slice and risk a fail-closed posture on the framework's own tree).
    """
    out: list[str] = []
    if not isinstance(plan, dict):
        return out
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return out
    if "judgmentGates" in policy:
        for err in validate_judgment_gates(policy["judgmentGates"]):
            out.append(f"{filepath}: {err} (#1419)")
    if "judgmentGatesDisabled" in policy:
        for err in validate_judgment_gates_disabled(policy["judgmentGatesDisabled"]):
            out.append(f"{filepath}: {err} (#1419)")
    return out


def _default_judgment_gates_policy(
    *, source: str, error: str | None = None
) -> JudgmentGatesPolicy:
    return JudgmentGatesPolicy(gates=(), disabled=(), source=source, error=error)


def resolve_judgment_gates(
    project_root: Path | None = None,
) -> JudgmentGatesPolicy:
    """Resolve ``judgmentGates`` + ``judgmentGatesDisabled`` from PROJECT-DEFINITION.

    Resolution order (mirrors :func:`resolve_capacity_allocation`):

    1. A well-formed config -> ``'typed'``.
    2. Both fields absent -> framework default (``'default'``, empty).
    3. Present-but-malformed -> framework default (``'default-on-error'`` with
       ``error`` set so the caller can surface it -- the gate engine
       self-heals to the universal gates only).

    Pure-stdlib; no live ``gh`` / cache calls.
    """
    data, err = load_project_definition(project_root)
    if data is None:
        return _default_judgment_gates_policy(source="default", error=err)

    policy_block = _get_policy_block(data)
    raw_gates = policy_block.get("judgmentGates")
    raw_disabled = policy_block.get("judgmentGatesDisabled")
    if raw_gates is None and raw_disabled is None:
        return _default_judgment_gates_policy(source="default")

    errors = validate_judgment_gates(raw_gates) + validate_judgment_gates_disabled(
        raw_disabled
    )
    if errors:
        return _default_judgment_gates_policy(
            source="default-on-error", error=errors[0]
        )

    gates = tuple(
        JudgmentGate(
            gate_id=gate["id"],
            gate_class=gate["class"],
            match=dict(gate["match"]),
            tier=gate["tier"],
            reason=gate["reason"],
            required_human_reviewers=int(gate.get("requiredHumanReviewers", 0)),
        )
        for gate in (raw_gates or [])
    )
    disabled = tuple(d for d in (raw_disabled or []) if isinstance(d, str))
    return JudgmentGatesPolicy(
        gates=gates, disabled=disabled, source="typed", error=None
    )


# ---------------------------------------------------------------------------
# Pending human-clearance backlog + earned-autonomy dial (#1419 Slice 5)
# ---------------------------------------------------------------------------
#
# Two ADVISORY surfaces sit on top of the judgment-gate clearance machinery
# (``scripts/verify_judgment_gates.py``, #1419 Slice 3):
#
# 1. The PENDING HUMAN-DECISIONS BACKLOG -- a durable append-only audit log
#    (``vbrief/.audit/pending-human-decisions.jsonl``) of decisions that need
#    human adjudication but are not yet resolved. Each line is one event for a
#    ``decision_id``: a ``pending`` event opens the decision (a judgment gate
#    fired without clearance, or -- per OQ4 -- a multi-LLM reviewer split on a
#    P0/P1 finding escalated), and a later ``resolved`` event closes it. The
#    backlog count is the number of decision_ids whose LATEST event is still
#    ``pending``. ``capacity:show`` and ``triage:welcome`` surface that count
#    and, when it exceeds the Tier-1 threshold, emit a nudge so ``wipCap`` can
#    be tuned to real human-review throughput. The log lives beside (but is
#    distinct from) the Slice-3 clearance log so this module does not have to
#    edit ``verify_judgment_gates.py``.
#
# 2. The EARNED-AUTONOMY DIAL -- a per-project (optionally per gate-id) policy
#    that RECOMMENDS one of three levels (Observe / Escalate / Execute,
#    default Escalate). The dial signal is the clearance-override rate
#    (primary) plus the rework rate (guardrail) over the capacity window. It
#    advances asymmetrically (advance only when override < advanceMax AND
#    rework <= baseline AND the resolved-decision sample is large enough;
#    retreat IMMEDIATELY on any P0 reversal or override > retreatRate). It is
#    ADVISORY-ONLY in v1: :func:`recommend_autonomy_level` returns a
#    recommendation a human confirms -- nothing here auto-ratchets a level or
#    auto-reduces a gate's required clearances.

#: Durable, operator-private pending-decisions backlog log location. Shares
#: the ``vbrief/.audit/`` directory with the Slice-3 clearance log but is a
#: separate file (this module owns the backlog; the clearance log is owned by
#: ``scripts/verify_judgment_gates.py``).
PENDING_DECISIONS_AUDIT_DIR_REL: str = "vbrief/.audit"
PENDING_DECISIONS_LOG_NAME: str = "pending-human-decisions.jsonl"

#: Decision-event status tokens. Compare via these constants so a rename
#: surfaces as a NameError at import time rather than a silent mismatch.
DECISION_STATUS_PENDING: str = "pending"
DECISION_STATUS_RESOLVED: str = "resolved"

#: Backlog size at which ``capacity:show`` / ``triage:welcome`` emit the
#: Tier-1 pending-decisions nudge (count STRICTLY greater than this fires).
DEFAULT_PENDING_DECISIONS_THRESHOLD: int = 5

#: ``kind`` tag for a pending decision opened by a multi-LLM reviewer split
#: (OQ4). Mirrors the #526 errored-state escalation contract.
REVIEWER_DISAGREEMENT_KIND: str = "reviewer-disagreement"

#: Severities that escalate a reviewer split on a review/block-tier gate
#: (OQ4: "a P0/P1 reviewer split or errored-on-HEAD escalates to a human").
_ESCALATING_SEVERITIES: frozenset[str] = frozenset({"p0", "p1"})


def _parse_iso_ts(value: Any) -> datetime | None:
    """Parse an ISO-8601 ``...Z`` timestamp to an aware datetime, or None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def pending_decisions_log_path(project_root: Path) -> Path:
    """Resolve the durable pending-decisions backlog log under *project_root*."""
    return project_root / PENDING_DECISIONS_AUDIT_DIR_REL / PENDING_DECISIONS_LOG_NAME


def _append_decision_event(
    project_root: Path,
    *,
    decision_id: str,
    status: str,
    kind: str,
    gate_id: str,
    severity: str,
    reviewers: list[str] | None,
    actor: str,
    reason: str,
    override: bool,
    p0_reversal: bool,
    now: datetime | None,
    log_path: Path | None,
) -> dict[str, Any]:
    """Append one decision event to the backlog log and return the record."""
    if not isinstance(decision_id, str) or not decision_id.strip():
        raise ValueError("decision_id must be a non-empty string")
    path = log_path or pending_decisions_log_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    timestamp = (
        _now_iso()
        if now is None
        else now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    )
    entry: dict[str, Any] = {
        "decision_id": decision_id,
        "timestamp": timestamp,
        "status": status,
        "kind": kind,
        "gate_id": gate_id,
        "severity": severity,
        "reviewers": list(reviewers or []),
        "actor": actor,
        "reason": reason,
        "override": bool(override),
        "p0_reversal": bool(p0_reversal),
    }
    line = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    return entry


def record_pending_decision(
    project_root: Path,
    *,
    decision_id: str,
    kind: str,
    gate_id: str = "",
    severity: str = "",
    reviewers: list[str] | None = None,
    actor: str = "agent",
    reason: str = "",
    now: datetime | None = None,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Open a pending human decision (append a ``pending`` event).

    Idempotency note: each call appends an event. Opening the same
    ``decision_id`` twice without an intervening resolution leaves the
    decision pending (the latest event still says ``pending``), so the
    backlog count is unchanged -- the audit trail keeps both rows.
    """
    return _append_decision_event(
        project_root,
        decision_id=decision_id,
        status=DECISION_STATUS_PENDING,
        kind=kind,
        gate_id=gate_id,
        severity=severity,
        reviewers=reviewers,
        actor=actor,
        reason=reason,
        override=False,
        p0_reversal=False,
        now=now,
        log_path=log_path,
    )


def resolve_pending_decision(
    project_root: Path,
    *,
    decision_id: str,
    kind: str = "",
    gate_id: str = "",
    severity: str = "",
    reviewers: list[str] | None = None,
    actor: str = "operator",
    reason: str = "",
    override: bool = False,
    p0_reversal: bool = False,
    now: datetime | None = None,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Close a pending human decision (append a ``resolved`` event).

    ``override`` records that the human reversed the autonomy recommendation
    (the primary dial signal); ``p0_reversal`` records that the resolution
    reversed a P0 outcome (the immediate-retreat trigger). Both are read back
    by :func:`summarize_decision_backlog` to drive the dial.
    """
    return _append_decision_event(
        project_root,
        decision_id=decision_id,
        status=DECISION_STATUS_RESOLVED,
        kind=kind,
        gate_id=gate_id,
        severity=severity,
        reviewers=reviewers,
        actor=actor,
        reason=reason,
        override=override,
        p0_reversal=p0_reversal,
        now=now,
        log_path=log_path,
    )


def read_decision_events(
    project_root: Path, *, log_path: Path | None = None
) -> list[dict[str, Any]]:
    """Return every well-formed decision event in insertion (chronological) order.

    Tolerant of malformed / partial lines (skips them) so a torn write never
    crashes a backlog summary or a session-start surface.
    """
    path = log_path or pending_decisions_log_path(project_root)
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("decision_id"), str):
            out.append(obj)
    return out


@dataclass(frozen=True)
class DecisionBacklog:
    """Rolled-up view of the pending-decisions log.

    ``pending_count`` / ``by_kind`` describe the CURRENT backlog (latest event
    per ``decision_id`` is ``pending``). The remaining fields summarise
    decisions RESOLVED within the accounting window and feed the autonomy dial.
    """

    pending_count: int
    by_kind: dict[str, int]
    resolved_in_window: int
    override_count: int
    p0_reversal_in_window: bool

    @property
    def override_rate(self) -> float:
        """Clearance-override rate over resolved-in-window decisions (0.0..1.0)."""
        if self.resolved_in_window <= 0:
            return 0.0
        return self.override_count / self.resolved_in_window


def summarize_decision_backlog(
    project_root: Path,
    *,
    now: datetime | None = None,
    window_days: int | None = None,
    events: list[dict[str, Any]] | None = None,
) -> DecisionBacklog:
    """Summarise the pending-decisions log into a :class:`DecisionBacklog`.

    The latest event per ``decision_id`` wins (the log is append-only and
    chronological). When *window_days* is provided, only decisions whose
    resolving event falls inside the trailing window contribute to the
    override / rework signal; the pending count is always the live backlog.
    """
    records = events if events is not None else read_decision_events(project_root)
    latest: dict[str, dict[str, Any]] = {}
    for event in records:
        decision_id = event.get("decision_id")
        if isinstance(decision_id, str) and decision_id:
            latest[decision_id] = event  # later events override earlier ones

    by_kind: dict[str, int] = {}
    pending_count = 0
    for event in latest.values():
        if event.get("status") == DECISION_STATUS_PENDING:
            pending_count += 1
            kind = event.get("kind") or "unspecified"
            by_kind[kind] = by_kind.get(kind, 0) + 1

    now_dt = now or datetime.now(UTC)
    resolved_in_window = 0
    override_count = 0
    p0_reversal = False
    for event in latest.values():
        if event.get("status") != DECISION_STATUS_RESOLVED:
            continue
        if window_days is not None:
            stamp = _parse_iso_ts(event.get("timestamp"))
            if stamp is None:
                continue
            age_days = (now_dt - stamp).total_seconds() / 86400.0
            if age_days < 0 or age_days > window_days:
                continue
        resolved_in_window += 1
        if event.get("override") is True:
            override_count += 1
        if event.get("p0_reversal") is True:
            p0_reversal = True
    return DecisionBacklog(
        pending_count=pending_count,
        by_kind=by_kind,
        resolved_in_window=resolved_in_window,
        override_count=override_count,
        p0_reversal_in_window=p0_reversal,
    )


def count_pending_decisions(
    project_root: Path, *, events: list[dict[str, Any]] | None = None
) -> int:
    """Convenience: the current pending-human-decisions backlog count."""
    return summarize_decision_backlog(project_root, events=events).pending_count


def pending_decisions_nudge_line(
    count: int, threshold: int = DEFAULT_PENDING_DECISIONS_THRESHOLD
) -> str:
    """Return the Tier-1 backlog nudge string, or ``""`` when at/under threshold.

    Shared by ``capacity:show`` and ``triage:welcome`` so the wording stays in
    lockstep across both surfaces.
    """
    if count <= threshold:
        return ""
    return (
        f"[TIER-1] pending human-clearance backlog: {count} decision(s) "
        f"awaiting adjudication (> threshold {threshold}). Tune wipCap to real "
        "review throughput or clear the backlog before dispatching more work."
    )


# Reviewer-disagreement routing (OQ4) -- reuse of the #526 errored-state path.


@dataclass(frozen=True)
class ReviewerRouting:
    """Routing decision for a multi-LLM reviewer disagreement (OQ4).

    ``escalates`` is the load-bearing field: when True the disagreement goes to
    a human and (via :func:`escalate_reviewer_disagreement`) increments the
    pending-decisions backlog. ``upgraded`` records the auto->review upgrade an
    contested P0 triggers.
    """

    severity: str
    requested_tier: str
    effective_tier: str
    escalates: bool
    required_human_reviewers: int
    upgraded: bool
    reason: str


def route_reviewer_disagreement(
    *, severity: str, tier: str, errored_on_head: bool = False
) -> ReviewerRouting:
    """Route a multi-LLM reviewer split per the OQ4 tier-interaction rule.

    * ``block`` -- fails closed: any reviewer split (or an errored-on-HEAD
      review) escalates to a human.
    * ``review`` -- a P0/P1 split or an errored-on-HEAD review escalates to 1
      human; a lower-severity split stays advisory and defers to ordering.
    * ``auto`` -- only a contested P0 (or errored-on-HEAD) upgrades the gate to
      ``review`` and escalates; lower-severity auto splits do not escalate.

    Advisory where it touches directive's own flow -- this returns the routing;
    it never fails the build closed.
    """
    sev = (severity or "").strip().lower()
    requested = (tier or "").strip().lower()
    escalating_sev = sev in _ESCALATING_SEVERITIES or errored_on_head

    if requested == "block":
        return ReviewerRouting(
            severity=sev,
            requested_tier="block",
            effective_tier="block",
            escalates=True,
            required_human_reviewers=1,
            upgraded=False,
            reason="block-tier reviewer split fails closed -- human sign-off required",
        )
    if requested == "review":
        if escalating_sev:
            # Distinguish the escalation trigger (mirrors the auto-tier branch
            # below): an errored-on-HEAD review on a low-severity split is not
            # a severity-driven escalation, so do not label it with `sev`.
            review_reason = (
                "errored-on-HEAD review on a review-tier gate escalates to 1 human"
                if errored_on_head and sev not in _ESCALATING_SEVERITIES
                else f"review-tier {sev or 'errored'} reviewer split escalates to 1 human"
            )
            return ReviewerRouting(
                severity=sev,
                requested_tier="review",
                effective_tier="review",
                escalates=True,
                required_human_reviewers=1,
                upgraded=False,
                reason=review_reason,
            )
        return ReviewerRouting(
            severity=sev,
            requested_tier="review",
            effective_tier="review",
            escalates=False,
            required_human_reviewers=0,
            upgraded=False,
            reason="review-tier reviewer split below P1 -- advisory, deferred to ordering",
        )
    if requested == "auto":
        if sev == "p0" or errored_on_head:
            # Distinguish the two auto->review upgrade triggers so the audit
            # reason is accurate (an errored-on-HEAD review is not a P0 split).
            auto_reason = (
                "errored-on-HEAD review on an auto-tier gate upgrades to "
                "review (1 human)"
                if errored_on_head and sev != "p0"
                else "contested P0 on an auto-tier gate upgrades to review (1 human)"
            )
            return ReviewerRouting(
                severity=sev,
                requested_tier="auto",
                effective_tier="review",
                escalates=True,
                required_human_reviewers=1,
                upgraded=True,
                reason=auto_reason,
            )
        return ReviewerRouting(
            severity=sev,
            requested_tier="auto",
            effective_tier="auto",
            escalates=False,
            required_human_reviewers=0,
            upgraded=False,
            reason="auto-tier reviewer split below P0 -- no escalation (advisory)",
        )
    # Unknown tier: be conservative and escalate when the severity warrants it.
    return ReviewerRouting(
        severity=sev,
        requested_tier=requested,
        effective_tier=requested,
        escalates=escalating_sev,
        required_human_reviewers=1 if escalating_sev else 0,
        upgraded=False,
        reason=(
            "unknown tier -- escalating on P0/P1 by default"
            if escalating_sev
            else "unknown tier -- no escalation"
        ),
    )


def escalate_reviewer_disagreement(
    project_root: Path,
    *,
    decision_id: str,
    severity: str,
    tier: str,
    errored_on_head: bool = False,
    reviewers: list[str] | None = None,
    actor: str = "agent",
    reason: str = "",
    now: datetime | None = None,
    log_path: Path | None = None,
) -> ReviewerRouting:
    """Route a reviewer split and, when it escalates, open a pending decision.

    Returns the :class:`ReviewerRouting`. When ``routing.escalates`` is True a
    ``pending`` event is appended to the backlog (incrementing the count); when
    it is False nothing is written (advisory, deferred to ordering).
    """
    routing = route_reviewer_disagreement(
        severity=severity, tier=tier, errored_on_head=errored_on_head
    )
    if routing.escalates:
        record_pending_decision(
            project_root,
            decision_id=decision_id,
            kind=REVIEWER_DISAGREEMENT_KIND,
            severity=routing.severity,
            reviewers=reviewers,
            actor=actor,
            reason=reason or routing.reason,
            now=now,
            log_path=log_path,
        )
    return routing


# Earned-autonomy dial ------------------------------------------------------

#: Dial levels, ordered conservative -> permissive. The dial advances one step
#: right and retreats one step left.
AUTONOMY_LEVELS: tuple[str, ...] = ("observe", "escalate", "execute")
DEFAULT_AUTONOMY_LEVEL: str = "escalate"

#: Recommendation actions emitted by :func:`recommend_autonomy_level`.
AUTONOMY_ACTION_ADVANCE: str = "advance"
AUTONOMY_ACTION_HOLD: str = "hold"
AUTONOMY_ACTION_RETREAT: str = "retreat"

#: Advance only when the clearance-override rate is STRICTLY below this.
DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX: float = 0.05
#: Retreat immediately when the override rate STRICTLY exceeds this.
DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE: float = 0.20
#: Rework-rate guardrail: advance only when rework <= this baseline.
DEFAULT_AUTONOMY_REWORK_BASELINE: float = 0.15
#: Minimum resolved-decision sample before an advance is considered.
DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE: int = 20


@dataclass(frozen=True)
class AutonomyPolicy:
    """Resolved ``plan.policy.autonomy`` state.

    ``source`` mirrors :class:`CapacityAllocation` semantics (``'typed'`` /
    ``'default'`` / ``'default-on-error'``). ``gate_levels`` carries optional
    per-gate-id level overrides on top of ``default_level``.
    """

    enabled: bool
    default_level: str
    min_sample_size: int
    advance_override_max: float
    retreat_override_rate: float
    rework_baseline: float
    gate_levels: dict[str, str]
    source: str  # one of: 'typed', 'default', 'default-on-error'
    error: str | None = None

    @property
    def configured(self) -> bool:
        """True when a well-formed ``autonomy`` block is present."""
        return self.source == "typed"

    def level_for(self, gate_id: str | None = None) -> str:
        """Resolved level for *gate_id* (per-gate override, else the default)."""
        if gate_id and gate_id in self.gate_levels:
            return self.gate_levels[gate_id]
        return self.default_level


@dataclass(frozen=True)
class AutonomyRecommendation:
    """Advisory autonomy-level recommendation. NEVER auto-applied (v1).

    ``advisory`` is True for every recommendation in v1 -- the dial RECOMMENDS
    a level flip and a human confirms it; nothing ratchets automatically.
    """

    current_level: str
    recommended_level: str
    action: str  # 'advance' | 'hold' | 'retreat'
    rationale: str
    gate_id: str | None = None
    advisory: bool = True

    @property
    def reduces_required_clearances(self) -> bool:
        """Advancing WOULD reduce required human clearances (if confirmed)."""
        return self.action == AUTONOMY_ACTION_ADVANCE

    @property
    def restores_required_clearances(self) -> bool:
        """Retreating restores required human clearances (if confirmed)."""
        return self.action == AUTONOMY_ACTION_RETREAT


def _validate_autonomy_gates(gates: Any) -> list[str]:
    """Validate the optional ``autonomy.gates`` per-gate-id level map."""
    if not isinstance(gates, dict):
        return [
            "plan.policy.autonomy.gates must be an object mapping gate-id -> level"
        ]
    errors: list[str] = []
    for gid, level in gates.items():
        if not isinstance(gid, str) or not gid.strip():
            errors.append(
                "plan.policy.autonomy.gates keys must be non-empty gate-id strings"
            )
        if level not in AUTONOMY_LEVELS:
            errors.append(
                f"plan.policy.autonomy.gates[{gid!r}] must be one of "
                f"{sorted(AUTONOMY_LEVELS)}; got {level!r}"
            )
    return errors


def validate_autonomy(value: Any) -> list[str]:
    """Validate a ``plan.policy.autonomy`` payload.

    Returns a list of error strings (empty == valid). ``None`` / unset is
    valid (the resolver falls back to the framework default).
    """
    errors: list[str] = []
    if value is None:
        return errors
    if not isinstance(value, dict):
        errors.append(
            f"plan.policy.autonomy must be an object; got {type(value).__name__}"
        )
        return errors
    if "enabled" in value and not isinstance(value["enabled"], bool):
        errors.append("plan.policy.autonomy.enabled must be a boolean")
    if "defaultLevel" in value and value["defaultLevel"] not in AUTONOMY_LEVELS:
        errors.append(
            "plan.policy.autonomy.defaultLevel must be one of "
            f"{sorted(AUTONOMY_LEVELS)}; got {value['defaultLevel']!r}"
        )
    if "minSampleSize" in value:
        mss = value["minSampleSize"]
        if not isinstance(mss, int) or isinstance(mss, bool) or mss < 0:
            errors.append(
                "plan.policy.autonomy.minSampleSize must be a non-negative "
                f"integer; got {mss!r}"
            )
    for key in ("advanceOverrideRateMax", "retreatOverrideRate", "reworkBaseline"):
        if key in value:
            rate = value[key]
            if not _is_number(rate) or not 0.0 <= float(rate) <= 1.0:
                errors.append(
                    f"plan.policy.autonomy.{key} must be a number between 0.0 "
                    f"and 1.0; got {rate!r}"
                )
    if "gates" in value:
        errors.extend(_validate_autonomy_gates(value["gates"]))
    return errors


def validate_autonomy_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.autonomy`` (#1419).

    Mirrors :func:`validate_capacity_allocation_on_plan`. Provided + unit-tested
    as the canonical validation entry point but intentionally NOT yet spliced
    into ``scripts/vbrief_validate.py`` -- the autonomy dial is advisory in v1
    and a malformed block self-heals to defaults, so wiring it into the
    ``task check`` validation aggregate (a fail-closed surface on the
    framework's own tree) is a follow-up slice's concern.
    """
    out: list[str] = []
    if not isinstance(plan, dict):
        return out
    policy = plan.get("policy")
    if not isinstance(policy, dict) or "autonomy" not in policy:
        return out
    for err in validate_autonomy(policy["autonomy"]):
        out.append(f"{filepath}: {err} (#1419)")
    return out


def _default_autonomy_policy(
    *, source: str, error: str | None = None
) -> AutonomyPolicy:
    return AutonomyPolicy(
        enabled=True,
        default_level=DEFAULT_AUTONOMY_LEVEL,
        min_sample_size=DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE,
        advance_override_max=DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX,
        retreat_override_rate=DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE,
        rework_baseline=DEFAULT_AUTONOMY_REWORK_BASELINE,
        gate_levels={},
        source=source,
        error=error,
    )


def resolve_autonomy(project_root: Path | None = None) -> AutonomyPolicy:
    """Resolve ``plan.policy.autonomy`` from PROJECT-DEFINITION.

    Resolution order (mirrors :func:`resolve_capacity_allocation`):

    1. A well-formed ``autonomy`` block -> ``'typed'``.
    2. Missing -> framework default (``'default'``).
    3. Present-but-malformed -> framework default (``'default-on-error'`` with
       ``error`` set so the caller can surface it).

    Pure-stdlib; no live ``gh`` / cache calls.
    """
    data, err = load_project_definition(project_root)
    if data is None:
        return _default_autonomy_policy(source="default", error=err)
    policy_block = _get_policy_block(data)
    if "autonomy" not in policy_block:
        return _default_autonomy_policy(source="default")
    raw = policy_block["autonomy"]
    errors = validate_autonomy(raw)
    if errors or not isinstance(raw, dict):
        return _default_autonomy_policy(
            source="default-on-error",
            error=errors[0] if errors else "autonomy must be an object",
        )
    gate_levels = {
        gid: level
        for gid, level in (raw.get("gates") or {}).items()
        if isinstance(gid, str)
    }
    return AutonomyPolicy(
        enabled=bool(raw.get("enabled", True)),
        default_level=raw.get("defaultLevel", DEFAULT_AUTONOMY_LEVEL),
        min_sample_size=int(raw.get("minSampleSize", DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE)),
        advance_override_max=float(
            raw.get("advanceOverrideRateMax", DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX)
        ),
        retreat_override_rate=float(
            raw.get("retreatOverrideRate", DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE)
        ),
        rework_baseline=float(
            raw.get("reworkBaseline", DEFAULT_AUTONOMY_REWORK_BASELINE)
        ),
        gate_levels=gate_levels,
        source="typed",
        error=None,
    )


def recommend_autonomy_level(
    current_level: str,
    *,
    override_rate: float,
    rework_rate: float,
    sample_size: int,
    p0_reversal: bool = False,
    policy: AutonomyPolicy | None = None,
    gate_id: str | None = None,
) -> AutonomyRecommendation:
    """Recommend an autonomy-level flip from the dial signal (ADVISORY-ONLY).

    Asymmetric:

    * RETREAT one step immediately on any P0 reversal OR an override rate above
      ``policy.retreat_override_rate`` (no sample-size gate -- safety first).
    * ADVANCE one step only when the resolved-decision sample meets
      ``policy.min_sample_size`` AND override rate is below
      ``policy.advance_override_max`` AND rework is within
      ``policy.rework_baseline``.
    * Otherwise HOLD.

    The returned recommendation is advisory: a human confirms the flip. This
    function NEVER mutates policy or required clearances.
    """
    pol = policy or _default_autonomy_policy(source="default")
    cur = current_level if current_level in AUTONOMY_LEVELS else pol.default_level
    idx = AUTONOMY_LEVELS.index(cur)

    # Asymmetric RETREAT -- fires immediately, no sample-size gate.
    if p0_reversal or override_rate > pol.retreat_override_rate:
        trigger = (
            "P0 reversal observed"
            if p0_reversal
            else (
                f"override rate {override_rate:.0%} > retreat threshold "
                f"{pol.retreat_override_rate:.0%}"
            )
        )
        if idx == 0:
            return AutonomyRecommendation(
                cur,
                cur,
                AUTONOMY_ACTION_HOLD,
                f"hold at {cur}: {trigger} but already at the most conservative "
                "level (Observe). ADVISORY: a human confirms.",
                gate_id,
            )
        return AutonomyRecommendation(
            cur,
            AUTONOMY_LEVELS[idx - 1],
            AUTONOMY_ACTION_RETREAT,
            f"retreat: {trigger} -- recommend {AUTONOMY_LEVELS[idx - 1]} "
            "(restores required human clearances). ADVISORY: a human confirms.",
            gate_id,
        )

    # Asymmetric ADVANCE -- gated on sample size + override + rework guardrail.
    advance_ok = (
        sample_size >= pol.min_sample_size
        and override_rate < pol.advance_override_max
        and rework_rate <= pol.rework_baseline
    )
    if advance_ok:
        basis = (
            f"override {override_rate:.0%} < {pol.advance_override_max:.0%}, "
            f"rework {rework_rate:.0%} <= baseline {pol.rework_baseline:.0%}, "
            f"sample {sample_size} >= {pol.min_sample_size}"
        )
        if idx == len(AUTONOMY_LEVELS) - 1:
            return AutonomyRecommendation(
                cur,
                cur,
                AUTONOMY_ACTION_HOLD,
                f"hold at {cur}: advance criteria met ({basis}) but already at "
                "the most permissive level (Execute).",
                gate_id,
            )
        return AutonomyRecommendation(
            cur,
            AUTONOMY_LEVELS[idx + 1],
            AUTONOMY_ACTION_ADVANCE,
            f"advance: {basis} -- recommend {AUTONOMY_LEVELS[idx + 1]} "
            "(would reduce required human clearances). ADVISORY: a human "
            "confirms; no auto-ratchet.",
            gate_id,
        )

    # HOLD -- neither retreat nor advance criteria met.
    return AutonomyRecommendation(
        cur,
        cur,
        AUTONOMY_ACTION_HOLD,
        f"hold at {cur}: override {override_rate:.0%}, rework {rework_rate:.0%}, "
        f"sample {sample_size} -- advance criteria not met, no retreat trigger.",
        gate_id,
    )


# Reconfiguration surface (used by tasks/policy.yml + slash commands) -----


def _now_iso() -> str:
    """ISO-8601 UTC timestamp with seconds precision."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_audit_log(project_root: Path, entry: str) -> Path:
    """Append a one-line audit entry to ``meta/policy-changes.log``.

    File is created (with a one-line header) if missing. Uses ``open(..., "a")``
    so the append is atomic on standard filesystems and concurrent writers
    cannot lose entries (#777 Greptile P2 review -- the previous
    read-modify-write pattern raced under parallel ``task policy:*`` calls).
    Pure stdlib + utf-8 write keeps PowerShell 5.1 / Windows out of the
    round-trip path.
    """
    log_path = project_root / AUDIT_LOG_REL_PATH
    log_path.parent.mkdir(parents=True, exist_ok=True)
    line = f"{_now_iso()} {entry}\n"
    # Header on first write only -- ``write_text`` is fine here because the
    # file is being created from scratch and there is no concurrent writer
    # to race with on the initial creation.
    if not log_path.exists():
        header = (
            "# meta/policy-changes.log -- audit trail for "
            "policy.allowDirectCommitsToMaster transitions (#746)\n"
        )
        log_path.write_text(header, encoding="utf-8")
    # Subsequent writes use append mode for atomicity.
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(line)
    return log_path


def set_policy(
    project_root: Path,
    *,
    allow_direct_commits: bool,
    actor: str = "agent",
    note: str = "",
) -> tuple[bool, str]:
    """Write the typed policy flag back to PROJECT-DEFINITION.

    Returns (changed, message). Performs an in-place edit (preserves all
    other keys). Migrates any legacy narrative key to the typed surface in
    the same write so the deprecation warning is satisfied.

    Raises FileNotFoundError when PROJECT-DEFINITION is missing -- the
    caller should produce a fail-closed message in that case (the
    bootstrap fallback in #746 acceptance criterion E).
    """
    path = project_definition_path(project_root)
    if not path.is_file():
        raise FileNotFoundError(f"PROJECT-DEFINITION not found at {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    plan = data.setdefault("plan", {})
    if not isinstance(plan, dict):
        raise ValueError("PROJECT-DEFINITION 'plan' is not an object")
    policy_block = plan.setdefault("policy", {})
    if not isinstance(policy_block, dict):
        raise ValueError("plan.policy is not an object")

    previous = policy_block.get("allowDirectCommitsToMaster")
    policy_block["allowDirectCommitsToMaster"] = bool(allow_direct_commits)

    # One-shot legacy migration: if the narrative key exists, drop it so the
    # typed surface is the only source of truth on subsequent reads.
    narratives = plan.get("narratives")
    legacy_dropped = False
    if isinstance(narratives, dict) and LEGACY_NARRATIVE_KEY in narratives:
        del narratives[LEGACY_NARRATIVE_KEY]
        legacy_dropped = True

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    changed = previous != bool(allow_direct_commits) or legacy_dropped
    parts = [
        f"actor={actor}",
        f"allowDirectCommitsToMaster={'true' if allow_direct_commits else 'false'}",
        f"previous={previous!r}",
    ]
    if legacy_dropped:
        parts.append("legacy-narrative-migrated=true")
    if note:
        # Sanitize note (strip newlines so log line stays single-line).
        parts.append("note=" + note.replace("\n", " ").replace("\r", " "))
    audit_entry = " ".join(parts)
    append_audit_log(project_root, audit_entry)
    return changed, audit_entry


def disclosure_line(result: PolicyResult) -> str:
    """One-liner disclosure phrasing for AGENTS.md / setup interview echo."""
    if result.allow_direct_commits:
        if result.source == "env-bypass":
            return (
                "[deft policy] DEFT_ALLOW_DEFAULT_BRANCH_COMMIT is set -- "
                "branch-protection policy bypassed for this session."
            )
        return (
            "[deft policy] Direct commits to the default branch are ENABLED "
            f"(source: {result.source}). Branch-protection policy is OFF."
        )
    if result.error:
        return (
            "[deft policy] Branch-protection policy is ON (fail-closed: "
            f"{result.error}). Direct commits to the default branch are blocked."
        )
    return (
        "[deft policy] Branch-protection policy is ON. Direct commits to the "
        "default branch are blocked. Use a feature branch."
    )


# ---------------------------------------------------------------------------
# Consolidated typed-policy inspector (#1148 / N8 of #1119 Wave-2d-1)
# ---------------------------------------------------------------------------
#
# ``task policy:show`` walks :data:`_REGISTERED_POLICIES` and renders one
# row per registered typed-policy field. Each inspector callable returns a
# :class:`PolicyField` carrying the field name, current effective value,
# framework default, and resolution source (``typed`` / ``default`` /
# ``legacy``). Future typed-flag children append their inspector to the
# constant; no consumer-side wiring required.
#
# Source semantics (per the #1148 issue body):
#
# * ``typed`` -- ``plan.policy.<field>`` is present and contributes the
#   effective value (for list fields this also requires a non-empty list
#   so an accidental ``triageScope: []`` does not masquerade as configured).
# * ``default`` -- ``plan.policy.<field>`` is absent, empty, or malformed.
#   The resolver fell back to the framework default.
# * ``legacy`` -- ONLY for ``allowDirectCommitsToMaster``: the typed key is
#   absent but the deprecated narrative key ``plan.narratives['Allow
#   direct commits to master']`` is present. Other fields never had a
#   pre-typed legacy shape so this state cannot fire for them.
#
# The CLI shim lives in :mod:`_policy_show_cli` so this module stays well
# under the 1000-line MUST cap from ``coding/coding.md``.

#: Canonical dotted-path names for every registered field. These are the
#: strings ``--field=<name>`` accepts and the keys ``--format=json`` emits.
FIELD_ALLOW_DIRECT_COMMITS: str = "plan.policy.allowDirectCommitsToMaster"
FIELD_WIP_CAP: str = "plan.policy.wipCap"
FIELD_TRIAGE_SCOPE: str = "plan.policy.triageScope"
FIELD_TRIAGE_SCOPE_IGNORES: str = "plan.policy.triageScopeIgnores"
FIELD_TRIAGE_RANKING_LABELS: str = "plan.policy.triageRankingLabels"
FIELD_TRIAGE_AUTO_CLASSIFY: str = "plan.policy.triageAutoClassify"
FIELD_TRIAGE_HOLD_MARKERS: str = "plan.policy.triageHoldMarkers"

#: Framework-default literals for the list-shaped policy fields. The
#: branch / WIP defaults are sourced from existing module constants
#: (:data:`DEFAULT_WIP_CAP`, the boolean ``False``).
DEFAULT_TRIAGE_SCOPE_VALUE: list[dict[str, Any]] = [{"rule": "all-open"}]
DEFAULT_TRIAGE_SCOPE_IGNORES_VALUE: list[Any] = []
DEFAULT_TRIAGE_RANKING_LABELS_VALUE: list[str] = []
DEFAULT_TRIAGE_AUTO_CLASSIFY_VALUE: list[Any] = []
#: Fallback mirror of :data:`scripts.triage_classify.DEFAULT_HOLD_MARKERS`
#: used when ``triage_classify`` is unimportable (stripped-down install).
#: The canonical source is :mod:`triage_classify`; this constant is the
#: belt-and-suspenders fallback for the show CLI ONLY.
_FALLBACK_HOLD_MARKERS: tuple[str, ...] = (
    "do not implement",
    "BLOCKED",
    "HOLDING",
    "Holding / capture only",
)


@dataclass(frozen=True)
class PolicyField:
    """One row in the :func:`inspect_all_policies` result.

    Fields:

    * ``name`` -- canonical dotted path (e.g. ``plan.policy.wipCap``).
    * ``current`` -- the effective value (what the corresponding resolver
      would return for downstream consumers).
    * ``default`` -- the framework default value for this field.
    * ``source`` -- one of ``'typed'`` / ``'default'`` / ``'legacy'``.
    """

    name: str
    current: Any
    default: Any
    source: str


def _get_plan(data: dict | None) -> dict[str, Any]:
    """Return ``data['plan']`` when it's a dict, else an empty dict."""
    if not isinstance(data, dict):
        return {}
    plan = data.get("plan")
    return plan if isinstance(plan, dict) else {}


def _get_policy_block(data: dict | None) -> dict[str, Any]:
    """Return ``data['plan']['policy']`` when it's a dict, else an empty dict."""
    policy = _get_plan(data).get("policy")
    return policy if isinstance(policy, dict) else {}


def _get_narratives(data: dict | None) -> dict[str, Any]:
    """Return ``data['plan']['narratives']`` when it's a dict, else empty."""
    narratives = _get_plan(data).get("narratives")
    return narratives if isinstance(narratives, dict) else {}


def _default_hold_markers() -> list[str]:
    """Return the framework default hold markers as a fresh list.

    Sources :data:`triage_classify.DEFAULT_HOLD_MARKERS` lazily so the
    show CLI stays importable on installs that strip the triage modules.
    Falls back to the in-module mirror :data:`_FALLBACK_HOLD_MARKERS`.
    """
    try:
        # Local import: avoid circular import at module load time and
        # tolerate stripped-down installs that lack triage_classify.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from triage_classify import DEFAULT_HOLD_MARKERS  # type: ignore[import-not-found]

        return list(DEFAULT_HOLD_MARKERS)
    except Exception:  # noqa: BLE001 -- defensive; fall back to mirror
        return list(_FALLBACK_HOLD_MARKERS)


def _inspect_allow_direct_commits(
    data: dict | None, project_root: Path
) -> PolicyField:
    """Inspect ``plan.policy.allowDirectCommitsToMaster`` (#746)."""
    policy_block = _get_policy_block(data)
    if "allowDirectCommitsToMaster" in policy_block:
        raw = policy_block["allowDirectCommitsToMaster"]
        current = raw if isinstance(raw, bool) else False
        return PolicyField(
            name=FIELD_ALLOW_DIRECT_COMMITS,
            current=current,
            default=False,
            source="typed",
        )
    narratives = _get_narratives(data)
    if LEGACY_NARRATIVE_KEY in narratives:
        coerced, _raw = _coerce_legacy_narrative(narratives[LEGACY_NARRATIVE_KEY])
        return PolicyField(
            name=FIELD_ALLOW_DIRECT_COMMITS,
            current=coerced,
            default=False,
            source="legacy",
        )
    return PolicyField(
        name=FIELD_ALLOW_DIRECT_COMMITS,
        current=False,
        default=False,
        source="default",
    )


def _inspect_wip_cap(data: dict | None, project_root: Path) -> PolicyField:
    """Inspect ``plan.policy.wipCap`` (#1124 / D4 of #1119)."""
    policy_block = _get_policy_block(data)
    if "wipCap" in policy_block:
        raw = policy_block["wipCap"]
        if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
            current: int = raw
        else:
            # Malformed -- resolver falls back to the default at runtime;
            # surface that here for honest reporting.
            current = DEFAULT_WIP_CAP
        return PolicyField(
            name=FIELD_WIP_CAP,
            current=current,
            default=DEFAULT_WIP_CAP,
            source="typed",
        )
    return PolicyField(
        name=FIELD_WIP_CAP,
        current=DEFAULT_WIP_CAP,
        default=DEFAULT_WIP_CAP,
        source="default",
    )


def _list_field_inspector(
    data: dict | None,
    key: str,
    name: str,
    default_value: list[Any],
    *,
    empty_is_typed: bool = False,
) -> PolicyField:
    """Shared helper for the list-shaped typed-policy fields.

    The matching resolvers in :mod:`triage_scope`,
    :mod:`triage_queue`, :mod:`triage_classify`, and
    :mod:`_triage_scope_ignores` treat an empty / non-list value as
    "unset" and fall back to the framework default. Mirror that
    semantic here so ``source`` agrees with what the consumer-side
    resolver actually returns. ``empty_is_typed=True`` is reserved for
    ``triageHoldMarkers`` where an empty list is a meaningful operator
    opt-out (silence the hold-marker rule entirely; see #1129
    Decision 3).
    """
    policy_block = _get_policy_block(data)
    if key not in policy_block:
        return PolicyField(
            name=name,
            current=list(default_value),
            default=list(default_value),
            source="default",
        )
    raw = policy_block[key]
    if not isinstance(raw, list):
        return PolicyField(
            name=name,
            current=list(default_value),
            default=list(default_value),
            source="default",
        )
    if not raw and not empty_is_typed:
        return PolicyField(
            name=name,
            current=list(default_value),
            default=list(default_value),
            source="default",
        )
    # Drop empty-string / non-string entries the same way the
    # triage_classify resolver does so what we render matches what
    # downstream consumers see.
    if empty_is_typed and all(isinstance(s, str) for s in raw):
        cleaned: list[Any] = [s for s in raw if isinstance(s, str) and s.strip()]
        return PolicyField(
            name=name,
            current=cleaned,
            default=list(default_value),
            source="typed",
        )
    return PolicyField(
        name=name,
        current=list(raw),
        default=list(default_value),
        source="typed",
    )


def _inspect_triage_scope(data: dict | None, project_root: Path) -> PolicyField:
    """Inspect ``plan.policy.triageScope`` (#1131 / D12 of #1119)."""
    return _list_field_inspector(
        data,
        key="triageScope",
        name=FIELD_TRIAGE_SCOPE,
        default_value=DEFAULT_TRIAGE_SCOPE_VALUE,
    )


def _inspect_triage_scope_ignores(
    data: dict | None, project_root: Path
) -> PolicyField:
    """Inspect ``plan.policy.triageScopeIgnores`` (#1133 / D14 + #1182 / D14c)."""
    return _list_field_inspector(
        data,
        key="triageScopeIgnores",
        name=FIELD_TRIAGE_SCOPE_IGNORES,
        default_value=DEFAULT_TRIAGE_SCOPE_IGNORES_VALUE,
    )


def _inspect_triage_ranking_labels(
    data: dict | None, project_root: Path
) -> PolicyField:
    """Inspect ``plan.policy.triageRankingLabels`` (#1128 / D11 of #1119)."""
    return _list_field_inspector(
        data,
        key="triageRankingLabels",
        name=FIELD_TRIAGE_RANKING_LABELS,
        default_value=DEFAULT_TRIAGE_RANKING_LABELS_VALUE,
    )


def _inspect_triage_auto_classify(
    data: dict | None, project_root: Path
) -> PolicyField:
    """Inspect ``plan.policy.triageAutoClassify`` (#1129 / D10 of #1119)."""
    return _list_field_inspector(
        data,
        key="triageAutoClassify",
        name=FIELD_TRIAGE_AUTO_CLASSIFY,
        default_value=DEFAULT_TRIAGE_AUTO_CLASSIFY_VALUE,
    )


def _inspect_triage_hold_markers(
    data: dict | None, project_root: Path
) -> PolicyField:
    """Inspect ``plan.policy.triageHoldMarkers`` (#1129 / D10 of #1119).

    Default is :data:`triage_classify.DEFAULT_HOLD_MARKERS` (4 universal
    phrases). An EXPLICIT empty list is a legitimate operator opt-out
    state (silences the hold-marker universal rule entirely) per
    Decision 3 of #1129 -- ``empty_is_typed=True`` preserves that
    distinction in the show output.
    """
    return _list_field_inspector(
        data,
        key="triageHoldMarkers",
        name=FIELD_TRIAGE_HOLD_MARKERS,
        default_value=_default_hold_markers(),
        empty_is_typed=True,
    )


#: Registered typed-policy inspectors. Future typed-flag children append
#: a new ``_inspect_<field>`` callable here AND its definition above; the
#: show CLI surfaces it automatically with no other wiring. Append-only
#: by convention; reorders churn user-visible output ordering.
#:
#: NOTE (#1419): ``plan.policy.capacityAllocation`` is DELIBERATELY not
#: registered here. This registry is the row-per-scalar/list ``task
#: policy:show`` surface; ``capacityAllocation`` is a composite object
#: (buckets[], window, unit, ...) whose state has its own dedicated,
#: richer rendering via ``task capacity:show`` (``scripts/capacity_show.py``).
#: Flattening it into a single ``policy:show`` row would lose that detail,
#: so it is surfaced through the capacity engine instead.
_REGISTERED_POLICIES: tuple[
    Callable[[dict | None, Path], PolicyField], ...
] = (
    _inspect_allow_direct_commits,
    _inspect_wip_cap,
    _inspect_triage_scope,
    _inspect_triage_scope_ignores,
    _inspect_triage_ranking_labels,
    _inspect_triage_auto_classify,
    _inspect_triage_hold_markers,
)


def inspect_all_policies(
    project_root: Path | None = None,
) -> list[PolicyField]:
    """Walk :data:`_REGISTERED_POLICIES` and return one row per field.

    Loads PROJECT-DEFINITION exactly once so every inspector reads from
    the same in-memory snapshot. Missing / malformed PROJECT-DEFINITION
    is tolerated -- every inspector returns its default-source row in
    that case. The returned list preserves the registration order.
    """
    root = project_root or Path.cwd()
    data, _err = load_project_definition(root)
    return [inspect(data, root) for inspect in _REGISTERED_POLICIES]


def inspect_one_policy(
    name: str, project_root: Path | None = None
) -> PolicyField | None:
    """Look up a single registered field by canonical dotted-path name.

    Returns ``None`` when ``name`` is not a registered field so callers
    (the CLI shim) can surface an actionable error. ``name`` matching is
    exact -- no abbreviation / case-folding -- so scripts that parse
    ``--format=json`` and re-query a specific field cannot silently
    drift onto an unintended field.
    """
    fields = inspect_all_policies(project_root)
    for field in fields:
        if field.name == name:
            return field
    return None


def registered_policy_names() -> list[str]:
    """Return the canonical names of every registered typed-policy field.

    Cheap discovery surface for the CLI shim's ``--field=<name>`` error
    message and for future typed-flag tests that want to assert their
    field landed in :data:`_REGISTERED_POLICIES`.
    """
    # Run the inspectors against a None project_root so we get the
    # registered names without touching the filesystem.
    return [
        inspect(None, Path.cwd()).name for inspect in _REGISTERED_POLICIES
    ]


def main(argv: list[str] | None = None) -> int:
    """CLI: ``python -m scripts.policy show`` for diagnostics / shell scripts."""
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        print("Usage: python -m scripts.policy show [--project-root <path>]")
        return 0
    if args[0] != "show":
        print(f"Unknown subcommand: {args[0]}", file=sys.stderr)
        return 2
    project_root = Path.cwd()
    if "--project-root" in args:
        idx = args.index("--project-root")
        if idx + 1 >= len(args):
            print("--project-root requires a value", file=sys.stderr)
            return 2
        project_root = Path(args[idx + 1])
    result = resolve_policy(project_root)
    print(f"allowDirectCommitsToMaster={str(result.allow_direct_commits).lower()}")
    print(f"source={result.source}")
    if result.deprecation_warning:
        print(f"warning={result.deprecation_warning}")
    if result.error:
        print(f"error={result.error}")
    print(disclosure_line(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
