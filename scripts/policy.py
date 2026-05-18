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


# Reconfiguration surface (used by tasks/policy.yml + slash commands) -----


def _now_iso() -> str:
    """ISO-8601 UTC timestamp with seconds precision."""
    from datetime import UTC, datetime

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
