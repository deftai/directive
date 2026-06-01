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

Refs:
- #1378 (this gate; Story C)
- #1371 (Story Start Gate consent-token carve-out this gate makes structural)
- #810 (precedent: ``scripts/preflight_implementation.py`` lifecycle gate)
- #747 (precedent shape: ``scripts/preflight_branch.py`` three-state exit)
- #1366 (subprocess capture forces ``encoding="utf-8", errors="replace"``)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

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


# ---------------------------------------------------------------------------
# git working-tree probe
# ---------------------------------------------------------------------------


def _git_porcelain(project_root: Path) -> str | None:
    """Return ``git status --porcelain`` output, or None when undeterminable.

    Returns None when git is not on PATH or the directory is not a git work
    tree (non-zero rc). The caller maps None to a config error (exit 2) --
    the gate fails closed rather than assuming a clean tree.

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
    except FileNotFoundError:
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
# core evaluator
# ---------------------------------------------------------------------------


def evaluate(
    vbrief_path: Path,
    *,
    git_status: str | None,
    allocation_context: str | None = None,
    allow_dirty: bool = False,
) -> tuple[int, str]:
    """Pure evaluator -- returns ``(exit_code, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    shelling out to git or round-tripping argparse. ``git_status`` is the
    raw ``git status --porcelain`` output (empty string == clean), or None
    when it could not be determined. ``allocation_context`` is the raw
    dispatch-envelope text (or None when no envelope was supplied).
    """
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

    # --- (b) target vBRIEF lifecycle --------------------------------------
    ok, reason = _check_vbrief(vbrief_path)
    if not ok:
        return 1, f"not ready: {reason}."

    # --- (c) dispatch-envelope allocation context -------------------------
    found, fields = parse_allocation_section(allocation_context)
    if not found:
        return 0, (
            "OK: ready to start -- tree clean, vBRIEF active+running, no "
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
        return 0, ("OK: ready to start -- tree clean, vBRIEF active+running, dispatch_kind: solo.")

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
    return 0, (
        "OK: ready to start -- tree clean, vBRIEF active+running, swarm-cohort "
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
    code, message = evaluate(
        vbrief_path,
        git_status=git_status,
        allocation_context=allocation_context,
        allow_dirty=args.allow_dirty,
    )

    # Surface the parsed dispatch_kind in the JSON payload for observability.
    _, fields = parse_allocation_section(allocation_context)
    dispatch_kind = fields.get("dispatch_kind")

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
