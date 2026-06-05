#!/usr/bin/env python3
"""preflight_story_start.py -- deterministic story-start Gate 0 (#1378 Story C).

The pre-``start_agent`` gate stack (AGENTS.md ``## Session-start ritual``)
gains a deterministic Gate 0 that fires BEFORE the #810 implementation-intent
gate. Where ``preflight_implementation.py`` checks only the target vBRIEF's
lifecycle, this gate inspects the THREE story-start preconditions the prose
Story Start Gate documents:

(a) Working tree -- ``git status --porcelain`` is clean (or the operator
    passed ``--allow-dirty`` for the sanctioned "include existing work" /
    fresh-branch-start path).
(b) Target vBRIEF -- lives in ``vbrief/active/`` AND ``plan.status ==
    "running"`` (the same lifecycle handoff ``preflight_implementation.py``
    asserts).
(c) Dispatch envelope -- when a ``## Allocation context`` section is present
    (the #1378 Story A schema), the consent token is machine-checked: a
    ``swarm-cohort`` dispatch is only ready when ``allocation_plan_id`` AND
    ``batching_rationale`` are both non-null. When the section is ABSENT the
    dispatch is treated as solo-interactive and is ready subject to (a)/(b)
    -- this is the #1371 prose carve-out fallback made structural.

This turns the #1371 carve-out from prose-trusted into load-bearing: the
recognition contract ("a section reporting ``dispatch_kind: swarm-cohort``
with a NON-NULL ``allocation_plan_id`` AND ``batching_rationale`` satisfies
the Story Start Gate consent-token requirement") is now a gate exit code,
foreclosing the next #954-class silent failure.

Mirrors ``scripts/preflight_branch.py`` (#747) and
``scripts/preflight_implementation.py`` (#810) in shape: pure stdlib,
``evaluate(...) -> (exit_code, message)`` separated from CLI plumbing for
testability, a structured ``--json`` variant, and a UTF-8 self-reconfigure
at ``main`` entry so the success/forbidden glyphs survive a Windows
codepage-default stdout.

Exit codes (three-state, mirrors ``scripts/preflight_branch.py``):

- ``0`` -- ready: tree clean (or ``--allow-dirty``), vBRIEF active+running,
  and either no allocation-context section (solo) OR a satisfied consent
  token (``solo`` dispatch, or ``swarm-cohort`` with non-null
  ``allocation_plan_id`` + ``batching_rationale``).
- ``1`` -- not ready: dirty tree, target vBRIEF not active/running, or a
  ``swarm-cohort`` section whose ``allocation_plan_id`` / ``batching_rationale``
  is null or missing (the incomplete consent token).
- ``2`` -- config error: the ``## Allocation context`` section is present but
  malformed -- ``dispatch_kind`` missing / unrecognised, no parseable
  fields, an unreadable ``--allocation-context`` file, or the working-tree
  state could not be determined (git absent / not a repo).

Slice-7 gate-clearance integration (#1419): on a READY result this gate can
also evaluate the target story's ``plan.metadata.swarm.file_scope`` against the
risk-tiered judgment gates (imported from ``scripts/verify_judgment_gates.py``).
The DEFAULT posture is advisory -- an uncleared active block-tier gate is
SURFACED but the exit code is unchanged; the opt-in ``--enforce`` posture fails
closed (exit 1). Clearances ride the ``## Allocation context`` as an inline-JSON
``gate_clearances`` bullet; an ABSENT bullet in the advisory default is exactly
today's behavior (backward compatible). Allocation approvals can be appended to
the durable ``vbrief/.audit/`` log via ``--record-approval``.

Refs:
- #1378 (this gate; Story C)
- #1371 (Story Start Gate consent-token carve-out this gate makes structural)
- #1419 (Slice 7: gate-clearance enforcement + durable authority-event audit)
- #810 (precedent: ``scripts/preflight_implementation.py`` lifecycle gate)
- #747 (precedent shape: ``scripts/preflight_branch.py`` three-state exit)
- #1366 (subprocess capture forces ``encoding="utf-8", errors="replace"``)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Make sibling scripts importable both when run as __main__ and when the
# module is loaded directly by the test suite (mirrors swarm_launch.py).
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Judgment-gate engine (#1419 Slice 3, on master). The Slice 7 clearance
# integration evaluates the target story's ``plan.metadata.swarm.file_scope``
# against the configured + universal judgment gates via ``build_report`` /
# ``Candidate``. Guarded so Gate 0 still loads (today's behavior) when the
# engine is unavailable -- the gate-clearance layer is then simply skipped.
try:  # pragma: no cover - exercised on the real tree; guarded for resilience
    import verify_judgment_gates as _gates  # type: ignore  # noqa: E402
except Exception:  # noqa: BLE001 - any import failure disables the gate layer
    _gates = None  # type: ignore[assignment]

#: Canonical eligibility folder for an implementation story (mirrors
#: ``preflight_implementation.ACTIVE_FOLDER``).
ACTIVE_FOLDER = "active"

#: Canonical eligibility status -- ``running`` is the only ``plan.status``
#: value that signals an active implementation handoff.
ELIGIBLE_STATUS = "running"

#: The markdown heading that opens the dispatch envelope's allocation block.
#: Absence of this heading => solo path (the #1371 prose carve-out fallback).
ALLOCATION_HEADING = "## Allocation context"

#: Recognised ``dispatch_kind`` values (Story A FROZEN SCHEMA CONTRACT). Any
#: other value is a config error -- the gate cannot classify the dispatch.
SOLO_KIND = "solo"
SWARM_COHORT_KIND = "swarm-cohort"
VALID_DISPATCH_KINDS = frozenset({SOLO_KIND, SWARM_COHORT_KIND})

#: The five canonical allocation-context fields, in contract order. Used for
#: documentation / diagnostics; only ``dispatch_kind`` is structurally
#: required to classify, and (for swarm-cohort) ``allocation_plan_id`` +
#: ``batching_rationale`` are the consent token.
ALLOCATION_FIELDS = (
    "dispatch_kind",
    "allocation_plan_id",
    "batching_rationale",
    "cohort_vbriefs",
    "operator_approval_evidence",
)

#: Tokens that normalise to "null" (absent value) when parsing a field.
_NULL_TOKENS = frozenset({"", "null", "none", "n/a"})

#: The ``## Allocation context`` bullet that carries the inline-JSON
#: gate-clearance array (#1419 Slice 7). Each entry is an object with
#: ``gate_id`` / ``vbrief_path`` / ``cleared_by`` / ``rationale`` /
#: ``cleared_at`` / ``cleared_scope``. ABSENCE of this bullet == today's
#: behavior (no gate-clearance evaluation in the advisory default posture --
#: backward compatible with every pre-Slice-7 dispatch envelope).
GATE_CLEARANCES_FIELD = "gate_clearances"

#: Gate-clearance evaluation postures (mirrors the verify_judgment_gates
#: vocabulary). ``advise`` (DEFAULT) NEVER changes the readiness exit code --
#: an uncleared active block-tier gate is SURFACED but the gate still exits 0.
#: ``enforce`` fails closed (exit 1) when a mechanical block-tier gate fires
#: without a recorded clearance. The framework's own ``task verify:story-ready``
#: never passes ``--enforce`` so Gate 0 stays advisory on directive's own tree.
GATE_ADVISE = "advise"
GATE_ENFORCE = "enforce"

#: Durable, committed audit log (dir + file) for authority-bearing events --
#: allocation approvals + gate clearances per RFC #1419 Receipts & Audit
#: (record-of-record; append-only; must survive). Mirrors the
#: ``vbrief/.audit/`` location the Slice-3 clearance log already uses.
AUDIT_DIR_REL = "vbrief/.audit"
AUTHORITY_LOG_NAME = "authority-events.jsonl"


# ---------------------------------------------------------------------------
# git working-tree probe
# ---------------------------------------------------------------------------


def _git_porcelain(project_root: Path) -> str | None:
    """Return ``git status --porcelain`` output, or None when undeterminable.

    Returns None when git cannot be spawned (any ``OSError`` -- not on PATH,
    no execute permission, cwd not a directory) or the directory is not a git
    work tree (non-zero rc). The caller maps None to a config error (exit 2)
    -- the gate fails closed rather than assuming a clean tree.

    Per AGENTS.md ``## Safe subprocess capture (#1366)`` the capture forces
    ``encoding="utf-8", errors="replace"`` so a commit message / untracked
    filename carrying non-cp1252 bytes cannot crash the reader thread on a
    Windows host.
    """
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        # git not on PATH / no execute permission / cwd not a directory --
        # fail closed (caller maps None to config error exit 2).
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


# ---------------------------------------------------------------------------
# vBRIEF lifecycle check (condition b) -- mirrors preflight_implementation
# ---------------------------------------------------------------------------


def _check_vbrief(vbrief_path: Path) -> tuple[bool, str]:
    """Return ``(ok, reason)`` for the target story vBRIEF lifecycle gate.

    ``ok`` is True only when the file exists, is a readable JSON object,
    lives in ``vbrief/active/``, and carries ``plan.status == "running"``.
    Every failure returns ``(False, <human reason>)``; never raises.
    """
    try:
        path = Path(vbrief_path)
    except TypeError as exc:  # extremely defensive
        return False, f"could not interpret vBRIEF path '{vbrief_path}': {exc}"

    if not path.exists():
        return False, f"target vBRIEF not found at {path}"
    if not path.is_file():
        return False, f"target vBRIEF path {path} is not a regular file"

    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return False, f"could not read target vBRIEF at {path}: {exc}"

    try:
        payload: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        return False, (f"target vBRIEF at {path} is not valid JSON: {exc.msg} (line {exc.lineno})")

    if not isinstance(payload, dict):
        return False, f"target vBRIEF at {path} top-level value is not a JSON object"

    folder = path.parent.name
    if folder != ACTIVE_FOLDER:
        return False, (
            f"target vBRIEF is in {folder}/ -- only vbrief/active/ is eligible "
            f"for a story start (activate it via `task scope:activate -- {path}`)"
        )

    plan = payload.get("plan")
    if not isinstance(plan, dict):
        return False, f"target vBRIEF at {path} lacks a `plan` object -- malformed"

    status = plan.get("status")
    if not isinstance(status, str) or not status:
        return False, f"target vBRIEF at {path} lacks `plan.status` -- malformed"

    if status != ELIGIBLE_STATUS:
        return False, (
            f"target vBRIEF plan.status is '{status}' -- only '{ELIGIBLE_STATUS}' "
            f"is eligible for a story start"
        )

    return True, ""


# ---------------------------------------------------------------------------
# `## Allocation context` parser (condition c)
# ---------------------------------------------------------------------------


def _normalise_value(raw: str) -> str | None:
    """Strip a parsed field value; return None for null-equivalent tokens.

    Surrounding backticks / quotes are unwrapped so the contract's
    ``dispatch_kind: `swarm-cohort``` doc form and the plain
    ``dispatch_kind: swarm-cohort`` envelope form normalise identically.
    A value that is empty or one of the ``_NULL_TOKENS`` becomes None.
    """
    value = raw.strip()
    # Unwrap a single layer of surrounding backticks or quotes.
    for pair in ("``", "`", '"', "'"):
        if len(value) >= 2 * len(pair) and value.startswith(pair) and value.endswith(pair):
            value = value[len(pair) : len(value) - len(pair)].strip()
            break
    if value.lower() in _NULL_TOKENS:
        return None
    return value


def parse_allocation_section(
    text: str | None,
) -> tuple[bool, dict[str, str | None]]:
    """Parse the ``## Allocation context`` section from a dispatch envelope.

    Returns ``(found, fields)``:

    - ``found`` -- True iff a ``## Allocation context`` heading is present.
      When False the caller takes the solo path (the #1371 carve-out
      fallback for pre-#1378 / solo-interactive dispatches).
    - ``fields`` -- a dict mapping each ``- key: value`` bullet found under
      the heading (until the next ``#``-prefixed heading or EOF) to its
      normalised value (None when the value is null-equivalent). A key that
      did not appear at all is simply absent from the dict; the caller
      distinguishes "absent key" from "present-but-null" only where the
      contract requires it (both collapse to None via ``dict.get``).

    Pure -- no I/O. Never raises.
    """
    if text is None:
        return False, {}
    lines = text.splitlines()
    heading_idx = None
    for idx, line in enumerate(lines):
        if line.strip() == ALLOCATION_HEADING:
            heading_idx = idx
            break
    if heading_idx is None:
        return False, {}

    fields: dict[str, str | None] = {}
    for line in lines[heading_idx + 1 :]:
        stripped = line.strip()
        if stripped.startswith("#"):
            # Next markdown heading ends the section.
            break
        if not stripped.startswith(("- ", "* ")):
            continue
        body = stripped[2:]
        if ":" not in body:
            continue
        key, _, value = body.partition(":")
        key = key.strip().strip("`").strip()
        if key:
            fields[key] = _normalise_value(value)
    return True, fields


# ---------------------------------------------------------------------------
# gate-clearance integration (#1419 Slice 7)
# ---------------------------------------------------------------------------


def parse_gate_clearances(
    fields: dict[str, str | None],
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Parse the inline-JSON ``gate_clearances`` bullet from a parsed section.

    The dispatch envelope carries gate clearances as a single
    ``- gate_clearances: [ {...}, {...} ]`` bullet whose value is a JSON array
    (this keeps the existing flat ``- key: value`` parser unchanged -- the
    value-after-first-colon survives the JSON object colons). Returns
    ``(clearances, warning)``:

    - ``clearances`` is None when the bullet is ABSENT -- the
      backward-compatible "no gate-clearance section" path (today's behavior in
      the advisory default posture). It is a list of clearance objects when the
      bullet holds a JSON array, or ``[]`` when the bullet is present-but-null
      / malformed / not a list (FAIL-SAFE: a malformed clearance array clears
      nothing, so an enforced block gate still fires -- omitting clearances can
      never silently bypass enforcement).
    - ``warning`` is a human-readable note when the bullet was present but could
      not be parsed, else None.

    Pure -- no I/O. Never raises.
    """
    if GATE_CLEARANCES_FIELD not in fields:
        return None, None
    raw = fields.get(GATE_CLEARANCES_FIELD)
    if raw is None:
        # Present-but-null -> an explicit empty clearance set.
        return [], None
    try:
        loaded = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        return [], f"gate_clearances bullet is not valid JSON ({exc}); treated as empty."
    if not isinstance(loaded, list):
        return [], "gate_clearances bullet is not a JSON array; treated as empty."
    return [entry for entry in loaded if isinstance(entry, dict)], None


def _read_file_scope(vbrief_path: Path) -> tuple[str, ...]:
    """Return ``plan.metadata.swarm.file_scope`` from the target vBRIEF.

    Best-effort + non-raising: any read / parse / shape error yields an empty
    tuple, which makes the gate layer a no-op for that story (no file_scope ->
    no candidate paths -> no path-glob gate can match). The lifecycle gate
    (:func:`_check_vbrief`) already validated readability; this re-read keeps
    the helper self-contained and side-effect-free.
    """
    try:
        payload = json.loads(Path(vbrief_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
        return ()
    if not isinstance(payload, dict):
        return ()
    plan = payload.get("plan")
    if not isinstance(plan, dict):
        return ()
    metadata = plan.get("metadata")
    if not isinstance(metadata, dict):
        return ()
    swarm = metadata.get("swarm")
    if not isinstance(swarm, dict):
        return ()
    scope = swarm.get("file_scope")
    if not isinstance(scope, list):
        return ()
    return tuple(p for p in scope if isinstance(p, str) and p)


def evaluate_gate_clearances(
    project_root: Path,
    vbrief_path: Path,
    *,
    posture: str,
    clearances: list[dict[str, Any]] | None,
    now: datetime | None = None,
) -> Any | None:
    """Evaluate the target story's file_scope against the judgment gates.

    Imports the Slice-3 engine (``verify_judgment_gates.build_report`` /
    ``Candidate``) -- this module never re-implements the gate logic. Returns
    the ``JudgmentGateReport`` (so the caller can inspect ``blocking`` /
    ``block_tier_requirements``), or None when the engine is unavailable or the
    story declares no file_scope (nothing to evaluate).

    The clearances supplied from the ``## Allocation context`` are merged with
    any already recorded in the durable clearance audit log, so a story cleared
    out-of-band (``verify_judgment_gates.py clear``) is honored too.
    """
    if _gates is None:
        return None
    file_scope = _read_file_scope(vbrief_path)
    if not file_scope:
        return None
    records = list(clearances or [])
    records.extend(_gates.read_clearances(project_root))
    return _gates.build_report(
        project_root,
        _gates.Candidate(paths=file_scope),
        posture=posture,
        clearances=records,
        now=now,
    )


def _gate_surface_note(report: Any) -> str:
    """Render a one-line-per-gate surface of the matched block-tier gates."""
    lines: list[str] = []
    for outcome in report.block_tier_requirements:
        if outcome.cleared:
            status = "cleared"
        elif getattr(outcome, "stale_clearance", None) is not None:
            status = "STALE-CLEARANCE re-triggered"
        else:
            status = "uncleared"
        lines.append(f"    - [{outcome.tier}] {outcome.gate_id}: {status}")
    if not lines:
        return "judgment gates: no block-tier gate matched the story file_scope."
    return "judgment gates (block-tier):\n" + "\n".join(lines)


def _apply_gate_layer(
    message: str,
    vbrief_path: Path,
    *,
    project_root: Path | None,
    gate_posture: str,
    gate_clearances: list[dict[str, Any]] | None,
    now: datetime | None,
) -> tuple[int, str]:
    """Layer the judgment-gate clearance check onto a READY (exit-0) result.

    Runs ONLY when a project root is available AND either the posture is
    ``enforce`` (always check -- omitting clearances cannot bypass it) OR a
    ``gate_clearances`` bullet was present (advisory surfacing). When it does
    not run, the original ready ``(0, message)`` is returned unchanged --
    this is the backward-compatible "absent gate_clearances section == today's
    behavior" path. In ``advise`` posture the exit code is NEVER changed; in
    ``enforce`` posture an uncleared mechanical block-tier gate flips the
    result to exit 1 (fail closed).
    """
    should_run = project_root is not None and (
        gate_posture == GATE_ENFORCE or gate_clearances is not None
    )
    if not should_run:
        return 0, message
    report = evaluate_gate_clearances(
        project_root,  # type: ignore[arg-type]
        vbrief_path,
        posture=gate_posture,
        clearances=gate_clearances,
        now=now,
    )
    if report is None:
        return 0, message
    note = _gate_surface_note(report)
    if gate_posture == GATE_ENFORCE and report.blocking:
        ids = ", ".join(o.gate_id for o in report.blocking)
        return 1, (
            message + "\n" + note + "\nBLOCKED: uncleared active block-tier "
            f"gate(s): {ids}. Record a clearance in the `## Allocation context` "
            "gate_clearances[] (or via `verify_judgment_gates.py clear`) before "
            "dispatch (enforce posture)."
        )
    return 0, (message + "\n" + note)


def _utc_now_iso(now: datetime | None = None) -> str:
    """Return an ISO-8601 ``...Z`` timestamp (mirrors the clearance-log format)."""
    return (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")


def authority_log_path(
    project_root: Path, *, log_name: str = AUTHORITY_LOG_NAME
) -> Path:
    """Resolve the durable authority-events audit log under *project_root*."""
    return project_root / AUDIT_DIR_REL / log_name


def append_authority_event(
    project_root: Path,
    *,
    event_type: str,
    payload: dict[str, Any],
    now: datetime | None = None,
    log_name: str = AUTHORITY_LOG_NAME,
) -> dict[str, Any]:
    """Append an authority-bearing event to the durable audit log; return it.

    Per RFC #1419 (Receipts & Audit), allocation approvals and gate clearances
    are authority-bearing events appended to the durable, committed
    ``vbrief/.audit/*.jsonl`` log (record-of-record; append-only; must
    survive). The record carries a stable ``event_id``, an ISO-8601
    ``timestamp``, the ``event_type``, and the caller-supplied ``payload``
    fields. Shared with :mod:`swarm_launch` so both surfaces write the same
    shape.
    """
    path = authority_log_path(project_root, log_name=log_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Build with the payload first, then stamp the three canonical fields LAST
    # so a payload key can never silently overwrite event_id / timestamp /
    # event_type (the protected record-of-record identity).
    entry: dict[str, Any] = dict(payload)
    entry.update(
        {
            "event_id": str(uuid.uuid4()),
            "timestamp": _utc_now_iso(now),
            "event_type": event_type,
        }
    )
    line = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    return entry


# ---------------------------------------------------------------------------
# core evaluator
# ---------------------------------------------------------------------------


def evaluate(
    vbrief_path: Path,
    *,
    git_status: str | None,
    allocation_context: str | None = None,
    allow_dirty: bool = False,
    parsed: tuple[bool, dict[str, str | None]] | None = None,
    project_root: Path | None = None,
    gate_posture: str = GATE_ADVISE,
    gate_clearances: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> tuple[int, str]:
    """Pure evaluator -- returns ``(exit_code, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    shelling out to git or round-tripping argparse. ``git_status`` is the
    raw ``git status --porcelain`` output (empty string == clean), or None
    when it could not be determined. ``allocation_context`` is the raw
    dispatch-envelope text (or None when no envelope was supplied).

    ``parsed`` is an optional pre-parsed :func:`parse_allocation_section`
    result; when provided it is used as-is so callers that already parsed the
    envelope (e.g. :func:`main` building the ``--json`` payload) do not parse
    it a second time. When None the section is parsed here.

    The Slice-7 gate-clearance layer (#1419) is OPT-IN and backward
    compatible: it runs only on a READY (exit-0) result, only when
    ``project_root`` is supplied, and only when the posture is ``enforce`` OR a
    ``gate_clearances`` list was provided (a present ``gate_clearances`` bullet).
    When ``project_root`` is None (the historical pure-call shape used by the
    bulk of the unit tests) the gate layer is skipped entirely -- today's
    behavior. In ``advise`` posture the exit code is never changed; ``enforce``
    fails closed (exit 1) on an uncleared mechanical block-tier gate.
    """

    def _ready(msg: str) -> tuple[int, str]:
        return _apply_gate_layer(
            msg,
            vbrief_path,
            project_root=project_root,
            gate_posture=gate_posture,
            gate_clearances=gate_clearances,
            now=now,
        )

    # --- (a) working tree --------------------------------------------------
    if git_status is None:
        return 2, (
            "config error: could not determine working-tree state -- is this a "
            "git work tree and is git on PATH? (Gate 0 fails closed.)"
        )
    dirty = bool(git_status.strip())
    if dirty and not allow_dirty:
        return 1, (
            "not ready: working tree is dirty. Commit, stash, or include the "
            "existing work (re-run with --allow-dirty after operator approval) "
            "before starting the story."
        )
    # Accurate tree-state phrase for the OK messages: a dirty-but-allowed tree
    # must not be reported as "tree clean".
    tree_note = "dirty tree allowed (--allow-dirty)" if dirty else "tree clean"

    # --- (b) target vBRIEF lifecycle --------------------------------------
    ok, reason = _check_vbrief(vbrief_path)
    if not ok:
        return 1, f"not ready: {reason}."

    # --- (c) dispatch-envelope allocation context -------------------------
    found, fields = parsed if parsed is not None else parse_allocation_section(allocation_context)
    if not found:
        return _ready(
            f"OK: ready to start -- {tree_note}, vBRIEF active+running, no "
            "`## Allocation context` section (solo path, #1371 carve-out)."
        )

    dispatch_kind = fields.get("dispatch_kind")
    if "dispatch_kind" not in fields or dispatch_kind is None:
        return 2, (
            "config error: `## Allocation context` section is present but has no "
            "`dispatch_kind` field -- cannot classify the dispatch (Story A schema "
            "requires dispatch_kind: solo | swarm-cohort)."
        )
    if dispatch_kind not in VALID_DISPATCH_KINDS:
        return 2, (
            f"config error: unrecognised dispatch_kind '{dispatch_kind}' -- "
            f"expected one of {sorted(VALID_DISPATCH_KINDS)}."
        )

    if dispatch_kind == SOLO_KIND:
        return _ready(
            f"OK: ready to start -- {tree_note}, vBRIEF active+running, dispatch_kind: solo."
        )

    # swarm-cohort -- the consent token must be complete (#1371 carve-out).
    incomplete = [
        name for name in ("allocation_plan_id", "batching_rationale") if fields.get(name) is None
    ]
    if incomplete:
        return 1, (
            "not ready: swarm-cohort dispatch has an incomplete consent token -- "
            f"null or missing {', '.join(incomplete)}. A swarm-cohort start gate "
            "requires a non-null allocation_plan_id AND batching_rationale "
            "(#1371 carve-out)."
        )
    return _ready(
        f"OK: ready to start -- {tree_note}, vBRIEF active+running, swarm-cohort "
        "consent token satisfied (allocation_plan_id + batching_rationale present)."
    )


# ---------------------------------------------------------------------------
# CLI plumbing
# ---------------------------------------------------------------------------


def _emit_json(
    vbrief_path: Path,
    code: int,
    message: str,
    *,
    dispatch_kind: str | None,
) -> str:
    """Render the structured ``--json`` payload (schema pinned by tests)."""
    payload = {
        "ready": code == 0,
        "exit_code": code,
        "vbrief_path": str(vbrief_path),
        "dispatch_kind": dispatch_kind,
        "message": message,
    }
    return json.dumps(payload, sort_keys=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preflight_story_start.py",
        description=(
            "Deterministic story-start Gate 0 (#1378 Story C). Inspects the "
            "working tree, the target vBRIEF lifecycle, and the dispatch "
            "envelope's `## Allocation context` consent token before an "
            "implementation story starts. Three-state exit (0 ready / 1 not "
            "ready / 2 config error). Mirrors scripts/preflight_branch.py "
            "(#747) and scripts/preflight_implementation.py (#810)."
        ),
    )
    parser.add_argument(
        "--vbrief-path",
        required=True,
        help="Path to the target story vBRIEF JSON file (must be in vbrief/active/).",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root for the git working-tree probe (default: cwd).",
    )
    parser.add_argument(
        "--allocation-context",
        default=None,
        help=(
            "Path to a file containing the dispatch envelope (or just its "
            "`## Allocation context` section). When omitted, or when the file "
            "contains no such section, the dispatch is treated as solo."
        ),
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help=(
            "Permit a dirty working tree (the sanctioned 'include existing "
            "work' / fresh-branch-start path; requires operator approval)."
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="emit_json",
        help=(
            "Emit a structured JSON payload to stdout instead of the "
            "human-readable message. Exit code is unchanged."
        ),
    )
    parser.add_argument(
        "--enforce",
        action="store_true",
        help=(
            "Gate-clearance ENFORCE posture (#1419 Slice 7): fail closed (exit 1) "
            "when the target story's file_scope trips a mechanical block-tier "
            "judgment gate that has no recorded clearance. DEFAULT is advisory -- "
            "an uncleared block gate is surfaced but the exit code is unchanged. "
            "The framework's own `task verify:story-ready` never passes this."
        ),
    )
    parser.add_argument(
        "--record-approval",
        action="store_true",
        help=(
            "On a READY (exit-0) result, append a `story:dispatch-approved` "
            "authority-bearing event to the durable audit log "
            "(vbrief/.audit/authority-events.jsonl). Off by default so a routine "
            "story-ready probe stays side-effect-free."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # Force UTF-8 stdout/stderr at entry. A git hook / Taskfile dispatch on
    # Windows defaults these streams to cp1252 / cp437, neither of which can
    # render the messages' punctuation; the reconfigure mirrors
    # scripts/preflight_branch.py (#814). Guarded by hasattr because
    # reconfigure only exists on TextIOWrapper streams.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    vbrief_path = Path(args.vbrief_path)
    project_root = Path(args.project_root).resolve()

    # Read the dispatch envelope when supplied. A supplied-but-unreadable
    # path is a config error -- the operator asked us to inspect a file we
    # cannot open.
    allocation_context: str | None = None
    if args.allocation_context is not None:
        envelope_path = Path(args.allocation_context)
        try:
            allocation_context = envelope_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            message = (
                f"config error: could not read --allocation-context file {envelope_path}: {exc}."
            )
            if args.emit_json:
                print(_emit_json(vbrief_path, 2, message, dispatch_kind=None))
            else:
                print(message, file=sys.stderr)
            return 2

    git_status = _git_porcelain(project_root)
    # Parse the allocation section ONCE and thread it into evaluate() so the
    # envelope is not parsed twice (evaluate + the --json observability line).
    parsed = parse_allocation_section(allocation_context)
    # Slice-7 gate clearances ride the allocation context as an inline-JSON
    # bullet; absent bullet => None => the gate layer stays dormant in the
    # advisory default (today's behavior).
    gate_clearances, gc_warning = parse_gate_clearances(parsed[1])
    gate_posture = GATE_ENFORCE if args.enforce else GATE_ADVISE
    code, message = evaluate(
        vbrief_path,
        git_status=git_status,
        allocation_context=allocation_context,
        allow_dirty=args.allow_dirty,
        parsed=parsed,
        project_root=project_root,
        gate_posture=gate_posture,
        gate_clearances=gate_clearances,
    )
    if gc_warning:
        message = f"{message}\n  ! {gc_warning}"
    dispatch_kind = parsed[1].get("dispatch_kind")

    # Authority-bearing audit (opt-in): record the dispatch approval only when
    # the story is READY and --record-approval was passed. Best-effort -- an
    # audit write failure warns but never flips a ready story to not-ready.
    if args.record_approval and code == 0:
        try:
            append_authority_event(
                project_root,
                event_type="story:dispatch-approved",
                payload={
                    "vbrief_path": str(vbrief_path),
                    "dispatch_kind": dispatch_kind,
                    "allocation_plan_id": parsed[1].get("allocation_plan_id"),
                    "gate_clearances": gate_clearances or [],
                },
            )
        except OSError as exc:
            print(f"warning: could not append authority event: {exc}", file=sys.stderr)

    if args.emit_json:
        print(_emit_json(vbrief_path, code, message, dispatch_kind=dispatch_kind))
    elif code == 0:
        print(message)
    else:
        # Reject / config-error paths land on stderr so a calling skill can
        # pipe stdout cleanly when chaining gates.
        print(message, file=sys.stderr)

    return code


if __name__ == "__main__":
    sys.exit(main())
