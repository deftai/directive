#!/usr/bin/env python3
"""preflight_implementation.py -- structural implementation-intent gate (#810).

Asserts a vBRIEF is eligible to be implemented before any code-writing
sub-agent spawns. The gate is two structural conditions:

1. The vBRIEF's containing folder is ``vbrief/active/``.
2. ``plan.status == "running"``.

Both conditions together encode the explicit lifecycle handoff that
``task vbrief:activate <path>`` performs (pending/ -> active/ AND
status flip pending/approved -> running). The gate fails closed: any
ambiguous, malformed, or pre-activation state exits non-zero with an
actionable redirect to ``task vbrief:activate``.

Mirrors ``scripts/preflight_branch.py`` (#747) in shape: pure stdlib,
``evaluate(path) -> (exit_code, message)`` separated from CLI plumbing
for testability, three-state exit codes, structured JSON variant.

Exit codes:

- ``0`` -- ready: folder is ``active/`` AND ``plan.status == "running"``.
- ``1`` -- not ready: pre-activation folder, wrong status, malformed
  JSON, missing keys, unreadable file, or any other reject path. The
  message always includes the actionable
  ``task vbrief:activate <path>`` redirect.

The gate intentionally collapses every reject path to exit 1 (rather
than splitting "config error" into exit 2 like ``preflight_branch.py``)
because the consumer surface -- a skill step that decides whether to
spawn a code-writing sub-agent -- only cares about ready / not-ready.
The actionable message disambiguates the underlying cause for the
operator.

Refs:
- #810 (this gate)
- #747 (precedent shape: ``scripts/preflight_branch.py``)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

#: Canonical eligibility folder. A vBRIEF MUST live here for an
#: implementation agent to spawn; lifecycle moves are gated by
#: ``task vbrief:activate`` (#810).
ACTIVE_FOLDER = "active"

#: Canonical eligibility status. ``running`` is the only ``plan.status``
#: enum value that signals an active implementation handoff.
ELIGIBLE_STATUS = "running"

#: The actionable redirect that EVERY reject path surfaces. Operators
#: copy-paste this verbatim. The placeholder ``<path>`` is substituted
#: with the input path so the redirect is one-shot runnable.
ACTIVATE_HINT = "Run `task vbrief:activate {path}` before spawning an implementation agent."


def _build_reject(path: Path, reason: str) -> str:
    """Compose a reject message with the canonical actionable redirect."""
    return f"{reason}\n  {ACTIVATE_HINT.format(path=path)}"


def evaluate(vbrief_path: Path) -> tuple[int, str]:
    """Pure evaluator -- returns ``(exit_code, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    capsys plumbing or argparse round-tripping. Never raises -- every
    error path is collapsed to exit 1 with an actionable message.
    """
    # --- Path resolution + readability ------------------------------------
    try:
        path = Path(vbrief_path)
    except TypeError as exc:  # extremely defensive
        return 1, _build_reject(
            Path(str(vbrief_path)),
            f"Could not interpret vBRIEF path '{vbrief_path}': {exc}.",
        )

    if not path.exists():
        return 1, _build_reject(
            path,
            f"vBRIEF not found at {path}.",
        )

    if not path.is_file():
        return 1, _build_reject(
            path,
            f"vBRIEF path {path} is not a regular file.",
        )

    # --- JSON load (swallow malformed / unreadable) ------------------------
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return 1, _build_reject(
            path,
            f"Could not read vBRIEF at {path}: {exc}.",
        )

    try:
        payload: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        return 1, _build_reject(
            path,
            f"vBRIEF at {path} is not valid JSON: {exc.msg} (line {exc.lineno}).",
        )

    if not isinstance(payload, dict):
        return 1, _build_reject(
            path,
            f"vBRIEF at {path} top-level value is not a JSON object.",
        )

    # --- Folder gate -------------------------------------------------------
    folder = path.parent.name
    if folder != ACTIVE_FOLDER:
        return 1, _build_reject(
            path,
            f"vBRIEF is in {folder}/ -- only vbrief/active/ is eligible "
            f"for implementation.",
        )

    # --- plan + plan.status structure -------------------------------------
    plan = payload.get("plan")
    if not isinstance(plan, dict):
        return 1, _build_reject(
            path,
            f"vBRIEF at {path} lacks a `plan` object -- malformed.",
        )

    status = plan.get("status")
    if not isinstance(status, str) or not status:
        return 1, _build_reject(
            path,
            f"vBRIEF at {path} lacks `plan.status` -- malformed.",
        )

    if status != ELIGIBLE_STATUS:
        return 1, _build_reject(
            path,
            f"plan.status is '{status}' -- only '{ELIGIBLE_STATUS}' is eligible "
            f"for implementation.",
        )

    return 0, f"OK {path} -- ready for implementation."


def _emit_json(path: Path, code: int, message: str) -> str:
    """Render the structured ``--json`` payload.

    Schema (pinned by tests):
    - ``ready`` (bool) -- True iff exit code is 0.
    - ``exit_code`` (int) -- 0 ready, 1 not ready.
    - ``vbrief_path`` (str) -- the input path as supplied.
    - ``message`` (str) -- the same human-readable message printed in
      non-JSON mode (multi-line, newlines preserved).
    """
    payload = {
        "ready": code == 0,
        "exit_code": code,
        "vbrief_path": str(path),
        "message": message,
    }
    return json.dumps(payload, sort_keys=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preflight_implementation.py",
        description=(
            "Structural implementation-intent gate (#810). Asserts a "
            "vBRIEF lives in vbrief/active/ AND plan.status == 'running' "
            "before an implementation agent can spawn. Mirrors the shape "
            "of scripts/preflight_branch.py (#747)."
        ),
    )
    parser.add_argument(
        "--vbrief-path",
        required=True,
        help="Path to the candidate vBRIEF JSON file.",
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
    parser = _build_parser()
    args = parser.parse_args(argv)
    path = Path(args.vbrief_path)
    code, message = evaluate(path)

    if args.emit_json:
        # JSON variant always lands on stdout -- consumers parse it.
        print(_emit_json(path, code, message))
    elif code == 0:
        print(message)
    else:
        # Reject paths land on stderr so calling skills can pipe stdout
        # cleanly when chaining; the actionable redirect is preserved.
        print(message, file=sys.stderr)

    return code


if __name__ == "__main__":
    sys.exit(main())
