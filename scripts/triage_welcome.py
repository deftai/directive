#!/usr/bin/env python3
"""triage_welcome.py -- ``task triage:welcome`` 6-phase onboarding ritual (#1143).

N3 child of the #1119 Wave-2a swarm. Consolidates the half-dozen verbs a
v0.26 consumer must learn after upgrading to v0.27 (`triage:bootstrap`,
`triage:scope`, policy writes for `wipCap`, `scope:demote --batch`,
`triage:summary`, the new triage skill) into a single idempotent walkthrough.

Six phases, each detection-bound so a partial re-run resumes cleanly:

1. **Detect prior state** -- read ``vbrief/PROJECT-DEFINITION.vbrief.json``
   for ``plan.policy.triageScope[]`` and ``plan.policy.wipCap``; walk the
   unified ``.deft-cache/<source>/<owner>/<repo>/`` cache (#883 Story 2);
   count vBRIEFs in ``vbrief/pending/`` + ``vbrief/active/``.
2. **Prompt subscription scope** -- numbered menu (Small / Mid / Mega) per
   :doc:`contracts/deterministic-questions.md`; writes the typed array
   ``plan.policy.triageScope[]`` (#1131 / D12) via :func:`write_triage_scope`.
   Skipped when already set.
3. **Run ``task triage:bootstrap``** -- subprocess hop into the existing
   D10 (#1129) / cache (#883) bootstrap. Skipped when the cache is
   already populated.
4. **Prompt ``wipCap``** -- numbered menu (8 / 10 / 15 / custom); default
   = **10** per umbrella Current Shape v3 (NOT 12 from the stale issue
   body wording). Writes ``plan.policy.wipCap`` via
   :func:`write_wip_cap`. Skipped when already set.
5. **Offer WIP relief** -- when ``vbrief/pending/ + vbrief/active/``
   exceeds the chosen cap, preview the planned
   ``task scope:demote --batch --older-than-days 30`` (#1121 / D1)
   relief invocation; require explicit confirmation before the real run.
6. **Final summary** -- emit ``task triage:summary`` (#1122 / D2) and
   point the operator at ``skills/deft-directive-triage/SKILL.md`` (#1130).

The ritual is pure-stdlib so it runs on a fresh worktree before ``uv sync``
has executed (the parent Taskfile dispatch already brings up the env).
Inputs are stdin-driven for end-to-end CLI use but every phase accepts
injected ``input_fn`` / ``output_fn`` for the test suite to drive
deterministically.

D4 (#1124, parallel-wave) ships the dedicated ``policy_set.py wip-cap``
subcommand for the typed-flag writer surface. Until then this module
hand-rolls the write (mirroring :mod:`policy`'s ``set_policy`` shape) and
the follow-up swap to D4's surface lands as a small refactor once D4
merges.
"""

from __future__ import annotations

import contextlib
import json
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked as
# ``python scripts/triage_welcome.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the prompts emit ⊗ / · / arrows / checkmarks.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Filesystem-relative location of the PROJECT-DEFINITION vBRIEF.
PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"

#: Canonical cache root + source (mirrors ``scripts/triage_summary.py``).
CACHE_DIR_NAME: str = ".deft-cache"
CACHE_SOURCE: str = "github-issue"

#: vBRIEF lifecycle folders that contribute to the WIP count.
WIP_LIFECYCLE_DIRS: tuple[str, ...] = ("pending", "active")

#: Audit log written by :func:`write_triage_scope` and :func:`write_wip_cap`.
#: Mirrors the location :mod:`policy` uses for branch-policy audit so
#: a future operator can grep one file for every policy mutation.
AUDIT_LOG_REL_PATH: str = "meta/policy-changes.log"

#: Default WIP cap per umbrella #1119 Current Shape v3 (comment 4471269010).
#: The legacy issue-body wording (``12``) is superseded; see #1124 / D4.
DEFAULT_WIP_CAP: int = 10

#: WIP-relief preview default age window (days). Issue body cites 30; the
#: companion D1 (#1121) default is 45 -- N3 honours the issue-body number
#: because welcome's job is consolidation, not policy. Override via the
#: relief prompt's `--older-than-days N` follow-up.
DEFAULT_RELIEF_AGE_DAYS: int = 30

#: Canonical pointer to the triage skill (#1130 / D6).
TRIAGE_SKILL_PATH: str = "skills/deft-directive-triage/SKILL.md"

