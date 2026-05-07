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


@dataclass(frozen=True)
class PolicyResult:
    """Resolved policy state. ``source`` documents which surface won."""

    allow_direct_commits: bool
    source: str  # one of: 'typed', 'legacy-narrative', 'env-bypass', 'default-fail-closed'
    deprecation_warning: str | None = None
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