#: Path to the framework's deterministic-questions contract.
DETERMINISTIC_QUESTIONS_PATH: str = "contracts/deterministic-questions.md"

#: Subscription preset rule shapes -- frozen per the issue body. The
#: framework default per the umbrella §12 framework-vs-consumer-config
#: boundary is ``[{"rule": "all-open"}]`` (Small). Mid and Mega are
#: consumer-agnostic generic shapes; deft-specific values live in
#: #1186 consumer-example (Wave-2e, intentionally separate).
SUBSCRIPTION_PRESETS: dict[str, list[dict[str, Any]]] = {
    "small": [{"rule": "all-open"}],
    "mid": [
        {
            "rule": "labels",
            "any-of": ["urgent", "breaking", "security", "p0", "p1"],
        },
        {"rule": "opened-since", "duration": "60d"},
    ],
    "mega": [
        {"rule": "explicit-watch", "issues": []},
        {"rule": "referenced-by-vbrief", "scope": "active"},
    ],
}

#: Audit sigil written to ``meta/policy-changes.log`` for triage-welcome.
WELCOME_AUDIT_TAG: str = "triage-welcome"


# ---------------------------------------------------------------------------
# Dataclass: detected prior state (Phase 1 output)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PriorState:
    """Snapshot of the four state probes Phase 1 needs."""

    triage_scope_set: bool
    triage_scope_summary: str  # human-readable label (e.g. "unset" / "Mid")
    cache_empty: bool
    cache_entry_count: int
    wip_cap_set: bool
    wip_cap: int  # current value OR the DEFAULT_WIP_CAP fallback
    wip_count: int  # pending/ + active/


# ---------------------------------------------------------------------------
# Helpers: PROJECT-DEFINITION reader + audit-log writer
# ---------------------------------------------------------------------------


def project_definition_path(project_root: Path | None = None) -> Path:
    """Absolute path to ``vbrief/PROJECT-DEFINITION.vbrief.json``."""
    root = project_root or Path.cwd()
    return root / PROJECT_DEFINITION_REL_PATH


def _load_project_definition(project_root: Path) -> dict[str, Any] | None:
    """Tolerant reader -- returns None on missing / malformed file."""
    path = project_definition_path(project_root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or datetime.now(UTC)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_audit_entry(project_root: Path, entry: str) -> Path:
    """Append a one-line audit entry to ``meta/policy-changes.log``.

    Atomic append-mode write (mirrors :func:`policy.append_audit_log`) so
    concurrent welcome runs cannot lose entries on a torn write.
    """
    log_path = project_root / AUDIT_LOG_REL_PATH
    log_path.parent.mkdir(parents=True, exist_ok=True)
    line = f"{_utc_iso()} {entry}\n"
    if not log_path.exists():
        header = (
            "# meta/policy-changes.log -- audit trail for "
            "PROJECT-DEFINITION plan.policy.* mutations (#746 / #1143)\n"
        )
        log_path.write_text(header, encoding="utf-8")
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(line)
    return log_path


# ---------------------------------------------------------------------------
# Phase 1 -- prior-state detection
# ---------------------------------------------------------------------------


def _count_cache_entries(project_root: Path) -> int:
    base = project_root / CACHE_DIR_NAME / CACHE_SOURCE
    if not base.is_dir():
        return 0
    count = 0
    for owner_dir in base.iterdir():
        if not owner_dir.is_dir():
            continue
        for repo_dir in owner_dir.iterdir():
            if not repo_dir.is_dir():
                continue
            for entry in repo_dir.iterdir():
                if entry.is_dir() and entry.name.isdecimal():
                    count += 1
    return count


def _count_wip(project_root: Path) -> int:
    total = 0
    root = project_root / "vbrief"
    for sub in WIP_LIFECYCLE_DIRS:
        folder = root / sub
        if not folder.is_dir():
            continue
        total += sum(
            1
            for child in folder.iterdir()
            if child.is_file() and child.name.endswith(".vbrief.json")
        )
    return total


def _summarize_scope(rules: list[dict[str, Any]] | None) -> tuple[bool, str]:
    """Return ``(set, label)`` for the operator-visible scope display."""
    if not rules:
        return False, "unset (default applied -- all-open)"
    if rules == SUBSCRIPTION_PRESETS["small"]:
        return True, "Small (all-open)"
    if rules == SUBSCRIPTION_PRESETS["mid"]:
        return True, "Mid (curated labels + opened-since 60d)"
    # Compare without the (possibly populated) explicit-watch issues list.
    mega_baseline = [dict(r) for r in SUBSCRIPTION_PRESETS["mega"]]
    if len(rules) == len(mega_baseline):
        match = True
        for live, baseline in zip(rules, mega_baseline, strict=False):
            if live.get("rule") != baseline.get("rule"):
                match = False
                break
        if match:
            return True, "Mega (explicit-watch + referenced-by-vbrief)"
    return True, f"custom ({len(rules)} rule(s))"


def detect_prior_state(project_root: Path) -> PriorState:
    """Read every Phase 1 probe in one pass. Pure -- no writes."""
    data = _load_project_definition(project_root) or {}
    plan = data.get("plan") if isinstance(data, dict) else None
    policy = plan.get("policy") if isinstance(plan, dict) else None
    raw_scope = policy.get("triageScope") if isinstance(policy, dict) else None
    scope_rules = raw_scope if isinstance(raw_scope, list) else None

    raw_cap = policy.get("wipCap") if isinstance(policy, dict) else None
    if isinstance(raw_cap, int) and not isinstance(raw_cap, bool) and raw_cap >= 0:
        wip_cap = raw_cap
        wip_cap_set = True
    else:
        wip_cap = DEFAULT_WIP_CAP
        wip_cap_set = False

    scope_set, scope_label = _summarize_scope(scope_rules)
    cache_count = _count_cache_entries(project_root)
    return PriorState(
        triage_scope_set=scope_set,
        triage_scope_summary=scope_label,
        cache_empty=cache_count == 0,
        cache_entry_count=cache_count,
        wip_cap_set=wip_cap_set,
        wip_cap=wip_cap,
        wip_count=_count_wip(project_root),
    )


# ---------------------------------------------------------------------------
# Phase 2 -- subscription scope writer (typed-flag pattern via #1131 surface)
# ---------------------------------------------------------------------------


def write_triage_scope(
    project_root: Path,
    rules: list[dict[str, Any]],
    *,
    preset_label: str,
    actor: str = WELCOME_AUDIT_TAG,
) -> tuple[bool, str]:
    """In-place set ``plan.policy.triageScope`` to *rules*.

    Returns ``(changed, audit_entry)``. Audit entry is appended whether
    the value changed or not (the trail matters for re-run analysis).

    Schema validation runs through ``scripts.triage_scope.validate_scope_rules``
    when importable; a validation failure surfaces a clear error and refuses
    the write. Pure-stdlib otherwise so the script runs without uv on PATH.
    """
    path = project_definition_path(project_root)
    if not path.is_file():
        raise FileNotFoundError(f"PROJECT-DEFINITION not found at {path}")

    # Best-effort schema check via D12's validator. Tolerant of ImportError
    # ONLY (e.g. triage_scope not yet on sys.path because uv sync has not
    # run). Any other exception class -- SyntaxError, AttributeError, name
    # collisions, validation ValueErrors -- MUST propagate so the caller
    # learns about the real bug instead of silently dropping schema checks.
    _validate = None
    try:
        from triage_scope import (  # type: ignore[import-not-found]
            validate_scope_rules as _validate,
        )
    except ImportError:
        _validate = None
    if _validate is not None:
        errors, _warnings = _validate(rules)
        if errors:
            joined = "; ".join(errors)
            raise ValueError(f"plan.policy.triageScope schema errors: {joined}")

    data = json.loads(path.read_text(encoding="utf-8"))
    plan = data.setdefault("plan", {})
    if not isinstance(plan, dict):
        raise ValueError("PROJECT-DEFINITION 'plan' is not an object")
    policy = plan.setdefault("policy", {})
    if not isinstance(policy, dict):
        raise ValueError("plan.policy is not an object")
    previous = policy.get("triageScope")
    policy["triageScope"] = rules
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    changed = previous != rules
    audit_parts = [
        f"actor={actor}",
        "field=plan.policy.triageScope",
        f"preset={preset_label}",
        f"rule_count={len(rules)}",
        f"changed={'true' if changed else 'false'}",
    ]
    audit_entry = " ".join(audit_parts)
    append_audit_entry(project_root, audit_entry)
    return changed, audit_entry


# ---------------------------------------------------------------------------
# Phase 4 -- wipCap writer (hand-rolled until D4 / #1124 lands its surface)
# ---------------------------------------------------------------------------


def write_wip_cap(
    project_root: Path,
    wip_cap: int,
    *,
    actor: str = WELCOME_AUDIT_TAG,
) -> tuple[bool, str]:
    """In-place set ``plan.policy.wipCap`` to *wip_cap*.

    Hand-rolled because D4 (#1124) ships in parallel; once D4's
    ``policy_set.py wip-cap`` subcommand lands the body here becomes a
    thin subprocess delegation. The function signature is the contract.
    """
    if not isinstance(wip_cap, int) or isinstance(wip_cap, bool) or wip_cap < 1:
        raise ValueError(f"wipCap must be a positive int, got {wip_cap!r}")
    path = project_definition_path(project_root)
    if not path.is_file():
        raise FileNotFoundError(f"PROJECT-DEFINITION not found at {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    plan = data.setdefault("plan", {})
    if not isinstance(plan, dict):
        raise ValueError("PROJECT-DEFINITION 'plan' is not an object")
    policy = plan.setdefault("policy", {})
    if not isinstance(policy, dict):
        raise ValueError("plan.policy is not an object")
    previous = policy.get("wipCap")
    policy["wipCap"] = wip_cap
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    changed = previous != wip_cap
    audit_entry = (
        f"actor={actor} field=plan.policy.wipCap "
        f"value={wip_cap} previous={previous!r} "
        f"changed={'true' if changed else 'false'}"
    )
    append_audit_entry(project_root, audit_entry)
    return changed, audit_entry


# ---------------------------------------------------------------------------
# Phase 5 -- WIP-relief preview
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReliefPreview:
    """Synthetic preview of a planned `scope:demote --batch` invocation."""

    older_than_days: int
    eligible_count: int
    eligible_files: tuple[str, ...]
    skipped_count: int


def preview_wip_relief(
    project_root: Path,
    older_than_days: int = DEFAULT_RELIEF_AGE_DAYS,
) -> ReliefPreview:
    """Walk ``vbrief/pending/`` and classify each vBRIEF by age.

    Mirrors :func:`scope_demote.batch_demote`'s eligibility check without
    invoking the writer. Pure -- the script consumes this to render the
    `--dry-run` preview the issue body requires before any real demote.
    """
    pending_dir = project_root / "vbrief" / "pending"
    if not pending_dir.is_dir():
        return ReliefPreview(older_than_days, 0, (), 0)

    now = datetime.now(UTC)
    eligible: list[str] = []
    skipped = 0
    for candidate in sorted(pending_dir.glob("*.vbrief.json")):
        days = _days_in_pending(candidate, now)
        if days >= older_than_days:
            eligible.append(candidate.name)
        else:
            skipped += 1
    return ReliefPreview(
        older_than_days=older_than_days,
        eligible_count=len(eligible),
        eligible_files=tuple(eligible),
        skipped_count=skipped,
    )


def _days_in_pending(path: Path, now: datetime) -> int:
    """Approximate days-in-pending using ``plan.updated`` then file mtime."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        plan = data.get("plan") if isinstance(data, dict) else None
        raw = plan.get("updated") if isinstance(plan, dict) else None
        if isinstance(raw, str):
            text = raw.strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            try:
                stamp = datetime.fromisoformat(text)
            except ValueError:
                stamp = None
            if stamp is not None:
                delta = now - stamp.astimezone(UTC)
                return max(0, int(delta.total_seconds() // 86400))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        pass
    try:
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
        return max(0, int((now - mtime).total_seconds() // 86400))
    except OSError:
        return 0


# ---------------------------------------------------------------------------
# Subprocess dispatch (Phase 3 + Phase 5 + Phase 6)
# ---------------------------------------------------------------------------


def _run_task(args: list[str], *, cwd: Path) -> int:
    """Run ``task <args...>``. Returns exit code; never raises on non-zero."""
    cmd = ["task", *args]
    try:
        result = subprocess.run(cmd, cwd=str(cwd), check=False)
        return result.returncode
    except FileNotFoundError:
        sys.stderr.write(
            "  [triage:welcome] WARN: `task` not on PATH -- skipping the "
            f"subprocess hop ({' '.join(cmd)}). Re-run with the deft "
            "toolchain available to chain the remaining phases.\n"
        )
        return 127


# ---------------------------------------------------------------------------
# Interactive prompt helpers + CLI argparse shim live in
# ``scripts/_triage_welcome_cli.py`` so this module stays under the
# 500-line SHOULD ceiling from ``coding/coding.md``. The names below are
# re-exported for backward compatibility with importers / tests that
# reference them via ``triage_welcome.<name>``.
# ---------------------------------------------------------------------------

from _triage_welcome_cli import (  # noqa: E402  (sibling import after sys.path tweak)
    PromptOutcome,
    default_input,
    default_output,
    prompt_int,
    prompt_menu,
    prompt_yes_no,
)

# Re-export names for callers / tests that read them off this module.
__all__ = [
    "PromptOutcome",
    "PriorState",
    "ReliefPreview",
    "WelcomeOutcome",
    "SUBSCRIPTION_PRESETS",
    "DEFAULT_WIP_CAP",
    "DEFAULT_RELIEF_AGE_DAYS",
    "AUDIT_LOG_REL_PATH",
    "CACHE_DIR_NAME",
    "CACHE_SOURCE",
    "TRIAGE_SKILL_PATH",
    "WELCOME_AUDIT_TAG",
    "PROJECT_DEFINITION_REL_PATH",
    "WIP_LIFECYCLE_DIRS",
    "detect_prior_state",
    "write_triage_scope",
    "write_wip_cap",
    "preview_wip_relief",
    "run_welcome",
    "main",
    "prompt_menu",
    "prompt_yes_no",
    "prompt_int",
    "default_input",
    "default_output",
    "append_audit_entry",
    "project_definition_path",
]

# Backward-compatible private aliases kept for any future call site.
_default_input = default_input
_default_output = default_output


# ---------------------------------------------------------------------------
# Ritual orchestrator
# ---------------------------------------------------------------------------


@dataclass
class WelcomeOutcome:
    """End-of-run summary for tests / dispatcher consumers."""

    phases_run: list[int] = field(default_factory=list)
    phases_skipped: list[int] = field(default_factory=list)
    subscription_choice: str | None = None
    wip_cap_choice: int | None = None
    relief_offered: bool = False
    relief_confirmed: bool = False
    discussed_at_phase: int | None = None
    exit_code: int = 0


def run_welcome(
    project_root: Path,
    *,
    input_fn: Callable[[str], str] | None = None,
    output_fn: Callable[[str], None] | None = None,
    run_subprocess: bool = True,
) -> WelcomeOutcome:
    """Execute the 6-phase ritual. Returns a structured outcome.

    Phases 1-6 run inside a single ``while True`` loop driven by a
    ``phase`` counter so the deterministic-questions ``Back`` semantic
    ("re-render the prior question") works correctly: a Back selection
    at Phase 4 rewinds to Phase 2 and the loop re-enters the interactive
    menu (the ``force_re_prompt_*`` flags override the
    already-set-skip on the rewind iteration). A Discuss selection halts
    the loop and returns immediately. Subprocess failures in Phases 3
    and 5 set ``outcome.exit_code = 2`` so callers learn the ritual
    encountered a problem, matching Phase 2 / Phase 4 writer semantics.
    """
    in_fn = input_fn or default_input
    out_fn = output_fn or default_output
    outcome = WelcomeOutcome()

    # ``Back`` overrides the "already set, skip" rule for ONE iteration so
    # the operator can re-answer the question they rewound to. Consumed at
    # the top of the corresponding phase block.
    force_re_prompt_phase_2 = False
    force_re_prompt_phase_4 = False

    # Tracking sets prevent duplicate phases_run / phases_skipped entries
    # when the loop revisits a phase via Back.
    phases_run_seen: set[int] = set()
    phases_skipped_seen: set[int] = set()

    def _record_run(n: int) -> None:
        if n not in phases_run_seen:
            phases_run_seen.add(n)
            outcome.phases_run.append(n)

    def _record_skipped(n: int) -> None:
        if n not in phases_skipped_seen:
            phases_skipped_seen.add(n)
            outcome.phases_skipped.append(n)

    phase = 1
    while phase <= 6:
        if phase == 1:
            out_fn("[1/6] Detecting prior state...")
            state = detect_prior_state(project_root)
            out_fn(f"  triageScope: {state.triage_scope_summary}")
            out_fn(
                f"  cache: {state.cache_entry_count} entry/entries "
                f"({'empty' if state.cache_empty else 'populated'})"
            )
            if state.wip_cap_set:
                out_fn(f"  wipCap: set ({state.wip_cap})")
            else:
                out_fn(
                    f"  wipCap: unset (default applied -- {DEFAULT_WIP_CAP})"
                )
            out_fn(f"  WIP (pending/+active/): {state.wip_count}")
            _record_run(1)
            phase = 2
            continue

        if phase == 2:
            state = detect_prior_state(project_root)
            if state.triage_scope_set and not force_re_prompt_phase_2:
                out_fn(
                    f"[2/6] Subscription scope already set "
                    f"({state.triage_scope_summary}); skipping."
                )
                _record_skipped(2)
                phase = 3
                continue
            force_re_prompt_phase_2 = False
            sub_outcome = prompt_menu(
                title="[2/6] Choose subscription scope:",
                options=[
                    ("Small -- all open issues (recommended <200)", "small"),
                    (
                        "Mid   -- curated labels (urgent/breaking/security/p0/p1) "
                        "+ opened-since 60d (recommended 200-2000)",
                        "mid",
                    ),
                    (
                        "Mega  -- explicit-watch + referenced-by-vbrief only "
                        "(recommended 2000+)",
                        "mega",
                    ),
                ],
                default_index=1,  # Mid is the canonical recommendation
                input_fn=in_fn,
                output_fn=out_fn,
            )
            if sub_outcome.discuss:
                outcome.discussed_at_phase = 2
                outcome.exit_code = 0
                return outcome
            if sub_outcome.back:
                # Phase 2 is the first interactive prompt; Back here
                # re-renders Phase 1 (the detection readout), which
                # iterates the loop without changing flow.
                out_fn(
                    "  [back] Nothing earlier to return to; "
                    "re-rendering Phase 1."
                )
                phase = 1
                continue
            preset_key = str(sub_outcome.value)
            rules = SUBSCRIPTION_PRESETS[preset_key]
            try:
                _changed, _entry = write_triage_scope(
                    project_root,
                    rules,
                    preset_label=preset_key,
                )
            except (FileNotFoundError, ValueError) as exc:
                out_fn(f"  ! Failed to write plan.policy.triageScope: {exc}")
                outcome.exit_code = 2
                return outcome
            out_fn(f"  Wrote plan.policy.triageScope ({preset_key})")
            outcome.subscription_choice = preset_key
            _record_run(2)
            phase = 3
            continue

        if phase == 3:
            refreshed = detect_prior_state(project_root)
            if not refreshed.cache_empty:
                out_fn(
                    f"[3/6] Cache already populated "
                    f"({refreshed.cache_entry_count} entries); "
                    "skipping bootstrap."
                )
                _record_skipped(3)
            else:
                out_fn("[3/6] Running `task triage:bootstrap`...")
                if run_subprocess:
                    rc = _run_task(["triage:bootstrap"], cwd=project_root)
                    if rc != 0:
                        out_fn(
                            f"  ! `task triage:bootstrap` exited {rc}; "
                            "see stderr above. Setting outcome.exit_code=2 "
                            "so the dispatcher learns the ritual hit a "
                            "downstream failure (re-run welcome after "
                            "fixing bootstrap to resume)."
                        )
                        outcome.exit_code = 2
                else:
                    out_fn(
                        "  [dry-mode] bootstrap subprocess suppressed by caller."
                    )
                _record_run(3)
            phase = 4
            continue

        if phase == 4:
            state_p4 = detect_prior_state(project_root)
            if state_p4.wip_cap_set and not force_re_prompt_phase_4:
                out_fn(
                    f"[4/6] wipCap already set ({state_p4.wip_cap}); skipping."
                )
                _record_skipped(4)
                phase = 5
                continue
            force_re_prompt_phase_4 = False
            cap_outcome = prompt_menu(
                title="[4/6] Choose wipCap:",
                options=[
                    ("8 (small team)", "8"),
                    (
                        f"{DEFAULT_WIP_CAP} (default per umbrella Current Shape v3)",
                        str(DEFAULT_WIP_CAP),
                    ),
                    ("15 (large team)", "15"),
                    ("custom", "custom"),
                ],
                default_index=1,
                input_fn=in_fn,
                output_fn=out_fn,
            )
            if cap_outcome.discuss:
                outcome.discussed_at_phase = 4
                return outcome
            if cap_outcome.back:
                # Rewind to the prior interactive prompt (Phase 2). Force
                # re-prompt even if subscription scope is already set so
                # the operator can change their previous answer.
                out_fn("  [back] Rewinding to Phase 2.")
                force_re_prompt_phase_2 = True
                phase = 2
                continue
            if cap_outcome.value == "custom":
                custom = prompt_int(
                    title="    Enter custom wipCap",
                    default=DEFAULT_WIP_CAP,
                    input_fn=in_fn,
                    output_fn=out_fn,
                )
                if custom is None:
                    # prompt_int returns None on either Discuss or Back; both
                    # exit the ritual at this layer (the wipCap menu is
                    # already the rewind target so deeper rewind is a no-op).
                    outcome.discussed_at_phase = 4
                    return outcome
                cap_choice = custom
            else:
                cap_choice = int(str(cap_outcome.value))
            try:
                _changed, _entry = write_wip_cap(project_root, cap_choice)
            except (FileNotFoundError, ValueError) as exc:
                out_fn(f"  ! Failed to write plan.policy.wipCap: {exc}")
                outcome.exit_code = 2
                return outcome
            out_fn(f"  Wrote plan.policy.wipCap = {cap_choice}")
            outcome.wip_cap_choice = cap_choice
            _record_run(4)
            phase = 5
            continue

        if phase == 5:
            state_p5 = detect_prior_state(project_root)
            cap = state_p5.wip_cap
            if state_p5.wip_count <= cap:
                out_fn(
                    f"[5/6] WIP ({state_p5.wip_count}) within cap ({cap}); "
                    "no relief needed."
                )
                _record_skipped(5)
                phase = 6
                continue
            out_fn(
                f"[5/6] WIP ({state_p5.wip_count}) exceeds cap ({cap}); "
                "previewing relief."
            )
            preview = preview_wip_relief(project_root)
            outcome.relief_offered = True
            cmd_str = (
                f"task scope:demote -- --batch --older-than-days "
                f"{preview.older_than_days}"
            )
            out_fn("  Planned invocation (dry-run preview):")
            out_fn(f"    {cmd_str}")
            out_fn(
                f"  Eligible (>= {preview.older_than_days}d in pending/): "
                f"{preview.eligible_count} file(s); "
                f"not eligible: {preview.skipped_count}"
            )
            for name in preview.eligible_files[:10]:
                out_fn(f"    - {name}")
            if len(preview.eligible_files) > 10:
                out_fn(f"    ... and {len(preview.eligible_files) - 10} more")
            confirm = prompt_yes_no(
                title="  Apply this relief now?",
                default_yes=False,
                input_fn=in_fn,
                output_fn=out_fn,
            )
            if confirm and preview.eligible_count > 0:
                outcome.relief_confirmed = True
                if run_subprocess:
                    rc = _run_task(
                        [
                            "scope:demote",
                            "--",
                            "--batch",
                            "--older-than-days",
                            str(preview.older_than_days),
                        ],
                        cwd=project_root,
                    )
                    if rc != 0:
                        out_fn(
                            f"  ! `task scope:demote` exited {rc}. Setting "
                            "outcome.exit_code=2 so the dispatcher learns "
                            "the relief hop hit a downstream failure."
                        )
                        outcome.exit_code = 2
                else:
                    out_fn(
                        "  [dry-mode] scope:demote subprocess suppressed by caller."
                    )
            else:
                out_fn(
                    "  Relief declined; WIP cap remains over by "
                    f"{state_p5.wip_count - cap}."
                )
            _record_run(5)
            phase = 6
            continue

        if phase == 6:
            out_fn("[6/6] Final state:")
            if run_subprocess:
                _run_task(["triage:summary"], cwd=project_root)
            else:
                out_fn(
                    "  [dry-mode] triage:summary subprocess suppressed by caller."
                )
            out_fn(
                f"  Next: {TRIAGE_SKILL_PATH}  "
                "(read this skill to continue triage)"
            )
            _record_run(6)
            phase = 7  # exit loop
            continue

        # Defensive: unreachable under normal flow; guards against a future
        # edit that introduces an unhandled phase value.
        raise RuntimeError(f"run_welcome: unexpected phase value {phase!r}")

    return outcome


# ---------------------------------------------------------------------------
# CLI entry point (argparse shim lives in _triage_welcome_cli.py)
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Delegates to :mod:`_triage_welcome_cli`."""
    import sys as _sys

    from _triage_welcome_cli import run_cli  # local import: 1000-line cap

    return run_cli(argv, _sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
